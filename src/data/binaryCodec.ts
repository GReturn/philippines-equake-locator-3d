import { SPECTRAL_DEPTH_RGB, latToMercY, lngToMercX, metersToMercator } from '../constants/map';

const EPOCH_MS = Date.UTC(2018, 0, 1, 0, 0, 0);
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const decoder = new TextDecoder('utf-8');

function unzigzag(n: number): number {
  return (n >>> 1) ^ -(n & 1);
}

export function formatMinutesToDateTime(tMin: number): { datetime: string; timestampMs: number } {
  const utc = new Date(EPOCH_MS + tMin * 60000);
  const yr = utc.getUTCFullYear();
  const mon = utc.getUTCMonth();
  const day = utc.getUTCDate();
  const hr24 = utc.getUTCHours();
  const min = utc.getUTCMinutes();

  const ampm = hr24 >= 12 ? 'PM' : 'AM';
  let hr12 = hr24 % 12;
  if (hr12 === 0) hr12 = 12;

  const dd = day < 10 ? '0' + day : '' + day;
  const hh = hr12 < 10 ? '0' + hr12 : '' + hr12;
  const mm = min < 10 ? '0' + min : '' + min;
  const datetime = `${dd} ${MONTH_NAMES[mon]} ${yr} - ${hh}:${mm} ${ampm}`;
  const timestampMs = new Date(yr, mon, day, hr24, min).getTime();
  return { datetime, timestampMs };
}

export function formatQuakeId(datetime: string, lat: number, lon: number, mag: number): string {
  return `${datetime}-${lat.toFixed(4)}-${lon.toFixed(4)}-${mag.toFixed(1)}`;
}

export interface CompactLocationBlock {
  places: string[];
  raw: string[];
  placeIdHi: Uint8Array;
  placeIdLo: Uint8Array;
  distHi: Uint8Array;
  distLo: Uint8Array;
  angleHi: Uint8Array;
  angleLo: Uint8Array;
  flags: Uint8Array;
}

export function decodeLocationAt(block: CompactLocationBlock, idx: number): string {
  const pid = (block.placeIdHi[idx] << 8) | block.placeIdLo[idx];
  if (pid === 0) {
    const rawIdx = block.distLo[idx] | (block.distHi[idx] << 8) | (block.angleLo[idx] << 16);
    return block.raw[rawIdx] ?? '';
  }
  const dist = (block.distHi[idx] << 8) | block.distLo[idx];
  const ang = (block.angleHi[idx] << 8) | block.angleLo[idx];
  const fl = block.flags[idx];
  const ns = fl & 1 ? 'S' : 'N';
  const ew = fl & 2 ? 'W' : 'E';
  const dTxt = fl & 8 ? String(dist).padStart(3, '0') : String(dist);
  const aTxt = fl & 16 ? String(ang).padStart(2, '0') : String(ang);
  const spTxt = fl & 32 ? (fl & 4 ? '   km ' : '  km ') : (fl & 4 ? '  km ' : ' km ');
  return `${dTxt}${spTxt}${ns} ${aTxt}° ${ew} of ${block.places[pid - 1]}`;
}

function parseLocationBlock(bytes: Uint8Array, offset: number, count: number): { block: CompactLocationBlock; nextOffset: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  const placesCount = dv.getUint32(0, true);
  const placesBytesLen = dv.getUint32(4, true);
  const rawCount = dv.getUint32(8, true);
  const rawBytesLen = dv.getUint32(12, true);
  let pos = offset + 16;

  const places = placesCount > 0
    ? decoder.decode(bytes.subarray(pos, pos + placesBytesLen)).split('\0')
    : [];
  pos += placesBytesLen;

  const raw = rawCount > 0
    ? decoder.decode(bytes.subarray(pos, pos + rawBytesLen)).split('\0')
    : [];
  pos += rawBytesLen;

  const placeIdHi = bytes.subarray(pos, pos + count); pos += count;
  const placeIdLo = bytes.subarray(pos, pos + count); pos += count;
  const distHi = bytes.subarray(pos, pos + count); pos += count;
  const distLo = bytes.subarray(pos, pos + count); pos += count;
  const angleHi = bytes.subarray(pos, pos + count); pos += count;
  const angleLo = bytes.subarray(pos, pos + count); pos += count;
  const flags = bytes.subarray(pos, pos + count); pos += count;

  return {
    block: { places, raw, placeIdHi, placeIdLo, distHi, distLo, angleHi, angleLo, flags },
    nextOffset: pos,
  };
}

