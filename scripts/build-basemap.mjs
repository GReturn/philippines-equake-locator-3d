import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import earcut from 'earcut';

const OUT_PATH = path.resolve('public/data/basemap.bin');
const TILE_HOSTS = ['a', 'b', 'c', 'd'];
let tileBaseUrl = null;

async function getTileUrlTemplate() {
  if (tileBaseUrl) return tileBaseUrl;
  const res = await fetch('https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json');
  const json = await res.json();
  tileBaseUrl = json.tiles[0];
  return tileBaseUrl;
}

async function fetchTile(z, x, y, idx = 0) {
  const tpl = await getTileUrlTemplate();
  const host = TILE_HOSTS[idx % TILE_HOSTS.length];
  const url = tpl
    .replace('tiles-a.', `tiles-${host}.`)
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 204 || res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      return new VectorTile(new Pbf(buf));
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  return null;
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j].x - ring[i].x) * (ring[j].y + ring[i].y);
  }
  return area;
}

function simplifyRing(pts, eps, closed = false, extent = 4096) {
  if (pts.length <= (closed ? 4 : 2) || eps <= 0) return pts;
  const epsSq = eps * eps;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    if (p.x <= 2 || p.x >= extent - 2 || p.y <= 2 || p.y >= extent - 2) {
      keep[i] = 1;
    }
  }

  function dp(s, e) {
    if (e - s <= 1) return;
    const ax = pts[s].x, ay = pts[s].y;
    const bx = pts[e].x, by = pts[e].y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const px = pts[i].x, py = pts[i].y;
      let dSq;
      if (lenSq === 0) {
        dSq = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        const projX = ax + t * dx;
        const projY = ay + t * dy;
        dSq = (px - projX) ** 2 + (py - projY) ** 2;
      }
      if (dSq > maxD) {
        maxD = dSq;
        idx = i;
      }
    }
    if (maxD > epsSq && idx !== -1) {
      keep[idx] = 1;
      dp(s, idx);
      dp(idx, e);
    }
  }

  let segStart = 0;
  for (let i = 1; i < pts.length; i++) {
    if (keep[i]) {
      dp(segStart, i);
      segStart = i;
    }
  }

  const out = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  return out;
}

function clipPolygonRing(ring, extent) {
  function clipEdge(pts, inside, intersect) {
    if (!pts.length) return [];
    const out = [];
    let prev = pts[pts.length - 1];
    let prevIn = inside(prev);
    for (const curr of pts) {
      const currIn = inside(curr);
      if (currIn) {
        if (!prevIn) out.push(intersect(prev, curr));
        out.push(curr);
      } else if (prevIn) {
        out.push(intersect(prev, curr));
      }
      prev = curr;
      prevIn = currIn;
    }
    return out;
  }
  let pts = ring;
  if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) {
    pts = pts.slice(0, -1);
  }
  pts = clipEdge(pts, (p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + (b.y - a.y) * (0 - a.x) / (b.x - a.x) }));
  pts = clipEdge(pts, (p) => p.x <= extent, (a, b) => ({ x: extent, y: a.y + (b.y - a.y) * (extent - a.x) / (b.x - a.x) }));
  pts = clipEdge(pts, (p) => p.y >= 0, (a, b) => ({ x: a.x + (b.x - a.x) * (0 - a.y) / (b.y - a.y), y: 0 }));
  pts = clipEdge(pts, (p) => p.y <= extent, (a, b) => ({ x: a.x + (b.x - a.x) * (extent - a.y) / (b.y - a.y), y: extent }));
  return pts;
}

