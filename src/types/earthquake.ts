export interface EarthquakeRecord {
  id: string;
  datetime: string;
  timestampMs: number;
  latitude: number;
  longitude: number;
  depth_km: number;
  magnitude: number;
  location: string;
}

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export type ActivePanel = 'filter' | 'history' | 'major-quakes' | 'about' | null;