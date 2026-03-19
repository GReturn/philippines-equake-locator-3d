import { useState, useCallback } from 'react';
import { FlyToInterpolator, type MapViewState } from '@deck.gl/core';
import { INITIAL_VIEW_STATE } from '../constants/map';
import { type ProcessedEarthquakeData } from '../types/processed-earthquake';

export function useMapNavigation() {
    const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);

    const flyToEarthquake = useCallback((equake: ProcessedEarthquakeData) => {
        const pitch = 60;
        const pitchRadians = (pitch * Math.PI) / 180;
        const depthMeters = equake.depth_km * 1000;

        // Convert the meter offset to a change in latitude
        // ~111,321 meters per degree of latitude
        // https://www.thoughtco.com/degree-of-latitude-and-longitude-distance-4070616
        const meterOffset = depthMeters * Math.tan(pitchRadians);
        const metersPerDegreeLatitude = 111321;
        const deltaLatitude = meterOffset / metersPerDegreeLatitude;
        const targetLatitude = equake.latitude - deltaLatitude;

        setViewState(current => ({
            ...current,
            longitude: equake.longitude,
            latitude: targetLatitude,
            zoom: 8,
            pitch: 60,
            bearing: 0,
            transitionInterpolator: new FlyToInterpolator({ speed: 1.5 }),
            transitionDuration: 2000
        }));
    }, []);

    return { viewState, setViewState, flyToEarthquake };
}
