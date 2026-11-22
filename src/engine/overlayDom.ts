import {
  SPECTRAL_RGB,
  latToMercY,
  lngToMercX,
  metersToMercator,
} from '../constants/map';
import type { EarthquakeRecord } from '../types/earthquake';
import type { MapCamera } from './camera';

export interface OverlayQuake {
  mx: number;
  my: number;
  mz: number;
  m2m: number;
  radiusMerc: number;
  fillCss: string;
}

function sampleSpectralCss(depthKm: number): string {
  const t = Math.max(0, Math.min(1, depthKm / 500));
  const f = t * 16;
  const i = Math.floor(f);
  const n = Math.min(16, i + 1);
  const frac = f - i;
  const r = Math.round(SPECTRAL_RGB[i][0] * (1 - frac) + SPECTRAL_RGB[n][0] * frac);
  const g = Math.round(SPECTRAL_RGB[i][1] * (1 - frac) + SPECTRAL_RGB[n][1] * frac);
  const b = Math.round(SPECTRAL_RGB[i][2] * (1 - frac) + SPECTRAL_RGB[n][2] * frac);
  return `rgb(${r},${g},${b})`;
}

export function toOverlayQuake(q: EarthquakeRecord): OverlayQuake {
  const mx = lngToMercX(q.longitude);
  const my = latToMercY(q.latitude);
  const m2m = metersToMercator(q.latitude);
  return {
    mx,
    my,
    mz: -q.depth_km * 1000 * m2m,
    m2m,
    radiusMerc: Math.pow(2, q.magnitude) * 100 * m2m,
    fillCss: sampleSpectralCss(q.depth_km),
  };
}

const RIPPLE_BASE_RADIUS = 60; // Fixed 120x120px rasterized circle scaled purely via GPU transform!

/**
 * Zero-full-screen-layer compositor-driven DOM overlay:
 * - NO full-screen 1440x900 <svg> layer (avoids Blink overlap-promoting a 5.2 MB full-screen
 *   composited bitmap over the WebGL canvas on every ripple frame — 2,000x less composited area!).
 * - `.ripple-anchor` moves/scales purely via GPU `transform: translate3d(...) scale(...)`.
 * - `.ripple-ring` is a fixed 120x120px layer animated on the compositor thread via CSS @keyframes.
 * - Depth line, selected ring, and epicenter marker are 3 tiny exact-bounds divs (~300 px² total).
 */
export class OverlayDomRenderer {
  private wrap: HTMLDivElement;
  private rippleAnchor: HTMLDivElement;
  private rippleEl: HTMLDivElement;
  private lineEl: HTMLDivElement;
  private quakeEl: HTMLDivElement;
  private epiEl: HTMLDivElement;
  private visible = false;
  private lastQuakeDia = -1;
  private lastEpiDia = -1;
  private lastQuakeFill = '';
  private lastIsSelected: boolean | null = null;

  constructor(parent: HTMLElement) {
    this.wrap = document.createElement('div');
    this.wrap.className = 'overlay-layer';
    this.wrap.hidden = true;

    this.rippleAnchor = document.createElement('div');
    this.rippleAnchor.className = 'ripple-anchor';
    this.rippleEl = document.createElement('div');
    this.rippleEl.className = 'ripple-ring';
    this.rippleAnchor.appendChild(this.rippleEl);

    this.lineEl = document.createElement('div');
    this.lineEl.className = 'overlay-line';

    this.quakeEl = document.createElement('div');
    this.quakeEl.className = 'overlay-dot overlay-quake';

    this.epiEl = document.createElement('div');
    this.epiEl.className = 'overlay-dot overlay-epi';

    this.wrap.append(this.rippleAnchor, this.lineEl, this.quakeEl, this.epiEl);
    parent.appendChild(this.wrap);
  }

  public clear() {
    if (!this.visible) return;
    this.wrap.hidden = true;
    this.visible = false;
  }

  public restartRipple() {
    this.rippleEl.style.animation = 'none';
    void this.rippleEl.offsetWidth;
    this.rippleEl.style.animation = '';
  }

