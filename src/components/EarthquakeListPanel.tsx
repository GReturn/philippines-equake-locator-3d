import { MasterPanel } from './MasterPanel';
import { type ProcessedEarthquakeData } from '../types/processed-earthquake';
import {
    listItemStyle,
    listItemDateStyle,
    listItemLocationStyle,
} from '../styles/earthquakePanelStyles';
import '../styles/earthquakeList.css';

interface EarthquakeListPanelProps {
    title: string;
    earthquakes: ProcessedEarthquakeData[];
    onSelect: (quake: ProcessedEarthquakeData) => void;
    onClose: () => void;
}

export function EarthquakeListPanel({ title, earthquakes, onSelect, onClose }: EarthquakeListPanelProps) {
    return (
        <MasterPanel title={title} onClose={onClose}>
            {earthquakes.length === 0 ? (
                <p style={{ color: '#aaa', textAlign: 'center' }}>No earthquakes found.</p>
            ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {earthquakes.map(quake => (
                        <li
                            key={quake.id}
                            className="earthquake-list-item"
                            style={listItemStyle}
                            onClick={() => onSelect(quake)}
                            onKeyDown={e => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    onSelect(quake);
                                }
                            }}
                            tabIndex={0}
                            role="button"
                        >
                            <strong>Mag {quake.magnitude}</strong>
                            <span style={listItemLocationStyle}>
                                {quake.location}
                            </span>
                            <span style={listItemDateStyle}>
                                {quake._dateTime.toLocaleString()}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </MasterPanel>
    );
}
