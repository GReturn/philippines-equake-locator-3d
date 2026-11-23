import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const BASE_URL = 'https://greturn.github.io/phivolcs-earthquake-data-scraper/data';
const OUT_DIR = path.resolve('public/data');
const CORE_MIN_MAG_10 = 43; // 4.3
const EPOCH_MS = Date.UTC(2018, 0, 1, 0, 0, 0);

const MONTHS = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

const LOC_RE = /^(\d{1,4})(  ?)km ([NS]) (\d{1,3})° ([EW]) of (.+)$/;
const LOC_RE_SP = /^(\d{1,4})(  ?) km ([NS]) (\d{1,3})° ([EW]) of (.+)$/;

function parseDateMin(s) {
  const m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+-\s+(\d{2}):(\d{2})\s+(AM|PM)$/i.exec(s);
  if (!m) return 0;
  const day = +m[1];
  const mon = MONTHS[m[2]];
  const yr = +m[3];
  let hr = +m[4];
  const min = +m[5];
  const ap = m[6].toUpperCase();
  if (ap === 'PM' && hr !== 12) hr += 12;
  if (ap === 'AM' && hr === 12) hr = 0;
  return Math.round((Date.UTC(yr, mon, day, hr, min) - EPOCH_MS) / 60000);
}

function morton12(x, y) {
  let m = 0;
  for (let i = 0; i < 12; i++) {
    m |= ((x >> i) & 1) << (2 * i);
    m |= ((y >> i) & 1) << (2 * i + 1);
  }
  return m;
}