export const CORE_CHUNK_SHIFT = 7;  // 128 points/chunk
export const MINOR_CHUNK_SHIFT = 8; // 256 points/chunk

function parseGeoColumns(bytes: Uint8Array, offset: number, count: number, chunkShift: number) {
  let pos = offset;
  const magQ = bytes.subarray(pos, pos + count); pos += count;
  const dLonHi = bytes.subarray(pos, pos + count); pos += count;
  const dLonLo = bytes.subarray(pos, pos + count); pos += count;
  const dLatHi = bytes.subarray(pos, pos + count); pos += count;
  const dLatLo = bytes.subarray(pos, pos + count); pos += count;
  const depHi = bytes.subarray(pos, pos + count); pos += count;
  const depLo = bytes.subarray(pos, pos + count); pos += count;
  const snapBytes = (count + 7) >> 3;
  const snapBits = bytes.subarray(pos, pos + snapBytes); pos += snapBytes;

  const gpuBuf = new Float32Array(count * 5);
  const gpuU8 = new Uint8Array(gpuBuf.buffer);
  const lonArr = new Float32Array(count);
  const latArr = new Float32Array(count);
  const depthArr = new Float32Array(count);
  const magArr = new Uint8Array(count);
  magArr.set(magQ);

  const chunkSize = 1 << chunkShift;
  const numChunks = Math.ceil(count / chunkSize);
  // 5 floats per chunk: [minMx, maxMx, minMy, maxMy, minMz] (maxMz is always <= 0)
  const chunkBounds = new Float32Array(numChunks * 5);
  for (let c = 0; c < numChunks; c++) {
    const cb = c * 5;
    chunkBounds[cb] = 2;
    chunkBounds[cb + 1] = -1;
    chunkBounds[cb + 2] = 2;
    chunkBounds[cb + 3] = -1;
    chunkBounds[cb + 4] = 0;
  }

  const radBase = new Float32Array(128);
  for (let m = 0; m < 128; m++) radBase[m] = Math.pow(2, m * 0.1) * 100;

  let pLon = 0, pLat = 0, pM = -1;
  for (let i = 0; i < count; i++) {
    const m = magQ[i];
    const rawDLon = (dLonHi[i] << 8) | dLonLo[i];
    const rawDLat = (dLatHi[i] << 8) | dLatLo[i];
    const lonQ = m === pM ? pLon + unzigzag(rawDLon) : rawDLon;
    const latQ = m === pM ? pLat + unzigzag(rawDLat) : rawDLat;
    pLon = lonQ;
    pLat = latQ;
    pM = m;

    const lon = 100 + lonQ * 0.01;
    const lat = -10 + latQ * 0.01;
    const dep = (depHi[i] << 8) | depLo[i];

    lonArr[i] = lon;
    latArr[i] = lat;
    depthArr[i] = dep;

    const mx = lngToMercX(lon);
    const my = latToMercY(lat);
    const m2m = metersToMercator(lat);
    const mz = -dep * 1000 * m2m;
    const radiusMerc = radBase[m] * m2m;

    const o = i * 5;
    gpuBuf[o] = mx;
    gpuBuf[o + 1] = my;
    gpuBuf[o + 2] = mz;
    gpuBuf[o + 3] = radiusMerc;
    const lutOff = (dep > 500 ? 500 : dep) * 3;
    const u8o = o * 4 + 16;
    gpuU8[u8o] = SPECTRAL_DEPTH_RGB[lutOff];
    gpuU8[u8o + 1] = SPECTRAL_DEPTH_RGB[lutOff + 1];
    gpuU8[u8o + 2] = SPECTRAL_DEPTH_RGB[lutOff + 2];
    gpuU8[u8o + 3] = 255;

    const cb = (i >>> chunkShift) * 5;
    if (mx < chunkBounds[cb]) chunkBounds[cb] = mx;
    if (mx > chunkBounds[cb + 1]) chunkBounds[cb + 1] = mx;
    if (my < chunkBounds[cb + 2]) chunkBounds[cb + 2] = my;
    if (my > chunkBounds[cb + 3]) chunkBounds[cb + 3] = my;
    if (mz < chunkBounds[cb + 4]) chunkBounds[cb + 4] = mz;
  }

  return { magQ: magArr, lonArr, latArr, depthArr, gpuBuf, snapBits, chunkBounds, chunkShift, nextOffset: pos };
}

