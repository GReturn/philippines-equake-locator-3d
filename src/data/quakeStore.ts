import {
  decodeCoreEqb,
  decodeLocEqb,
  decodeLocationAt,
  decodeMinorGeoEqb,
  formatMinutesToDateTime,
  formatQuakeId,
  type DecodedCoreQuakes,
  type DecodedLocTable,
  type DecodedMinorGeo,
} from './binaryCodec';
import { SPECTRAL_DEPTH_RGB, latToMercY, lngToMercX, metersToMercator } from '../constants/map';
import type { EarthquakeRecord } from '../types/earthquake';

const LIVE_BASE_URL = 'https://greturn.github.io/phivolcs-earthquake-data-scraper/data';
const CORE_THRESHOLD_10 = 43;
const IDB_NAME = 'ph-equake-cache-v1';
const IDB_STORE = 'live-year';

export interface QuakeBuffer {
  count: number;
  magQ: Uint8Array;      // sorted DESC
  lonArr: Float32Array;
  latArr: Float32Array;
  depthArr: Float32Array;
  gpuBuf: Float32Array;  // 5 floats/quake: mx, my, mz, radiusMerc, depthNorm
  chunkBounds?: Float32Array | null;
  chunkShift?: number;
  version: number;
}

export interface PickHit {
  bufKind: 0 | 1; // 0 = primary/core, 1 = minor
  index: number;
}

interface LiveYearPayload {
  year: number;
  lastModMs: number;
  count: number;
  lon: Float32Array;
  lat: Float32Array;
  depth: Float32Array;
  magQ: Uint8Array;
  times: Uint32Array;
  locs: string[];
}

function emptyBuffer(): QuakeBuffer {
  return {
    count: 0,
    magQ: new Uint8Array(0),
    lonArr: new Float32Array(0),
    latArr: new Float32Array(0),
    depthArr: new Float32Array(0),
    gpuBuf: new Float32Array(0),
    version: 0,
  };
}

export function sliceSortedDesc(arr: Uint8Array, n: number, minMag: number, maxMag: number): [number, number] {
  if (n === 0) return [0, 0];
  const minQ = Math.round(minMag * 10);
  const maxQ = Math.round(maxMag * 10);

  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] > maxQ) lo = mid + 1;
    else hi = mid;
  }
  const start = lo;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] >= minQ) lo = mid + 1;
    else hi = mid;
  }
  return [start, lo];
}

function openIdb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(IDB_STORE)) {
          req.result.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openIdb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => { db.close(); resolve((req.result as T) ?? null); };
      req.onerror = () => { db.close(); resolve(null); };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    } catch {
      db.close();
      resolve();
    }
  });
}

function parseCsvInWorker(url: string): Promise<LiveYearPayload & { year: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./csvWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      worker.terminate();
      if (ev.data.ok) resolve(ev.data);
      else reject(new Error(ev.data.error));
    };
    worker.onerror = (err) => {
      worker.terminate();
      reject(err);
    };
    worker.postMessage({ url });
  });
}

/**
 * Dual-VBO Zero-Merge Columnar QuakeStore:
 * - `primary`: core buffer (~3,042 quakes, 11.9 KB gz!) — uploaded to GPU ONCE at startup.
 * - `minor`: lazy buffer (~129,946 quakes, 283 KB gz) — uploaded to a SEPARATE GPU VBO ONCE
 *   when user lowers minMag < 4.3, with ZERO array merging and ZERO copying!
 */
export class QuakeStore {
  private baseUrl: string;
  private core: DecodedCoreQuakes | null = null;
  private coreLoc: DecodedLocTable | null = null;
  private minorGeo: DecodedMinorGeo | null = null;
  private minorLoc: DecodedLocTable | null = null;
  private liveOverride: LiveYearPayload | null = null;

  private coreLocPromise: Promise<void> | null = null;
  private minorGeoPromise: Promise<void> | null = null;
  private minorLocPromise: Promise<void> | null = null;