function zigzag(n) {
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function parseCsvLine(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function encodeLocations(rows) {
  const placeMap = new Map();
  const places = [];
  const rawList = [];
  const n = rows.length;

  const placeIdLo = new Uint8Array(n);
  const placeIdHi = new Uint8Array(n);
  const distLo = new Uint8Array(n);
  const distHi = new Uint8Array(n);
  const angleLo = new Uint8Array(n);
  const angleHi = new Uint8Array(n);
  const flags = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const loc = rows[i].location;
    const m = LOC_RE_SP.exec(loc) || LOC_RE.exec(loc);
    if (m) {
      const distStr = m[1];
      const sp = m[2];
      const ns = m[3];
      const angStr = m[4];
      const ew = m[5];
      const place = m[6];

      let pid = placeMap.get(place);
      if (pid === undefined) {
        pid = places.length + 1;
        places.push(place);
        placeMap.set(place, pid);
      }
      const dist = parseInt(distStr, 10);
      const ang = parseInt(angStr, 10);
      let fl = 0;
      if (ns === 'S') fl |= 1;
      if (ew === 'W') fl |= 2;
      if (sp === '  ') fl |= 4;
      if (distStr.length === 3) fl |= 8;
      if (angStr.length === 2) fl |= 16;
      if (LOC_RE_SP.test(loc)) fl |= 32;

      const dTxt = (fl & 8) ? String(dist).padStart(3, '0') : String(dist);
      const aTxt = (fl & 16) ? String(ang).padStart(2, '0') : String(ang);
      const spTxt = (fl & 32) ? ((fl & 4) ? '   km ' : '  km ') : ((fl & 4) ? '  km ' : ' km ');
      const recon = `${dTxt}${spTxt}${ns} ${aTxt}° ${ew} of ${place}`;
      if (recon === loc && pid <= 65535 && dist <= 65535 && ang <= 65535) {
        placeIdLo[i] = pid & 255;
        placeIdHi[i] = pid >> 8;
        distLo[i] = dist & 255;
        distHi[i] = dist >> 8;
        angleLo[i] = ang & 255;
        angleHi[i] = ang >> 8;
        flags[i] = fl;
        continue;
      }
    }
    const rawIdx = rawList.length;
    rawList.push(loc);
    placeIdLo[i] = 0;
    placeIdHi[i] = 0;
    distLo[i] = rawIdx & 255;
    distHi[i] = (rawIdx >> 8) & 255;
    angleLo[i] = (rawIdx >> 16) & 255;
    angleHi[i] = 0;
    flags[i] = 0;
  }

  const placesBuf = Buffer.from(places.join('\0'), 'utf8');
  const rawBuf = Buffer.from(rawList.join('\0'), 'utf8');

  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(places.length, 0);
  hdr.writeUInt32LE(placesBuf.length, 4);
  hdr.writeUInt32LE(rawList.length, 8);
  hdr.writeUInt32LE(rawBuf.length, 12);

  return Buffer.concat([
    hdr,
    placesBuf,
    rawBuf,
    placeIdHi, placeIdLo,
    distHi, distLo,
    angleHi, angleLo,
    flags,
  ]);
}

// 3-byte (Uint24) minutes since 2018-01-01 (covers 31.8 years -> 2049)
function encodeTimes24(arr) {
  const n = arr.length;
  const t2 = new Uint8Array(n), t1 = new Uint8Array(n), t0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = arr[i].tMin >>> 0;
    t2[i] = (t >>> 16) & 255;
    t1[i] = (t >>> 8) & 255;
    t0[i] = t & 255;
  }
  return Buffer.concat([t2, t1, t0]);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  return { text };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const localCache = process.env.LOCAL_CSV_PATH;
  let csvText;
  let latestYearLastModMs = 0;

  if (localCache && fs.existsSync(localCache)) {
    console.log('Reading CSV from local cache:', localCache);
    csvText = fs.readFileSync(localCache, 'utf8');
  } else {
    console.log('Fetching phivolcs_earthquake_all_years.csv...');
    const res = await fetchText(`${BASE_URL}/phivolcs_earthquake_all_years.csv`);
    csvText = res.text;
  }

  const lines = csvText.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const rows = [];
  let minMag10 = 255;
  let maxMag10 = 0;
  let maxYear = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const parts = parseCsvLine(line);
    if (parts.length < 9) continue;
    const lat = parseFloat(parts[2]);
    const lon = parseFloat(parts[3]);
    const dep = parseFloat(parts[4]);
    const mag = parseFloat(parts[5]);
    if (Number.isNaN(lat) || Number.isNaN(lon) || Number.isNaN(mag)) continue;

    const latQ = Math.round((lat + 10) * 100);
    const lonQ = Math.round((lon - 100) * 100);
    const depQ = Math.round(Number.isNaN(dep) ? 0 : dep);
    const magQ = Math.round(mag * 10);
    const tMin = parseDateMin(parts[1]);
    const year = parseInt(parts[8], 10) || 2018;

    if (magQ < minMag10) minMag10 = magQ;
    if (magQ > maxMag10) maxMag10 = magQ;
    if (year > maxYear) maxYear = year;

    rows.push({
      lat, lon, dep, mag,
      latQ, lonQ, depQ, magQ, tMin,
      location: parts[6],
      year,
      origIdx: i - 1,
    });
  }

  try {
    const headRes = await fetch(`${BASE_URL}/phivolcs_earthquake_${maxYear}.csv`, { method: 'HEAD' });
    const lm = headRes.headers.get('last-modified');
    if (lm) {
      latestYearLastModMs = Date.parse(lm);
      console.log(`Live ${maxYear} CSV Last-Modified: ${lm} (${latestYearLastModMs})`);
    }
  } catch (e) {
    console.warn('Could not fetch HEAD Last-Modified:', e.message);
  }

  const byDate = rows.map((_, i) => i).sort((a, b) => rows[b].tMin - rows[a].tMin);
  const recentSet = new Set(byDate.slice(0, 100));
  const byMag = rows.map((_, i) => i).sort((a, b) => (rows[b].magQ - rows[a].magQ) || (rows[a].origIdx - rows[b].origIdx));
  const majorOrigSet = byMag.slice(0, 30);

  const core = [];
  const minor = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].magQ >= CORE_MIN_MAG_10 || recentSet.has(i)) core.push(rows[i]);
    else minor.push(rows[i]);
  }

  for (const r of core) r.z = morton12(r.lonQ, r.latQ);
  core.sort((a, b) => (b.magQ - a.magQ) || (a.z - b.z));

  for (const r of minor) r.z = morton12(r.lonQ, r.latQ);
  minor.sort((a, b) => (b.magQ - a.magQ) || (a.z - b.z));

  const origToCore = new Map();
  for (let i = 0; i < core.length; i++) origToCore.set(core[i].origIdx, i);

  const recentIndices = new Uint16Array(100);
  for (let i = 0; i < 100; i++) recentIndices[i] = origToCore.get(byDate[i]);

  const majorIndices = new Uint16Array(30);
  for (let i = 0; i < 30; i++) majorIndices[i] = origToCore.get(majorOrigSet[i]);

  // Featured records (Recent 100 + Major 30 deduplicated) get inline metadata right inside quakes-core.eqb!
  const featuredSet = new Set([...recentIndices, ...majorIndices]);
  const featuredCoreIdx = Uint16Array.from([...featuredSet].sort((a, b) => a - b));
  const featuredRows = Array.from(featuredCoreIdx, (idx) => core[idx]);

  function encodeGeoColumns(arr) {
    const n = arr.length;
    const mag = new Uint8Array(n);
    const dLonHi = new Uint8Array(n), dLonLo = new Uint8Array(n);
    const dLatHi = new Uint8Array(n), dLatLo = new Uint8Array(n);
    const depHi = new Uint8Array(n), depLo = new Uint8Array(n);
    const snapBits = new Uint8Array(Math.ceil(n / 8));

    let pLon = 0, pLat = 0, pM = -1;
    for (let i = 0; i < n; i++) {
      const r = arr[i];
      mag[i] = r.magQ;
      const dl = r.magQ === pM ? zigzag(r.lonQ - pLon) : r.lonQ;
      const da = r.magQ === pM ? zigzag(r.latQ - pLat) : r.latQ;
      pLon = r.lonQ;
      pLat = r.latQ;
      pM = r.magQ;
      dLonHi[i] = (dl >> 8) & 255; dLonLo[i] = dl & 255;
      dLatHi[i] = (da >> 8) & 255; dLatLo[i] = da & 255;
      depHi[i] = (r.depQ >> 8) & 255; depLo[i] = r.depQ & 255;
      if (r.year === maxYear) snapBits[i >> 3] |= 1 << (i & 7);
    }
    return Buffer.concat([mag, dLonHi, dLonLo, dLatHi, dLatLo, depHi, depLo, snapBits]);
  }

  // --- 1. quakes-core.eqb (EQC2) ---
  // Contains ALL 3,042 core geo columns + inline time/location ONLY for featured (Recent 100 + Major 30)!
  // Header (36 bytes):
  //   0..3:   "EQC2"
  //   4..7:   totalCount (u32)
  //   8..11:  coreCount (u32)
  //   12..15: minorCount (u32)
  //   16:     minMag10 (u8)
  //   17:     maxMag10 (u8)
  //   18..19: snapshotYear (u16)
  //   20..27: latestYearLastModMs (f64)
  //   28..29: recentCount (u16)
  //   30..31: majorCount (u16)
  //   32..33: featuredCount (u16)
  //   34..35: reserved
  const coreHdr = Buffer.alloc(36);
  coreHdr.write('EQC2', 0, 'ascii');
  coreHdr.writeUInt32LE(rows.length, 4);
  coreHdr.writeUInt32LE(core.length, 8);
  coreHdr.writeUInt32LE(minor.length, 12);
  coreHdr.writeUInt8(minMag10, 16);
  coreHdr.writeUInt8(maxMag10, 17);
  coreHdr.writeUInt16LE(maxYear, 18);
  coreHdr.writeDoubleLE(latestYearLastModMs, 20);
  coreHdr.writeUInt16LE(recentIndices.length, 28);
  coreHdr.writeUInt16LE(majorIndices.length, 30);
  coreHdr.writeUInt16LE(featuredCoreIdx.length, 32);

  const coreBuf = Buffer.concat([
    coreHdr,
    Buffer.from(recentIndices.buffer),
    Buffer.from(majorIndices.buffer),
    Buffer.from(featuredCoreIdx.buffer),
    encodeGeoColumns(core),
    encodeTimes24(featuredRows),
    encodeLocations(featuredRows),
  ]);

  // --- 2. quakes-core-loc.eqb (EQL2) --- (loaded lazily on first click of a non-featured core dot!)
  const coreLocHdr = Buffer.alloc(8);
  coreLocHdr.write('EQL2', 0, 'ascii');
  coreLocHdr.writeUInt32LE(core.length, 4);
  const coreLocBuf = Buffer.concat([coreLocHdr, encodeTimes24(core), encodeLocations(core)]);

  // --- 3. quakes-minor-geo.eqb (EQM1) ---
  const minorGeoHdr = Buffer.alloc(16);
  minorGeoHdr.write('EQM1', 0, 'ascii');
  minorGeoHdr.writeUInt32LE(minor.length, 4);
  minorGeoHdr.writeUInt16LE(maxYear, 8);
  minorGeoHdr.writeUInt8(1, 10);
  const minorGeoBuf = Buffer.concat([minorGeoHdr, encodeGeoColumns(minor)]);

  // --- 4. quakes-minor-loc.eqb (EQL2) ---
  const minorLocHdr = Buffer.alloc(8);
  minorLocHdr.write('EQL2', 0, 'ascii');
  minorLocHdr.writeUInt32LE(minor.length, 4);
  const minorLocBuf = Buffer.concat([minorLocHdr, encodeTimes24(minor), encodeLocations(minor)]);

  for (const [name, buf] of [
    ['quakes-core.eqb', coreBuf],
    ['quakes-core-loc.eqb', coreLocBuf],
    ['quakes-minor-geo.eqb', minorGeoBuf],
    ['quakes-minor-loc.eqb', minorLocBuf],
  ]) {
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    const gz = zlib.gzipSync(buf, { level: 6 });
    console.log(`${name.padEnd(24)} raw=${(buf.length / 1024).toFixed(1).padStart(7)} KB  gz=${(gz.length / 1024).toFixed(1).padStart(6)} KB`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