function parseTimes24(bytes: Uint8Array, offset: number, count: number): { times: Uint32Array; nextOffset: number } {
  let pos = offset;
  const t2 = bytes.subarray(pos, pos + count); pos += count;
  const t1 = bytes.subarray(pos, pos + count); pos += count;
  const t0 = bytes.subarray(pos, pos + count); pos += count;
  const times = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    times[i] = ((t2[i] << 16) | (t1[i] << 8) | t0[i]) >>> 0;
  }
  return { times, nextOffset: pos };
}

export interface DecodedCoreQuakes {
  totalCount: number;
  coreCount: number;
  minorCount: number;
  minMag10: number;
  maxMag10: number;
  snapshotYear: number;
  latestYearLastModMs: number;
  recentIndices: Uint16Array;
  majorIndices: Uint16Array;
  featuredMap: Map<number, number>;
  featuredTimes: Uint32Array;
  featuredLocations: CompactLocationBlock;
  magQ: Uint8Array;
  lonArr: Float32Array;
  latArr: Float32Array;
  depthArr: Float32Array;
  gpuBuf: Float32Array;
  snapBits: Uint8Array;
  chunkBounds: Float32Array;
  chunkShift: number;
}

export function decodeCoreEqb(buf: ArrayBuffer): DecodedCoreQuakes {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (bytes[0] !== 0x45 || bytes[1] !== 0x51 || bytes[2] !== 0x43 || bytes[3] !== 0x32) {
    throw new Error('Invalid EQC2 header');
  }
  const totalCount = dv.getUint32(4, true);
  const coreCount = dv.getUint32(8, true);
  const minorCount = dv.getUint32(12, true);
  const minMag10 = dv.getUint8(16);
  const maxMag10 = dv.getUint8(17);
  const snapshotYear = dv.getUint16(18, true);
  const latestYearLastModMs = dv.getFloat64(20, true);
  const recentCount = dv.getUint16(28, true);
  const majorCount = dv.getUint16(30, true);
  const featuredCount = dv.getUint16(32, true);

  let pos = 36;
  const recentIndices = new Uint16Array(recentCount);
  for (let i = 0; i < recentCount; i++) { recentIndices[i] = dv.getUint16(pos, true); pos += 2; }
  const majorIndices = new Uint16Array(majorCount);
  for (let i = 0; i < majorCount; i++) { majorIndices[i] = dv.getUint16(pos, true); pos += 2; }
  const featuredMap = new Map<number, number>();
  for (let i = 0; i < featuredCount; i++) { featuredMap.set(dv.getUint16(pos, true), i); pos += 2; }

  const geo = parseGeoColumns(bytes, pos, coreCount, CORE_CHUNK_SHIFT);
  pos = geo.nextOffset;
  const ft = parseTimes24(bytes, pos, featuredCount);
  pos = ft.nextOffset;
  const fl = parseLocationBlock(bytes, pos, featuredCount);

  return {
    totalCount,
    coreCount,
    minorCount,
    minMag10,
    maxMag10,
    snapshotYear,
    latestYearLastModMs,
    recentIndices,
    majorIndices,
    featuredMap,
    featuredTimes: ft.times,
    featuredLocations: fl.block,
    magQ: geo.magQ,
    lonArr: geo.lonArr,
    latArr: geo.latArr,
    depthArr: geo.depthArr,
    gpuBuf: geo.gpuBuf,
    snapBits: geo.snapBits,
    chunkBounds: geo.chunkBounds,
    chunkShift: geo.chunkShift,
  };
}