  public primary: QuakeBuffer = emptyBuffer();
  public minor: QuakeBuffer = emptyBuffer();

  // Used only when liveOverride merges into primary (rare path when snapshot is older than live CSV)
  private liveMerged = false;
  private mergedSrcKind: Uint8Array = new Uint8Array(0);
  private mergedSrcIdx: Uint32Array = new Uint32Array(0);

  public minMag = 1.0;
  public maxMag = 7.8;
  public recentRecords: EarthquakeRecord[] = [];
  public majorRecords: EarthquakeRecord[] = [];
  private listeners = new Set<() => void>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  public onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  public async loadCore(prefetchedCore?: Promise<ArrayBuffer>): Promise<void> {
    const buf = prefetchedCore
      ? await prefetchedCore
      : await fetch(`${this.baseUrl}data/quakes-core.eqb`).then((r) => {
          if (!r.ok) throw new Error(`Failed to load core data (${r.status})`);
          return r.arrayBuffer();
        });

    const core = decodeCoreEqb(buf);
    this.core = core;
    this.minMag = core.minMag10 / 10;
    this.maxMag = core.maxMag10 / 10;

    // ZERO-COPY direct reference to core buffers!
    this.primary = {
      count: core.coreCount,
      magQ: core.magQ,
      lonArr: core.lonArr,
      latArr: core.latArr,
      depthArr: core.depthArr,
      gpuBuf: core.gpuBuf,
      chunkBounds: core.chunkBounds,
      chunkShift: core.chunkShift,
      version: this.primary.version + 1,
    };
    this.recentRecords = Array.from(core.recentIndices, (idx) => this.buildCoreRecord(core, idx));
    this.majorRecords = Array.from(core.majorIndices, (idx) => this.buildCoreRecord(core, idx));
    this.emit();

    // Non-blocking freshness check well after initial paint
    setTimeout(() => {
      this.checkLiveFreshness().catch(() => {});
    }, 1500);
  }

  public async ensureMinorGeo(): Promise<void> {
    if (this.minorGeo) return;
    if (!this.minorGeoPromise) {
      this.minorGeoPromise = fetch(`${this.baseUrl}data/quakes-minor-geo.eqb`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => {
          const mg = decodeMinorGeoEqb(buf);
          this.minorGeo = mg;
          if (this.liveOverride) {
            this.rebuildLiveMerged();
          } else {
            // ZERO-COPY direct assignment to separate minor VBO!
            this.minor = {
              count: mg.count,
              magQ: mg.magQ,
              lonArr: mg.lonArr,
              latArr: mg.latArr,
              depthArr: mg.depthArr,
              gpuBuf: mg.gpuBuf,
              chunkBounds: mg.chunkBounds,
              chunkShift: mg.chunkShift,
              version: this.minor.version + 1,
            };
          }
          this.emit();
        })
        .catch((err) => {
          this.minorGeoPromise = null;
          throw err;
        });
    }
    return this.minorGeoPromise;
  }

  private async ensureCoreLoc(): Promise<void> {
    if (this.coreLoc) return;
    if (!this.coreLocPromise) {
      this.coreLocPromise = fetch(`${this.baseUrl}data/quakes-core-loc.eqb`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => { this.coreLoc = decodeLocEqb(buf); })
        .catch((err) => { this.coreLocPromise = null; throw err; });
    }
    return this.coreLocPromise;
  }

  private async ensureMinorLoc(): Promise<void> {
    if (this.minorLoc) return;
    if (!this.minorLocPromise) {
      this.minorLocPromise = fetch(`${this.baseUrl}data/quakes-minor-loc.eqb`)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((buf) => { this.minorLoc = decodeLocEqb(buf); })
        .catch((err) => { this.minorLocPromise = null; throw err; });
    }
    return this.minorLocPromise;
  }

