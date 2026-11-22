import type { PickHit, QuakeBuffer } from '../data/quakeStore';
import type { MapCamera } from './camera';

function pickInBuffer(
  sx: number,
  sy: number,
  camera: MapCamera,
  dataset: QuakeBuffer,
  sliceStart: number,
  sliceEnd: number,
  bestDepth: number,
): { index: number; depth: number } {
  if (sliceEnd <= sliceStart || dataset.count === 0) return { index: -1, depth: bestDepth };

  const m = camera.vpMatrix;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
  const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
  const m9 = m[9], m10 = m[10], m11 = m[11];
  const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

  const halfW = camera.width * 0.5;
  const halfH = camera.height * 0.5;
  const scaleCam = camera.scale * camera.camDist;
  const buf = dataset.gpuBuf;
  const pad = 4;

  let bestIdx = -1;
  let curDepth = bestDepth;

  const bounds = dataset.chunkBounds;
  const shift = dataset.chunkShift;

  if (bounds && shift && sliceEnd - sliceStart > (1 << shift)) {
    const ndcXMin = (sx - 80) / halfW - 1;
    const ndcXMax = (sx + 80) / halfW - 1;
    const ndcYMin = 1 - (sy + 80) / halfH;
    const ndcYMax = 1 - (sy - 80) / halfH;

    const lx = m0 - ndcXMin * m3, ly = m4 - ndcXMin * m7, lz = -ndcXMin * m11, lw = m12 - ndcXMin * m15;
    const rx = ndcXMax * m3 - m0, ry = ndcXMax * m7 - m4, rz = ndcXMax * m11, rw = ndcXMax * m15 - m12;
    const bx = m1 - ndcYMin * m3, by = m5 - ndcYMin * m7, bz = m9 - ndcYMin * m11, bw = m13 - ndcYMin * m15;
    const tx = ndcYMax * m3 - m1, ty = ndcYMax * m7 - m5, tz = ndcYMax * m11 - m9, tw = ndcYMax * m15 - m13;

    const firstC = sliceStart >>> shift;
    const lastC = (sliceEnd - 1) >>> shift;

    for (let c = firstC; c <= lastC; c++) {
      const cb = c * 5;
      const minX = bounds[cb];
      const maxX = bounds[cb + 1];
      const minY = bounds[cb + 2];
      const maxY = bounds[cb + 3];
      const minZ = bounds[cb + 4];

      if (
        (m3 >= 0 ? maxX : minX) * m3 + (m7 >= 0 ? maxY : minY) * m7 + (m11 < 0 ? minZ * m11 : 0) + m15 <= 1e-3 ||
        (lx >= 0 ? maxX : minX) * lx + (ly >= 0 ? maxY : minY) * ly + (lz < 0 ? minZ * lz : 0) + lw < 0 ||
        (rx >= 0 ? maxX : minX) * rx + (ry >= 0 ? maxY : minY) * ry + (rz < 0 ? minZ * rz : 0) + rw < 0 ||
        (bx >= 0 ? maxX : minX) * bx + (by >= 0 ? maxY : minY) * by + (bz < 0 ? minZ * bz : 0) + bw < 0 ||
        (tx >= 0 ? maxX : minX) * tx + (ty >= 0 ? maxY : minY) * ty + (tz < 0 ? minZ * tz : 0) + tw < 0
      ) {
        continue;
      }

      const cs = Math.max(sliceStart, c << shift);
      const ce = Math.min(sliceEnd, (c + 1) << shift);
      for (let i = cs; i < ce; i++) {
        const o = i * 5;
        const x = buf[o];
        const y = buf[o + 1];
        const z = buf[o + 2];

        const cw = m3 * x + m7 * y + m11 * z + m15;
        if (cw <= 1e-3) continue;

        const invW = 1 / cw;
        const px = ((m0 * x + m4 * y + m12) * invW + 1) * halfW;
        const dx = px - sx;
        if (dx > 80 || dx < -80) continue;

        const py = (1 - (m1 * x + m5 * y + m9 * z + m13) * invW) * halfH;
        const dy = py - sy;
        if (dy > 80 || dy < -80) continue;

        const rMerc = buf[o + 3];
        const rPx = Math.max(2, rMerc * scaleCam * invW) + pad;
        if (dx * dx + dy * dy <= rPx * rPx) {
          const ndcZ = (m2 * x + m6 * y + m10 * z + m14) * invW;
          if (ndcZ < curDepth) {
            curDepth = ndcZ;
            bestIdx = i;
          }
        }
      }
    }
    return { index: bestIdx, depth: curDepth };
  }

  for (let i = sliceStart; i < sliceEnd; i++) {
    const o = i * 5;
    const x = buf[o];
    const y = buf[o + 1];
    const z = buf[o + 2];

    const cw = m3 * x + m7 * y + m11 * z + m15;
    if (cw <= 1e-3) continue;

    const invW = 1 / cw;
    const px = ((m0 * x + m4 * y + m12) * invW + 1) * halfW;
    const dx = px - sx;
    if (dx > 80 || dx < -80) continue;

    const py = (1 - (m1 * x + m5 * y + m9 * z + m13) * invW) * halfH;
    const dy = py - sy;
    if (dy > 80 || dy < -80) continue;

    const rMerc = buf[o + 3];
    const rPx = Math.max(2, rMerc * scaleCam * invW) + pad;
    if (dx * dx + dy * dy <= rPx * rPx) {
      const ndcZ = (m2 * x + m6 * y + m10 * z + m14) * invW;
      if (ndcZ < curDepth) {
        curDepth = ndcZ;
        bestIdx = i;
      }
    }
  }

  return { index: bestIdx, depth: curDepth };
}

export function pickEarthquakeAt(
  sx: number,
  sy: number,
  camera: MapCamera,
  primary: QuakeBuffer,
  primarySlice: [number, number],
  minor: QuakeBuffer,
  minorSlice: [number, number],
): PickHit | null {
  const h0 = pickInBuffer(sx, sy, camera, primary, primarySlice[0], primarySlice[1], Infinity);
  const h1 = pickInBuffer(sx, sy, camera, minor, minorSlice[0], minorSlice[1], h0.depth);
  if (h1.index >= 0) return { bufKind: 1, index: h1.index };
  if (h0.index >= 0) return { bufKind: 0, index: h0.index };
  return null;
}
