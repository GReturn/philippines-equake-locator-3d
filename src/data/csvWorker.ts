// Web Worker for parsing live PHIVOLCS current-year CSV off the main thread
// Only spawned when live Last-Modified > build snapshot timestamp (or year rollover).

const EPOCH_MS = Date.UTC(2018, 0, 1, 0, 0, 0);
const MONTHS: Record<string, number> = {
  January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
  July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
};

function parseDateMin(s: string): number {
  const dash = s.indexOf(' - ');
  if (dash < 0) return 0;
  const dPart = s.slice(0, dash);
  const tPart = s.slice(dash + 3);
  const s1 = dPart.indexOf(' ');
  const s2 = dPart.indexOf(' ', s1 + 1);
  if (s1 < 0 || s2 < 0) return 0;
  const day = parseInt(dPart.slice(0, s1), 10);
  const mon = MONTHS[dPart.slice(s1 + 1, s2)] ?? 0;
  const yr = parseInt(dPart.slice(s2 + 1), 10);

  const colon = tPart.indexOf(':');
  const sp = tPart.indexOf(' ', colon + 1);
  let hr = parseInt(tPart.slice(0, colon), 10);
  const min = parseInt(tPart.slice(colon + 1, sp), 10);
  const ap = tPart.slice(sp + 1).toUpperCase();
  if (ap === 'PM' && hr !== 12) hr += 12;
  if (ap === 'AM' && hr === 12) hr = 0;
  return Math.round((Date.UTC(yr, mon, day, hr, min) - EPOCH_MS) / 60000);
}

self.onmessage = async (ev: MessageEvent<{ url: string }>) => {
  try {
    const res = await fetch(ev.data.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lastModHeader = res.headers.get('last-modified');
    const lastModMs = lastModHeader ? Date.parse(lastModHeader) : Date.now();
    const text = (await res.text()).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/);

    const maxRows = Math.max(0, lines.length - 1);
    const lon = new Float32Array(maxRows);
    const lat = new Float32Array(maxRows);
    const depth = new Float32Array(maxRows);
    const magQ = new Uint8Array(maxRows);
    const times = new Uint32Array(maxRows);
    const locs: string[] = [];

    let count = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let parts: string[];
      if (line.includes('"')) {
        parts = [];
        let cur = '';
        let inQ = false;
        for (let k = 0; k < line.length; k++) {
          const ch = line[k];
          if (ch === '"') inQ = !inQ;
          else if (ch === ',' && !inQ) { parts.push(cur); cur = ''; }
          else cur += ch;
        }
        parts.push(cur);
      } else {
        parts = line.split(',');
      }
      if (parts.length < 7) continue;
      const la = parseFloat(parts[2]);
      const lo = parseFloat(parts[3]);
      const dp = parseFloat(parts[4]);
      const mg = parseFloat(parts[5]);
      if (Number.isNaN(la) || Number.isNaN(lo) || Number.isNaN(mg)) continue;

      lon[count] = lo;
      lat[count] = la;
      depth[count] = Number.isNaN(dp) ? 0 : dp;
      magQ[count] = Math.round(mg * 10);
      times[count] = parseDateMin(parts[1]);
      locs.push(parts[6]);
      count++;
    }

    const outLon = lon.slice(0, count);
    const outLat = lat.slice(0, count);
    const outDepth = depth.slice(0, count);
    const outMagQ = magQ.slice(0, count);
    const outTimes = times.slice(0, count);

    (self as unknown as Worker).postMessage(
      { ok: true, count, lastModMs, lon: outLon, lat: outLat, depth: outDepth, magQ: outMagQ, times: outTimes, locs },
      [outLon.buffer, outLat.buffer, outDepth.buffer, outMagQ.buffer, outTimes.buffer],
    );
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err) });
  }
};