export interface DecodedMinorGeo {
  count: number;
  snapshotYear: number;
  magQ: Uint8Array;
  lonArr: Float32Array;
  latArr: Float32Array;
  depthArr: Float32Array;
  gpuBuf: Float32Array;
  snapBits: Uint8Array;
  chunkBounds: Float32Array;
  chunkShift: number;
}

export function decodeMinorGeoEqb(buf: ArrayBuffer): DecodedMinorGeo {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (bytes[0] !== 0x45 || bytes[1] !== 0x51 || bytes[2] !== 0x4d || bytes[3] !== 0x31) {
    throw new Error('Invalid EQM1 header');
  }
  const count = dv.getUint32(4, true);
  const snapshotYear = dv.getUint16(8, true);
  const geo = parseGeoColumns(bytes, 16, count, MINOR_CHUNK_SHIFT);
  return {
    count,
    snapshotYear,
    magQ: geo.magQ,
    lonArr: geo.lonArr,
    latArr: geo.latArr,
    depthArr: geo.depthArr,
    gpuBuf: geo.gpuBuf,
    snapBits: geo.snapBits,
    chunkBounds: geo.chunkBounds,
    chunkShift: geo.chunkShift,
  };
}

export interface DecodedLocTable {
  count: number;
  times: Uint32Array;
  locations: CompactLocationBlock;
}

export function decodeLocEqb(buf: ArrayBuffer): DecodedLocTable {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (bytes[0] !== 0x45 || bytes[1] !== 0x51 || bytes[2] !== 0x4c || bytes[3] !== 0x32) {
    throw new Error('Invalid EQL2 header');
  }
  const count = dv.getUint32(4, true);
  const t = parseTimes24(bytes, 8, count);
  const loc = parseLocationBlock(bytes, t.nextOffset, count);
  return { count, times: t.times, locations: loc.block };
}

import earcut from 'earcut';

// --- Basemap BM4 Decoder (ring-encoded polygons + 1-bit coastline flags -> triangulated via earcut) ---
export interface DecodedBasemap {
  waterVerts: Float32Array;
  waterIndices: Uint32Array;
  coastIndices: Uint32Array;
  countryVerts: Float32Array;
  provVerts: Float32Array;
}

function decodeVarints(bytes: Uint8Array, start: number, len: number, outCount: number): Uint32Array {
  const out = new Uint32Array(outCount);
  let pos = start;
  const end = start + len;
  let idx = 0;
  while (pos < end && idx < outCount) {
    let v = 0;
    let shift = 0;
    while (pos < end) {
      const b = bytes[pos++];
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    out[idx++] = v >>> 0;
  }
  return out;
}

function decodeDeltaXYBlock(bytes: Uint8Array, offset: number, vertCount: number, invScale: number) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const bxLen = dv.getUint32(0, true);
  const byLen = dv.getUint32(4, true);
  let pos = offset + 8;
  const dx = decodeVarints(bytes, pos, bxLen, vertCount); pos += bxLen;
  const dy = decodeVarints(bytes, pos, byLen, vertCount); pos += byLen;

  const xy = new Float32Array(vertCount * 2);
  let px = 0, py = 0;
  for (let i = 0; i < vertCount; i++) {
    px += unzigzag(dx[i]);
    py += unzigzag(dy[i]);
    xy[i * 2] = px * invScale;
    xy[i * 2 + 1] = py * invScale;
  }
  return { xy, nextOffset: pos };
}