function clipSegment(ax, ay, bx, by, extent) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const tests = [
    [-dx, ax],
    [dx, extent - ax],
    [-dy, ay],
    [dy, extent - ay],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

function isTileBorderSeg(ax, ay, bx, by, extent) {
  const m = 2;
  if (ax <= m && bx <= m) return true;
  if (ax >= extent - m && bx >= extent - m) return true;
  if (ay <= m && by <= m) return true;
  if (ay >= extent - m && by >= extent - m) return true;
  return false;
}

const Q_SCALE = 131071;
function toQ(tx, ty, z, px, py, extent) {
  const n = 1 << z;
  const wx = Math.max(0, Math.min(1, (tx + px / extent) / n));
  const wy = Math.max(0, Math.min(1, (ty + py / extent) / n));
  return [Math.round(wx * Q_SCALE), Math.round(wy * Q_SCALE)];
}

function buildTileList() {
  const tiles = [];

  function inPH(z, x, y) {
    const s = 1 << (7 - z);
    const x0 = x * s, x1 = (x + 1) * s - 1;
    const y0 = y * s, y1 = (y + 1) * s - 1;
    return !(x1 < 105 || x0 > 109 || y1 < 56 || y0 > 61);
  }

  function inAsia(z, x, y) {
    const s = 1 << (5 - z);
    const x0 = x * s, x1 = (x + 1) * s - 1;
    const y0 = y * s, y1 = (y + 1) * s - 1;
    return !(x1 < 25 || x0 > 28 || y1 < 13 || y0 > 16);
  }

  function subdivide(z, x, y) {
    if (z < 2) {
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 2; dy++)
          subdivide(z + 1, x * 2 + dx, y * 2 + dy);
      return;
    }
    if (z < 5 && inAsia(z, x, y)) {
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 2; dy++)
          subdivide(z + 1, x * 2 + dx, y * 2 + dy);
      return;
    }
    if (z >= 5 && z < 7 && inPH(z, x, y)) {
      for (let dx = 0; dx < 2; dx++)
        for (let dy = 0; dy < 2; dy++)
          subdivide(z + 1, x * 2 + dx, y * 2 + dy);
      return;
    }
    let eps = 48;
    if (z === 2) eps = 135;
    else if (z === 3) eps = 95;
    else if (z === 4) eps = 55;
    else if (z === 5) eps = 30;
    else if (z === 6) eps = 32;
    else if (z === 7) eps = 36;
    tiles.push({ z, x, y, eps });
  }

  subdivide(0, 0, 0);
  return tiles;
}

function zigzag(n) {
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

function encodeVarints(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    let v = arr[i] >>> 0;
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    out.push(v);
  }
  return Buffer.from(out);
}

function encodeDeltaXYVarint(xyArr) {
  const n = xyArr.length / 2;
  const dxArr = new Uint32Array(n);
  const dyArr = new Uint32Array(n);
  let px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const x = xyArr[i * 2];
    const y = xyArr[i * 2 + 1];
    dxArr[i] = zigzag(x - px);
    dyArr[i] = zigzag(y - py);
    px = x;
    py = y;
  }
  const bx = encodeVarints(dxArr);
  const by = encodeVarints(dyArr);
  const lenHdr = Buffer.alloc(8);
  lenHdr.writeUInt32LE(bx.length, 0);
  lenHdr.writeUInt32LE(by.length, 4);
  return Buffer.concat([lenHdr, bx, by]);
}

function encodePolylines(lines) {
  const lengths = new Uint32Array(lines.length);
  const flatXY = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    lengths[i] = l.length / 2;
    for (let k = 0; k < l.length; k++) flatXY.push(l[k]);
  }
  const bLen = encodeVarints(lengths);
  const bXY = encodeDeltaXYVarint(flatXY);
  const hdr = Buffer.alloc(12);
  hdr.writeUInt32LE(lines.length, 0);
  hdr.writeUInt32LE(flatXY.length / 2, 4);
  hdr.writeUInt32LE(bLen.length, 8);
  return Buffer.concat([hdr, bLen, bXY]);
}