  private async checkLiveFreshness(): Promise<void> {
    if (!this.core) return;
    const snapYear = this.core.snapshotYear;
    const currentYear = Math.max(snapYear, new Date().getFullYear());
    const targetUrl = `${LIVE_BASE_URL}/phivolcs_earthquake_${currentYear}.csv`;

    const cacheKey = `year-${currentYear}`;
    const cached = await idbGet<LiveYearPayload>(cacheKey);
    if (cached && cached.lastModMs > this.core.latestYearLastModMs) {
      this.liveOverride = cached;
      this.rebuildLiveMerged();
      this.emit();
    }

    const headRes = await fetch(targetUrl, { method: 'HEAD', cache: 'no-cache' });
    if (!headRes.ok) return;
    const lm = headRes.headers.get('last-modified');
    if (!lm) return;
    const liveLastModMs = Date.parse(lm);
    const haveMs = Math.max(this.core.latestYearLastModMs, this.liveOverride?.lastModMs ?? 0);

    if (liveLastModMs > haveMs + 60_000 || currentYear > snapYear) {
      const parsed = await parseCsvInWorker(targetUrl);
      const payload: LiveYearPayload = { ...parsed, year: currentYear };
      this.liveOverride = payload;
      this.rebuildLiveMerged();
      this.emit();
      await idbSet(cacheKey, payload);
    }
  }

  private rebuildLiveMerged() {
    const core = this.core;
    const live = this.liveOverride;
    if (!core || !live) return;

    const replaceSnap = live.year === core.snapshotYear;
    const mg = this.minorGeo;
    const counts = new Uint32Array(121);
    let minM = core.minMag10;
    let maxM = core.maxMag10;

    for (let i = 0; i < core.coreCount; i++) {
      if (replaceSnap && ((core.snapBits[i >> 3] >> (i & 7)) & 1)) continue;
      counts[Math.min(120, core.magQ[i])]++;
    }
    if (mg) {
      for (let i = 0; i < mg.count; i++) {
        if (replaceSnap && ((mg.snapBits[i >> 3] >> (i & 7)) & 1)) continue;
        counts[Math.min(120, mg.magQ[i])]++;
      }
    }
    for (let i = 0; i < live.count; i++) {
      const m = Math.min(120, live.magQ[i]);
      counts[m]++;
      if (m < minM) minM = m;
      if (m > maxM) maxM = m;
    }

    this.minMag = minM / 10;
    this.maxMag = maxM / 10;

    const offsets = new Uint32Array(121);
    let total = 0;
    for (let m = 120; m >= 0; m--) {
      offsets[m] = total;
      total += counts[m];
    }

    const magQ = new Uint8Array(total);
    const lonArr = new Float32Array(total);
    const latArr = new Float32Array(total);
    const depthArr = new Float32Array(total);
    const gpuBuf = new Float32Array(total * 5);
    const gpuU8 = new Uint8Array(gpuBuf.buffer);
    const srcKind = new Uint8Array(total);
    const srcIdx = new Uint32Array(total);

    for (let i = 0; i < core.coreCount; i++) {
      if (replaceSnap && ((core.snapBits[i >> 3] >> (i & 7)) & 1)) continue;
      const m = Math.min(120, core.magQ[i]);
      const dst = offsets[m]++;
      magQ[dst] = m; lonArr[dst] = core.lonArr[i]; latArr[dst] = core.latArr[i]; depthArr[dst] = core.depthArr[i];
      gpuBuf.set(core.gpuBuf.subarray(i * 5, i * 5 + 5), dst * 5);
      srcKind[dst] = 0; srcIdx[dst] = i;
    }
    if (mg) {
      for (let i = 0; i < mg.count; i++) {
        if (replaceSnap && ((mg.snapBits[i >> 3] >> (i & 7)) & 1)) continue;
        const m = Math.min(120, mg.magQ[i]);
        const dst = offsets[m]++;
        magQ[dst] = m; lonArr[dst] = mg.lonArr[i]; latArr[dst] = mg.latArr[i]; depthArr[dst] = mg.depthArr[i];
        gpuBuf.set(mg.gpuBuf.subarray(i * 5, i * 5 + 5), dst * 5);
        srcKind[dst] = 1; srcIdx[dst] = i;
      }
    }
    for (let i = 0; i < live.count; i++) {
      const m = Math.min(120, live.magQ[i]);
      const dst = offsets[m]++;
      const lo = live.lon[i], la = live.lat[i], dp = live.depth[i];
      magQ[dst] = m; lonArr[dst] = lo; latArr[dst] = la; depthArr[dst] = dp;
      const mx = lngToMercX(lo), my = latToMercY(la), m2m = metersToMercator(la);
      const di = dst * 5;
      gpuBuf[di] = mx; gpuBuf[di + 1] = my; gpuBuf[di + 2] = -dp * 1000 * m2m;
      gpuBuf[di + 3] = Math.pow(2, m * 0.1) * 100 * m2m;
      const depIdx = Math.max(0, Math.min(500, Math.round(dp))) * 3;
      const u8o = di * 4 + 16;
      gpuU8[u8o] = SPECTRAL_DEPTH_RGB[depIdx];
      gpuU8[u8o + 1] = SPECTRAL_DEPTH_RGB[depIdx + 1];
      gpuU8[u8o + 2] = SPECTRAL_DEPTH_RGB[depIdx + 2];
      gpuU8[u8o + 3] = 255;
      srcKind[dst] = 2; srcIdx[dst] = i;
    }

    this.liveMerged = true;
    this.mergedSrcKind = srcKind;
    this.mergedSrcIdx = srcIdx;
    this.primary = { count: total, magQ, lonArr, latArr, depthArr, gpuBuf, version: this.primary.version + 1 };
    this.minor = emptyBuffer();

    const liveByTime = Array.from({ length: live.count }, (_, i) => i)
      .sort((a, b) => live.times[b] - live.times[a])
      .slice(0, 100);
    this.recentRecords = liveByTime.map((i) => this.buildLiveRecord(live, i));
    this.majorRecords = Array.from({ length: Math.min(30, total) }, (_, i) => this.getRecordSync({ bufKind: 0, index: i })!);
  }