function decodePolylinesBlock(bytes: Uint8Array, offset: number, invScale: number, withDist: boolean) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 12);
  const lineCount = dv.getUint32(0, true);
  const vertCount = dv.getUint32(4, true);
  const bLenBytes = dv.getUint32(8, true);
  let pos = offset + 12;
  const lengths = decodeVarints(bytes, pos, bLenBytes, lineCount);
  pos += bLenBytes;
  const { xy, nextOffset } = decodeDeltaXYBlock(bytes, pos, vertCount, invScale);

  let totalSegs = 0;
  for (let i = 0; i < lineCount; i++) {
    if (lengths[i] >= 2) totalSegs += lengths[i] - 1;
  }

  const stride = withDist ? 3 : 2;
  const out = new Float32Array(totalSegs * 2 * stride);
  let vi = 0;
  let oi = 0;
  for (let i = 0; i < lineCount; i++) {
    const len = lengths[i];
    let dist = 0;
    for (let k = 0; k < len - 1; k++) {
      const ax = xy[(vi + k) * 2];
      const ay = xy[(vi + k) * 2 + 1];
      const bx = xy[(vi + k + 1) * 2];
      const by = xy[(vi + k + 1) * 2 + 1];
      if (withDist) {
        const segLen = Math.hypot(bx - ax, by - ay);
        out[oi++] = ax; out[oi++] = ay; out[oi++] = dist;
        dist += segLen;
        out[oi++] = bx; out[oi++] = by; out[oi++] = dist;
      } else {
        out[oi++] = ax; out[oi++] = ay;
        out[oi++] = bx; out[oi++] = by;
      }
    }
    vi += len;
  }
  return { verts: out, nextOffset };
}

export function decodeBasemap(buf: ArrayBuffer): DecodedBasemap {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d || bytes[2] !== 0x34) {
    throw new Error('Invalid BM4 basemap header');
  }
  const qScale = dv.getUint32(4, true);
  const waterVertCount = dv.getUint32(8, true);
  const polyCount = dv.getUint32(12, true);
  const ringCount = dv.getUint32(16, true);
  const bPolyLen = dv.getUint32(20, true);
  const bRingLen = dv.getUint32(24, true);
  const invScale = 1 / qScale;

  let pos = 28;
  const polyRingCounts = decodeVarints(bytes, pos, bPolyLen, polyCount); pos += bPolyLen;
  const ringVertCounts = decodeVarints(bytes, pos, bRingLen, ringCount); pos += bRingLen;
  const coastByteLen = (waterVertCount + 7) >> 3;
  const coastFlags = bytes.subarray(pos, pos + coastByteLen); pos += coastByteLen;

  const wXY = decodeDeltaXYBlock(bytes, pos, waterVertCount, invScale);
  pos = wXY.nextOffset;
  const country = decodePolylinesBlock(bytes, pos, invScale, false);
  pos = country.nextOffset;
  const prov = decodePolylinesBlock(bytes, pos, invScale, true);

  // Pre-allocate exact/upper-bound TypedArrays to avoid dynamic array resizing & GC pressure
  // Max triangles for V vertices across P polygons with H holes is <= V + 2*H (<= 2*V safe bound)
  const triBuf = new Uint32Array(waterVertCount * 6);
  const coastBuf = new Uint32Array(waterVertCount * 2);
  let triLen = 0;
  let coastLen = 0;
  let vCursor = 0;
  let rCursor = 0;
  const holes: number[] = [];

  for (let p = 0; p < polyCount; p++) {
    const rCnt = polyRingCounts[p];
    const startV = vCursor;
    holes.length = 0;
    for (let r = 0; r < rCnt; r++) {
      const rLen = ringVertCounts[rCursor++];
      if (r > 0) holes.push(vCursor - startV);
      for (let k = 0; k < rLen; k++) {
        const vi = vCursor + k;
        if ((coastFlags[vi >> 3] >> (vi & 7)) & 1) {
          coastBuf[coastLen++] = vi;
          coastBuf[coastLen++] = vCursor + ((k + 1) % rLen);
        }
      }
      vCursor += rLen;
    }
    const sub = wXY.xy.subarray(startV * 2, vCursor * 2);
    const tris = earcut(sub, holes.length ? holes : undefined, 2);
    for (let t = 0; t < tris.length; t++) {
      triBuf[triLen++] = startV + tris[t];
    }
  }

  return {
    waterVerts: wXY.xy,
    waterIndices: triBuf.subarray(0, triLen),
    coastIndices: coastBuf.subarray(0, coastLen),
    countryVerts: country.verts,
    provVerts: prov.verts,
  };
}
