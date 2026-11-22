import type { ViewState } from '../types/earthquake';

export const INITIAL_VIEW_STATE: ViewState = {
  longitude: 122,
  latitude: 12.5,
  zoom: 5.5,
  pitch: 50,
  bearing: 0,
};

export const DEFAULT_MIN_MAGNITUDE = 4.3;

// Exact 17-stop RGB LUT sampled from d3.interpolateSpectral(0..1) mapped over depth [0, 500km]
export const SPECTRAL_RGB: readonly [number, number, number][] = [
  [158, 1, 66],
  [191, 39, 73],
  [219, 73, 74],
  [238, 105, 73],
  [248, 142, 83],
  [252, 179, 104],
  [254, 210, 129],
  [254, 234, 158],
  [251, 248, 176],
  [238, 248, 168],
  [213, 238, 159],
  [177, 224, 161],
  [137, 207, 165],
  [97, 183, 171],
  [70, 150, 179],
  [70, 115, 177],
  [94, 79, 162],
];

// Precomputed 501-entry 8-bit RGB LUT for depths 0..500 km (eliminates per-vertex shader LUT sampling!)
export const SPECTRAL_DEPTH_RGB = (() => {
  const lut = new Uint8Array(501 * 3);
  for (let d = 0; d <= 500; d++) {
    const f = (d / 500) * 16;
    const i = Math.floor(f);
    const n = i < 16 ? i + 1 : 16;
    const frac = f - i;
    const o = d * 3;
    lut[o] = Math.round(SPECTRAL_RGB[i][0] * (1 - frac) + SPECTRAL_RGB[n][0] * frac);
    lut[o + 1] = Math.round(SPECTRAL_RGB[i][1] * (1 - frac) + SPECTRAL_RGB[n][1] * frac);
    lut[o + 2] = Math.round(SPECTRAL_RGB[i][2] * (1 - frac) + SPECTRAL_RGB[n][2] * frac);
  }
  return lut;
})();

export const EARTH_CIRCUMFERENCE_M = 40075016.68557849;
export const TILE_SIZE = 512;
export const DEG2RAD = Math.PI / 180;

export function lngToMercX(lon: number): number {
  return (lon + 180) / 360;
}

export function latToMercY(lat: number): number {
  const sin = Math.sin(lat * DEG2RAD);
  const y = 0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

export function mercXToLng(mx: number): number {
  return mx * 360 - 180;
}

export function mercYToLat(my: number): number {
  const y2 = 180 - my * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

export function metersToMercator(lat: number): number {
  return 1 / (EARTH_CIRCUMFERENCE_M * Math.cos(lat * DEG2RAD));
}