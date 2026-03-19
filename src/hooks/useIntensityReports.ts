import { useState, useEffect, useMemo } from 'react';
import { type IntensityReport, type IntensityLocation } from '../types/intensity-report';
import { type ProcessedEarthquakeData } from '../types/processed-earthquake';

const REPORTS_URL = `${import.meta.env.BASE_URL}intensity-reports.json`;

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function useIntensityReports(selected: ProcessedEarthquakeData | null): IntensityLocation[] {
    const [reports, setReports] = useState<IntensityReport[]>([]);

    useEffect(() => {
        fetch(REPORTS_URL)
            .then(r => r.json())
            .then(setReports)
            .catch(err => console.warn('Could not load intensity reports:', err));
    }, []);

    return useMemo(() => {
        if (!selected || reports.length === 0) return [];

        const selectedDate = selected._dateTime;

        const match = reports.find(report => {
            const reportDate = new Date(report.date);
            const dayDiff = Math.abs(reportDate.getTime() - selectedDate.getTime()) / (1000 * 60 * 60 * 24);
            if (dayDiff > 1) return false;

            const dist = haversineDistanceKm(
                selected.latitude, selected.longitude,
                report.epicenter.latitude, report.epicenter.longitude
            );
            return dist <= report.matchRadius_km;
        });

        return match?.locations ?? [];
    }, [selected, reports]);
}
