import { type EarthquakeData } from "./earthquake"

export type ProcessedEarthquakeData = EarthquakeData & {
    _color: [number, number, number];
    _dateTime: Date;
}