async function main() {
  const tiles = buildTileList();
  const byZ = {};
  for (const t of tiles) byZ[t.z] = (byZ[t.z] || 0) + 1;
  console.log(`Fetching ${tiles.length} non-overlapping quadtree tiles:`, byZ);

  // BM4: Store water polygon rings + 1-bit coastline edge flags (ZERO triangle indices on wire -> triangulated in ~2ms by earcut!)
  const waterVerts = [];      // [x0, y0, ...]
  const polyRingCounts = [];  // # of rings per polygon (1 outer + H holes)
  const ringVertCounts = [];  // # of vertices per ring
  const coastFlagBits = [];   // 1 bit per water vertex: 1 if edge (v_k -> v_{k+1} in ring) is a visible coastline

  const countryLines = [];
  const provLines = [];

  const fetched = new Array(tiles.length);
  for (let i = 0; i < tiles.length; i += 12) {
    const batch = tiles.slice(i, i + 12);
    const results = await Promise.all(batch.map((t, j) => fetchTile(t.z, t.x, t.y, i + j)));
    for (let j = 0; j < results.length; j++) fetched[i + j] = results[j];
  }

  for (let idx = 0; idx < tiles.length; idx++) {
    const { z, x, y, eps } = tiles[idx];
    const vt = fetched[idx];
    if (!vt) continue;

    const waterLayer = vt.layers.water;
    if (waterLayer) {
      const extent = waterLayer.extent || 4096;
      for (let fIdx = 0; fIdx < waterLayer.length; fIdx++) {
        const feat = waterLayer.feature(fIdx);
        const cls = feat.properties.class;
        if (cls !== 'ocean' && cls !== 'lake') continue;
        if (cls === 'lake' && z < 7) continue;

        const geom = feat.loadGeometry();
        const polygons = [];
        let currentPoly = null;
        for (const rawRing of geom) {
          const area = ringArea(rawRing);
          if (Math.abs(area) < (z >= 7 ? 380 : 1200)) continue;
          if (area > 0) {
            currentPoly = [rawRing];
            polygons.push(currentPoly);
          } else if (currentPoly) {
            currentPoly.push(rawRing);
          }
        }

        for (const poly of polygons) {
          const validRings = [];
          let validOuter = true;

          for (let rIdx = 0; rIdx < poly.length; rIdx++) {
            const clipped = clipPolygonRing(poly[rIdx], extent);
            if (clipped.length < 3) {
              if (rIdx === 0) validOuter = false;
              continue;
            }
            const simp = simplifyRing([...clipped, clipped[0]], eps, true, extent);
            const pts = simp.length > 1 && simp[0].x === simp[simp.length - 1].x && simp[0].y === simp[simp.length - 1].y
              ? simp.slice(0, -1)
              : simp;
            if (pts.length < 3) {
              if (rIdx === 0) validOuter = false;
              continue;
            }
            validRings.push(pts);
          }

          if (!validOuter || validRings.length === 0) continue;
          polyRingCounts.push(validRings.length);

          for (const pts of validRings) {
            ringVertCounts.push(pts.length);
            for (let k = 0; k < pts.length; k++) {
              const [qx, qy] = toQ(x, y, z, pts[k].x, pts[k].y, extent);
              waterVerts.push(qx, qy);
              const nxt = pts[(k + 1) % pts.length];
              coastFlagBits.push(isTileBorderSeg(pts[k].x, pts[k].y, nxt.x, nxt.y, extent) ? 0 : 1);
            }
          }
        }
      }
    }

    const boundaryLayer = vt.layers.boundary;
    if (boundaryLayer) {
      const extent = boundaryLayer.extent || 4096;
      for (let fIdx = 0; fIdx < boundaryLayer.length; fIdx++) {
        const feat = boundaryLayer.feature(fIdx);
        const props = feat.properties;
        if (props.maritime === 1) continue;
        const level = props.admin_level;
        if (level !== 2 && level !== 4) continue;
        if (level === 4 && z < 5) continue;
        const target = level === 2 ? countryLines : provLines;
        const lineEps = level === 4 ? (z >= 7 ? eps * 1.1 : eps * 2.2) : eps * 1.2;

        const geom = feat.loadGeometry();
        for (const line of geom) {
          const simp = simplifyRing(line, lineEps, false, extent);
          let cur = [];
          for (let k = 0; k < simp.length - 1; k++) {
            const clipped = clipSegment(simp[k].x, simp[k].y, simp[k + 1].x, simp[k + 1].y, extent);
            if (!clipped) {
              if (cur.length >= 4) target.push(cur);
              cur = [];
              continue;
            }
            const [qx0, qy0] = toQ(x, y, z, clipped[0], clipped[1], extent);
            const [qx1, qy1] = toQ(x, y, z, clipped[2], clipped[3], extent);
            if (qx0 === qx1 && qy0 === qy1) continue;
            if (cur.length === 0) {
              cur.push(qx0, qy0, qx1, qy1);
            } else if (cur[cur.length - 2] === qx0 && cur[cur.length - 1] === qy0) {
              cur.push(qx1, qy1);
            } else {
              if (cur.length >= 4) target.push(cur);
              cur = [qx0, qy0, qx1, qy1];
            }
          }
          if (cur.length >= 4) target.push(cur);
        }
      }
    }
  }

  // Pack coastFlagBits into byte array
  const coastBytes = new Uint8Array(Math.ceil(coastFlagBits.length / 8));
  for (let i = 0; i < coastFlagBits.length; i++) {
    if (coastFlagBits[i]) coastBytes[i >> 3] |= 1 << (i & 7);
  }

  const bPolyCounts = encodeVarints(Uint32Array.from(polyRingCounts));
  const bRingCounts = encodeVarints(Uint32Array.from(ringVertCounts));
  const bWaterXY = encodeDeltaXYVarint(waterVerts);
  const bCountry = encodePolylines(countryLines);
  const bProv = encodePolylines(provLines);

  // Header (28 bytes):
  //   0..3:   "BM4\0"
  //   4..7:   qScale
  //   8..11:  waterVertCount
  //   12..15: polyCount
  //   16..19: ringCount
  //   20..23: bPolyCounts.length
  //   24..27: bRingCounts.length
  const hdr = Buffer.alloc(28);
  hdr.write('BM4\0', 0, 'ascii');
  hdr.writeUInt32LE(Q_SCALE, 4);
  hdr.writeUInt32LE(waterVerts.length / 2, 8);
  hdr.writeUInt32LE(polyRingCounts.length, 12);
  hdr.writeUInt32LE(ringVertCounts.length, 16);
  hdr.writeUInt32LE(bPolyCounts.length, 20);
  hdr.writeUInt32LE(bRingCounts.length, 24);

  const outBuf = Buffer.concat([hdr, bPolyCounts, bRingCounts, Buffer.from(coastBytes), bWaterXY, bCountry, bProv]);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, outBuf);
  const gz = zlib.gzipSync(outBuf, { level: 6 });

  // Benchmark client earcut triangulation speed right now!
  const t0 = performance.now();
  let vCursor = 0, rCursor = 0, triTotal = 0;
  for (let p = 0; p < polyRingCounts.length; p++) {
    const rCnt = polyRingCounts[p];
    const startV = vCursor;
    const holes = [];
    for (let r = 0; r < rCnt; r++) {
      if (r > 0) holes.push(vCursor - startV);
      vCursor += ringVertCounts[rCursor++];
    }
    const sub = waterVerts.slice(startV * 2, vCursor * 2);
    const tris = earcut(sub, holes, 2);
    triTotal += tris.length / 3;
  }
  const dt = performance.now() - t0;

  console.log(`Polys=${polyRingCounts.length} Rings=${ringVertCounts.length} Verts=${(waterVerts.length/2).toLocaleString()} Tris=${triTotal.toLocaleString()} (earcut took ${dt.toFixed(2)}ms)`);
  console.log(`  meta+coast gz: ${((zlib.gzipSync(Buffer.concat([bPolyCounts, bRingCounts, coastBytes])).length)/1024).toFixed(1)}KB | xy gz: ${(zlib.gzipSync(bWaterXY).length/1024).toFixed(1)}KB | country gz: ${(zlib.gzipSync(bCountry).length/1024).toFixed(1)}KB | prov gz: ${(zlib.gzipSync(bProv).length/1024).toFixed(1)}KB`);
  console.log(`basemap.bin BM4 raw=${(outBuf.length / 1024).toFixed(1)} KB   gz=${(gz.length / 1024).toFixed(1)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