  public getVisibleSlices(minMag: number, maxMag: number): {
    primary: [number, number];
    minor: [number, number];
  } {
    const pSlice = sliceSortedDesc(this.primary.magQ, this.primary.count, minMag, maxMag);
    const mSlice: [number, number] = this.minor.count > 0
      ? sliceSortedDesc(this.minor.magQ, this.minor.count, minMag, maxMag)
      : [0, 0];
    return { primary: pSlice, minor: mSlice };
  }

  public needsMinorForMinMag(minMag: number): boolean {
    return Math.round(minMag * 10) < CORE_THRESHOLD_10 && !this.minorGeo;
  }

  private buildCoreRecord(core: DecodedCoreQuakes, idx: number): EarthquakeRecord {
    const lat = Number(core.latArr[idx].toFixed(4));
    const lon = Number(core.lonArr[idx].toFixed(4));
    const depth_km = Number(core.depthArr[idx].toFixed(1));
    const magnitude = core.magQ[idx] / 10;

    // 1. Check inline featured table (Recent 100 + Major 30 -> ALWAYS instant, 0 network!)
    const fPos = core.featuredMap.get(idx);
    if (fPos !== undefined) {
      const { datetime, timestampMs } = formatMinutesToDateTime(core.featuredTimes[fPos]);
      const location = decodeLocationAt(core.featuredLocations, fPos);
      return { id: formatQuakeId(datetime, lat, lon, magnitude), datetime, timestampMs, latitude: lat, longitude: lon, depth_km, magnitude, location };
    }
    // 2. Check lazily-loaded full core locations table
    if (this.coreLoc) {
      const { datetime, timestampMs } = formatMinutesToDateTime(this.coreLoc.times[idx]);
      const location = decodeLocationAt(this.coreLoc.locations, idx);
      return { id: formatQuakeId(datetime, lat, lon, magnitude), datetime, timestampMs, latitude: lat, longitude: lon, depth_km, magnitude, location };
    }
    return {
      id: `${lat.toFixed(4)}-${lon.toFixed(4)}-${magnitude.toFixed(1)}`,
      datetime: '',
      timestampMs: 0,
      latitude: lat,
      longitude: lon,
      depth_km,
      magnitude,
      location: 'Loading location...',
    };
  }

