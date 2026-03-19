import { type ProcessedEarthquakeData } from '../types/processed-earthquake';
import {
    panelStyle,
    panelHeaderStyle,
    closeButtonStyle,
} from '../styles/earthquakePanelStyles';

interface EarthquakeDetailsPanelProps {
    earthquake: ProcessedEarthquakeData | null;
    onClose: () => void;
}

export function EarthquakeDetailsPanel({ earthquake, onClose }: EarthquakeDetailsPanelProps) {
    return (
        <div style={{
            ...panelStyle,
            transform: earthquake ? "translateX(0)" : "translateX(-450px)"
        }}>
            <div style={panelHeaderStyle}>
                <h3 style={{ margin: 0 }}>Earthquake Details</h3>
                <button
                    style={closeButtonStyle}
                    onClick={onClose}
                    aria-label="Close panel"
                >&times;</button>
            </div>
            <div style={{ marginTop: "1rem" }}>
                <p><strong>Magnitude:</strong> {earthquake?.magnitude}</p>
                <p><strong>Location:</strong> {earthquake?.location}</p>
                <p><strong>Date:</strong> {earthquake ? earthquake._dateTime.toLocaleString() : ''}</p>
                <p><strong>Depth:</strong> {earthquake?.depth_km} km</p>
                <p><strong>Latitude:</strong> {earthquake?.latitude}</p>
                <p><strong>Longitude:</strong> {earthquake?.longitude}</p>
                <p><strong>ID:</strong> {earthquake?.id}</p>
            </div>
        </div>
    );
}