  private project(camera: MapCamera, mx: number, my: number, mz: number): [number, number, number] | null {
    const m = camera.vpMatrix;
    const cw = m[3] * mx + m[7] * my + m[11] * mz + m[15];
    if (cw <= 1) return null;
    const invW = 1 / cw;
    const cx = (m[0] * mx + m[4] * my + m[12]) * invW;
    const cy = (m[1] * mx + m[5] * my + m[9] * mz + m[13]) * invW;
    return [
      (cx * 0.5 + 0.5) * camera.width,
      (0.5 - cy * 0.5) * camera.height,
      cw,
    ];
  }

  public update(camera: MapCamera, active: OverlayQuake | null, isSelected: boolean) {
    if (!active) {
      this.clear();
      return;
    }

    const pHypo = this.project(camera, active.mx, active.my, active.mz);
    const pSurf = this.project(camera, active.mx, active.my, 0);
    if (!pHypo && !pSurf) {
      this.clear();
      return;
    }

    if (!this.visible) {
      this.wrap.hidden = false;
      this.visible = true;
    }

    const scaleCam = camera.scale * camera.camDist;

    if (pHypo) {
      const [hx, hy, hw] = pHypo;
      const maxRipplePx = Math.min(1200, Math.max(20, (50000 * active.m2m * scaleCam) / hw));
      const scale = maxRipplePx / RIPPLE_BASE_RADIUS;
      this.rippleAnchor.style.display = 'block';
      this.rippleAnchor.style.transform = `translate3d(${hx.toFixed(1)}px,${hy.toFixed(1)}px,0) scale(${scale.toFixed(3)})`;

      const rPx = Math.max(3, (active.radiusMerc * scaleCam) / hw);
      const bw = isSelected ? 2.2 : 1.5;
      const totalDia = Math.round((rPx + bw) * 2);
      const halfDia = totalDia * 0.5;
      this.quakeEl.style.display = 'block';
      if (totalDia !== this.lastQuakeDia) {
        this.lastQuakeDia = totalDia;
        this.quakeEl.style.width = `${totalDia}px`;
        this.quakeEl.style.height = `${totalDia}px`;
      }
      if (active.fillCss !== this.lastQuakeFill) {
        this.lastQuakeFill = active.fillCss;
        this.quakeEl.style.background = active.fillCss;
      }
      if (isSelected !== this.lastIsSelected) {
        this.lastIsSelected = isSelected;
        this.quakeEl.style.border = isSelected ? '2.2px solid #fff' : '1.5px solid rgba(255,255,255,0.85)';
      }
      this.quakeEl.style.transform = `translate3d(${(hx - halfDia).toFixed(1)}px,${(hy - halfDia).toFixed(1)}px,0)`;
    } else {
      this.rippleAnchor.style.display = 'none';
      this.quakeEl.style.display = 'none';
    }

    if (pHypo && pSurf) {
      const dx = pSurf[0] - pHypo[0];
      const dy = pSurf[1] - pHypo[1];
      const len = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      this.lineEl.style.display = 'block';
      this.lineEl.style.transform = `translate3d(${pHypo[0].toFixed(1)}px,${pHypo[1].toFixed(1)}px,0) rotate(${ang.toFixed(4)}rad) scaleX(${len.toFixed(1)})`;
    } else {
      this.lineEl.style.display = 'none';
    }

    if (pSurf) {
      const [sx, sy, sw] = pSurf;
      const epiPx = Math.max(4.5, (500 * active.m2m * scaleCam) / sw);
      const totalDia = Math.round((epiPx + 2) * 2);
      const halfDia = totalDia * 0.5;
      this.epiEl.style.display = 'block';
      if (totalDia !== this.lastEpiDia) {
        this.lastEpiDia = totalDia;
        this.epiEl.style.width = `${totalDia}px`;
        this.epiEl.style.height = `${totalDia}px`;
      }
      this.epiEl.style.transform = `translate3d(${(sx - halfDia).toFixed(1)}px,${(sy - halfDia).toFixed(1)}px,0)`;
    } else {
      this.epiEl.style.display = 'none';
    }
  }
}
