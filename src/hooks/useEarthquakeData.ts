import { useState, useEffect } from 'react';
import { scaleSequential } from 'd3-scale';
import { interpolateSpectral } from 'd3-scale-chromatic';
import { rgb } from 'd3-color';
import { load } from '@loaders.gl/core';
import { FlatGeobufLoader } from '@loaders.gl/flatgeobuf';

import { parseCustomDateTime } from '../utils/datetime-parser';
import { type ProcessedEarthquakeData } from '../types/processed-earthquake';
import { type FGBFeature } from '../types/fgb';

const DATA_URL = "https://greturn.github.io/phivolcs-earthquake-data-scraper/data/earthquakes.fgb";
const DEFAULT_MIN_MAGNITUDE = 4.3;
const colorScale = scaleSequential([0, -500000], interpolateSpectral);

interface FGBLoaderResult {
    features: FGBFeature[];
}

export function useEarthquakeData() {
    const [data, setData] = useState<ProcessedEarthquakeData[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dataMinMaxMag, setDataMinMaxMag] = useState<[number, number]>([0, 10]);
    const [magnitudeRange, setMagnitudeRange] = useState<[number, number]>([DEFAULT_MIN_MAGNITUDE, 10]);
    const [recentEarthquakes, setRecentEarthquakes] = useState<ProcessedEarthquakeData[]>([]);
    const [majorEarthquakes, setMajorEarthquakes] = useState<ProcessedEarthquakeData[]>([]);

    useEffect(() => {
        const loadData = async () => {
            try {
                const response = (await load(DATA_URL, FlatGeobufLoader)) as unknown as FGBLoaderResult;
                const features = response.features;

                const processedData: ProcessedEarthquakeData[] = features.map((f: FGBFeature) => {
                    const [lon, lat, depth] = f.geometry.coordinates;
                    const props = f.properties;
                    const depthKm = props.depth_km || depth || 0;
                    const colorString = colorScale(-depthKm * 1000);
                    const color = rgb(colorString);

                    return {
                        ...props,
                        id: props.id,
                        magnitude: props.magnitude,
                        location: props.location,
                        datetime: props.datetime,
                        longitude: lon,
                        latitude: lat,
                        depth_km: depthKm,
                        _color: [color.r, color.g, color.b] as [number, number, number],
                        _dateTime: parseCustomDateTime(props.datetime)
                    };
                });

                setData(processedData);

                // Compute min/max magnitude with a single-pass reduce (safe for large arrays)
                let minMag = Infinity;
                let maxMag = -Infinity;
                for (const d of processedData) {
                    if (d.magnitude < minMag) minMag = d.magnitude;
                    if (d.magnitude > maxMag) maxMag = d.magnitude;
                }
                minMag = Math.floor(minMag * 10) / 10;
                maxMag = Math.floor(maxMag * 10) / 10;

                setDataMinMaxMag([minMag, maxMag]);
                setMagnitudeRange([Math.min(DEFAULT_MIN_MAGNITUDE, maxMag), maxMag]);

                // Recent quakes (sorted by date, newest first)
                const sortedByDate = [...processedData].sort((a, b) =>
                    b._dateTime.getTime() - a._dateTime.getTime()
                );
                setRecentEarthquakes(sortedByDate.slice(0, 100));

                // Major quakes (sorted by magnitude, largest first)
                const sortedByMag = [...processedData].sort((a, b) => b.magnitude - a.magnitude);
                setMajorEarthquakes(sortedByMag.slice(0, 30));

            } catch (err) {
                console.error("Failed to load data:", err);
                setError("Failed to load earthquake data. Please try refreshing the page.");
            } finally {
                setIsLoading(false);
            }
        };

        loadData();
    }, []);

    return {
        data,
        isLoading,
        error,
        dataMinMaxMag,
        magnitudeRange,
        setMagnitudeRange,
        recentEarthquakes,
        majorEarthquakes,
    };
}
