import { useCallback } from 'react';
import { MasterPanel } from './MasterPanel';

interface FilterPanelProps {
    dataMinMaxMag: [number, number];
    magnitudeRange: [number, number];
    onMagnitudeRangeChange: (range: [number, number]) => void;
    onClose: () => void;
}

export function FilterPanel({ dataMinMaxMag, magnitudeRange, onMagnitudeRangeChange, onClose }: FilterPanelProps) {
    const handleMinMagChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const newMin = +e.target.value;
        onMagnitudeRangeChange([newMin, Math.max(newMin, magnitudeRange[1])]);
    }, [magnitudeRange, onMagnitudeRangeChange]);

    const handleMaxMagChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const newMax = +e.target.value;
        onMagnitudeRangeChange([Math.min(magnitudeRange[0], newMax), newMax]);
    }, [magnitudeRange, onMagnitudeRangeChange]);

    return (
        <MasterPanel title="Filter by Magnitude" onClose={onClose}>
            {/* Min Magnitude Slider */}
            <div style={{ marginBottom: '10px' }}>
                <label htmlFor="minMag" style={{ display: 'block', marginBottom: '5px' }}>
                    Min: {magnitudeRange[0].toFixed(1)}
                </label>
                <input
                    type="range"
                    id="minMag"
                    min={dataMinMaxMag[0]}
                    max={dataMinMaxMag[1]}
                    step="0.1"
                    value={magnitudeRange[0]}
                    onChange={handleMinMagChange}
                    style={{ width: '100%' }}
                />
            </div>

            {/* Max Magnitude Slider */}
            <div>
                <label htmlFor="maxMag" style={{ display: 'block', marginBottom: '5px' }}>
                    Max: {magnitudeRange[1].toFixed(1)}
                </label>
                <input
                    type="range"
                    id="maxMag"
                    min={dataMinMaxMag[0]}
                    max={dataMinMaxMag[1]}
                    step="0.1"
                    value={magnitudeRange[1]}
                    onChange={handleMaxMagChange}
                    style={{ width: '100%' }}
                />
            </div>
        </MasterPanel>
    );
}
