export interface IntensityLocation {
    name: string;
    latitude: number;
    longitude: number;
    intensity: number; // 1-10 PEIS
}

export interface IntensityReport {
    id: string;
    description: string;
    date: string;
    magnitude: number;
    epicenter: { latitude: number; longitude: number };
    matchRadius_km: number;
    source: string;
    locations: IntensityLocation[];
}