  private buildMinorRecord(mg: DecodedMinorGeo, idx: number): EarthquakeRecord {
    const lat = Number(mg.latArr[idx].toFixed(4));
    const lon = Number(mg.lonArr[idx].toFixed(4));
    const depth_km = Number(mg.depthArr[idx].toFixed(1));
    const magnitude = mg.magQ[idx] / 10;
    if (this.minorLoc) {
      const { datetime, timestampMs } = formatMinutesToDateTime(this.minorLoc.times[idx]);
      const location = decodeLocationAt(this.minorLoc.locations, idx);
      return { id: formatQuakeId(datetime, lat, lon, magnitude), datetime, timestampMs, latitude: lat, longitude: lon, depth_km, magnitude, location };
    }
    return {
      id: `${lat.toFixed(4)}-${lon.toFixed(4)}-${magnitude.toFixed(1)}`,
      datetime: '',
      timestampMs: 0,
      latitude: lat,
      longitude: lon,
      depth_km,
      magnitude,
      location: 'Loading location...',
    };
  }

  private buildLiveRecord(live: LiveYearPayload, idx: number): EarthquakeRecord {
    const lat = Number(live.lat[idx].toFixed(4));
    const lon = Number(live.lon[idx].toFixed(4));
    const depth_km = Number(live.depth[idx].toFixed(1));
    const magnitude = live.magQ[idx] / 10;
    const { datetime, timestampMs } = formatMinutesToDateTime(live.times[idx]);
    return { id: formatQuakeId(datetime, lat, lon, magnitude), datetime, timestampMs, latitude: lat, longitude: lon, depth_km, magnitude, location: live.locs[idx] ?? '' };
  }

  public getRecordSync(hit: PickHit): EarthquakeRecord | null {
    if (this.liveMerged) {
      const kind = this.mergedSrcKind[hit.index];
      const idx = this.mergedSrcIdx[hit.index];
      if (kind === 0 && this.core) return this.buildCoreRecord(this.core, idx);
      if (kind === 1 && this.minorGeo) return this.buildMinorRecord(this.minorGeo, idx);
      if (kind === 2 && this.liveOverride) return this.buildLiveRecord(this.liveOverride, idx);
      return null;
    }
    if (hit.bufKind === 0 && this.core) return this.buildCoreRecord(this.core, hit.index);
    if (hit.bufKind === 1 && this.minorGeo) return this.buildMinorRecord(this.minorGeo, hit.index);
    return null;
  }

  public async getRecordFull(hit: PickHit): Promise<EarthquakeRecord | null> {
    if (this.liveMerged) {
      const kind = this.mergedSrcKind[hit.index];
      const idx = this.mergedSrcIdx[hit.index];
      if (kind === 0 && this.core && !this.core.featuredMap.has(idx)) await this.ensureCoreLoc();
      if (kind === 1) await this.ensureMinorLoc();
      return this.getRecordSync(hit);
    }
    if (hit.bufKind === 0 && this.core && !this.core.featuredMap.has(hit.index)) {
      await this.ensureCoreLoc();
    } else if (hit.bufKind === 1) {
      await this.ensureMinorLoc();
    }
    return this.getRecordSync(hit);
  }

  public getTooltipInfo(hit: PickHit): { magnitude: number; depth_km: number } | null {
    const buf = hit.bufKind === 0 ? this.primary : this.minor;
    if (hit.index < 0 || hit.index >= buf.count) return null;
    return {
      magnitude: buf.magQ[hit.index] / 10,
      depth_km: Number(buf.depthArr[hit.index].toFixed(1)),
    };
  }
}
