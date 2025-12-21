export interface FGBFeature {
    geometry: {
        coordinates: [number, number, number];
    };
    properties: {
        id: string;
        magnitude: number;
        depth_km: number;
        location: string;
        datetime: string;
        month: string;
        year: number;
    };
}