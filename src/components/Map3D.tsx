import DeckGL from "@deck.gl/react";
import { Map } from "react-map-gl/mapbox";
import { useState, useRef, useMemo, useCallback } from "react";
import { LineLayer, ScatterplotLayer, type ScatterplotLayerProps } from "@deck.gl/layers";
import { MapController, type MapViewState, type PickingInfo } from "deck.gl";
import { DataFilterExtension } from '@deck.gl/extensions'
import {
    CompassWidget,
    FullscreenWidget,
    ZoomWidget
} from "@deck.gl/widgets"

import '@deck.gl/widgets/stylesheet.css';

import { CustomIconWidget } from "./widgets/CustomIconWidget";
import { IconButtonGroupWidget, type ButtonDefinition } from "./widgets/IconButtonGroupWidget";
import { MasterPanel } from "./MasterPanel"
import { EarthquakeDetailsPanel } from "./EarthquakeDetailsPanel";
import { FilterPanel } from "./FilterPanel";
import { EarthquakeListPanel } from "./EarthquakeListPanel";

import "./widgets/widgets.css";
import "../styles/loader.css";

import { useEarthquakeData } from "../hooks/useEarthquakeData";
import { useRippleAnimation } from "../hooks/useRippleAnimation";
import { useMapNavigation } from "../hooks/useMapNavigation";
import { type ProcessedEarthquakeData } from "../types/processed-earthquake";
import {
    loadingOverlayStyle,
    spinnerStyle,
} from "../styles/loaderStyles";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

// Stateless extension — safe to hoist to module scope
const dataFilterExtension = new DataFilterExtension({ filterSize: 1 });

// for the scatterplot's extended props
type ExtendedProps = ScatterplotLayerProps<ProcessedEarthquakeData> & {
    getFilterValue: (d: ProcessedEarthquakeData) => number;
    filterRange: [number, number];
};

export default function Map3D() {
    const [hoveredHypocenter, setHoverHypocenter] = useState<ProcessedEarthquakeData | null>(null);
    const [selectedHypocenter, setSelectedHypocenter] = useState<ProcessedEarthquakeData | null>(null);
    const [activePanel, setActivePanel] = useState<"filter" | "history" | "major-quakes" | "about" | null>(null);
    const fullscreenContainerRef = useRef<HTMLDivElement>(null);

    // Custom hooks
    const {
        data, isLoading, error,
        dataMinMaxMag, magnitudeRange, setMagnitudeRange,
        recentEarthquakes, majorEarthquakes
    } = useEarthquakeData();

    const { viewState, setViewState, flyToEarthquake } = useMapNavigation();
    const rippleAnimation = useRippleAnimation(!!hoveredHypocenter);

    // --- Event handlers ---
    const handleMapClick = useCallback(({ object }: { object?: ProcessedEarthquakeData }) => {
        if (object) {
            setSelectedHypocenter(object);
            setHoverHypocenter(object);
            setActivePanel(null);
            flyToEarthquake(object);
        } else {
            setSelectedHypocenter(null);
            setHoverHypocenter(null);
        }
    }, [flyToEarthquake]);
    
    const handleEarthquakeSelect = useCallback((quake: ProcessedEarthquakeData) => {
        let [min, max] = magnitudeRange;
        let rangeChanged = false;

        if (quake.magnitude < min) {
            min = quake.magnitude;
            rangeChanged = true;
        }
        if (quake.magnitude > max) {
            max = quake.magnitude;
            rangeChanged = true;
        }
        if (rangeChanged) setMagnitudeRange([min, max]);

        flyToEarthquake(quake);
        setSelectedHypocenter(quake);
        setHoverHypocenter(quake);
        setActivePanel(null);
    }, [magnitudeRange, flyToEarthquake, setMagnitudeRange]);

    const handleHover = useCallback((info: { object?: ProcessedEarthquakeData | null }) => {
        if (selectedHypocenter) return;
        setHoverHypocenter(info.object || null);
    }, [selectedHypocenter]);

    const handleGetTooltip = useCallback(({ object }: PickingInfo) => {
        const data = object as ProcessedEarthquakeData | null;
        if (data) return `Mag ${data.magnitude} Earthquake\n- Depth: ${data.depth_km} km`
        return null;
    }, []);

    const handleCloseDetailsPanel = useCallback(() => {
        setSelectedHypocenter(null);
        setHoverHypocenter(null);
    }, []);

    const handleHistoryClick = useCallback(() => {
        setActivePanel(prev => prev === "history" ? null : "history");
    }, []);
    const handleFilterClick = useCallback(() => {
        setActivePanel(prev => prev === "filter" ? null : "filter");
    }, []);
    const handleMajorQuakesClick = useCallback(() => {
        setActivePanel(prev => prev === "major-quakes" ? null : "major-quakes");
    }, []);
    const handleAboutClick = useCallback(() => {
        setActivePanel(prev => prev === "about" ? null : "about");
    }, []);
    const handleSourceCodeClick = useCallback(() => {
        window.open("https://github.com/GReturn/philippines-equake-locator-3d");
    }, []);

    // --- Layers ---
    const hoveredData = useMemo(() => {
        return hoveredHypocenter ? [hoveredHypocenter] : [];
    }, [hoveredHypocenter]);

    const scatterLayer = useMemo(() => {
        const layerProps: ExtendedProps = {
            id: "earthquakes",
            data: data,
            extensions: [dataFilterExtension],
            getFilterValue: (d: ProcessedEarthquakeData) => d.magnitude,
            filterRange: magnitudeRange,
            radiusUnits: "meters",
            getPosition: (d: ProcessedEarthquakeData) => [d.longitude, d.latitude, -d.depth_km * 1000],
            getRadius: (d: ProcessedEarthquakeData) => Math.pow(2, d.magnitude) * 100,
            getFillColor: (d: ProcessedEarthquakeData) => d._color,
            radiusMinPixels: 2,
            stroked: false,
            pickable: true,
            autoHighlight: true,
            billboard: true,
            updateTriggers: {
                getFilterValue: [magnitudeRange]
            }
        };
        return new ScatterplotLayer(layerProps);
    }, [data, magnitudeRange]);

    const lineLayer = useMemo(() => new LineLayer<ProcessedEarthquakeData>({
        id: "depth-lines",
        data: hoveredData,
        getSourcePosition: d => [d.longitude, d.latitude, -d.depth_km * 1000],
        getTargetPosition: d => [d.longitude, d.latitude, 0],
        getColor: [255, 255, 255],
        getWidth: 2,
        pickable: false,
    }), [hoveredData]);

    const rippleLayer = useMemo(() => new ScatterplotLayer<ProcessedEarthquakeData>({
        id: "epicenter-ripple",
        data: hoveredData,
        radiusUnits: "meters",
        getPosition: d => [d.longitude, d.latitude, -d.depth_km * 1000],
        getRadius: () => rippleAnimation.scale,
        getFillColor: [255, 255, 255, Math.floor(rippleAnimation.opacity * 128)],
        radiusMinPixels: 0,
        radiusMaxPixels: 50000,
        pickable: false,
        billboard: true,
        updateTriggers: {
            getRadius: [rippleAnimation.scale],
            getFillColor: [rippleAnimation.opacity]
        }
    }), [hoveredData, rippleAnimation]);

    const epicenterCircleLayer = useMemo(() => new ScatterplotLayer<ProcessedEarthquakeData>({
        id: "epicenter-circle",
        data: hoveredData,
        radiusUnits: "meters",
        lineWidthUnits: "pixels",
        getPosition: d => [d.longitude, d.latitude, 1],
        getRadius: 500,
        getFillColor: [255, 255, 255, 128],
        getLineColor: [0, 0, 0, 255],
        getLineWidth: 2,
        radiusMinPixels: 4,
        pickable: false,
        billboard: true,
    }), [hoveredData]);

    // Draw static circle LAST so it's on top when ripple is animating
    const layers = useMemo(() => [
        scatterLayer,
        lineLayer,
        rippleLayer,
        epicenterCircleLayer,
    ], [scatterLayer, lineLayer, rippleLayer, epicenterCircleLayer]);

    // --- Widgets ---
    const sourceCodeWidget = useMemo(() => new CustomIconWidget({
        id: 'source-code-widget',
        placement: 'bottom-right',
        title: 'Source Code',
        onClick: handleSourceCodeClick,
        iconName: 'code',
        iconClassName: 'deck-widget-icon-button my-custom-widget-button'
    }), [handleSourceCodeClick]);

    const aboutWidget = useMemo(() => new CustomIconWidget({
        id: 'about-widget',
        placement: 'bottom-right',
        title: 'About',
        onClick: handleAboutClick,
        iconName: 'info',
        iconClassName: 'deck-widget-icon-button my-custom-widget-button'
    }), [handleAboutClick]);

    const customButtons: ButtonDefinition[] = useMemo(() => [
        { id: 'filter-widget', title: 'Add Filters', iconName: 'filter_list', onClick: handleFilterClick },
        { id: 'history-widget', title: 'Recent 100 Earthquakes', iconName: 'list', onClick: handleHistoryClick },
        { id: 'major-quakes-widget', title: '30 Major Earthquakes', iconName: 'earthquake', onClick: handleMajorQuakesClick },
    ], [handleFilterClick, handleHistoryClick, handleMajorQuakesClick]);

    const customButtonGroup = useMemo(() => new IconButtonGroupWidget({
        id: 'my-tools-widget',
        placement: 'top-right',
        orientation: 'vertical',
        buttons: customButtons,
        className: 'my-custom-group'
    }), [customButtons]);

    const fullscreenContainer = fullscreenContainerRef.current;
    const widgets = useMemo(() => [
        new ZoomWidget({ placement: "top-right" }),
        new CompassWidget({ placement: "top-right" }),
        new FullscreenWidget({
            placement: "top-right",
            container: fullscreenContainer || undefined
        }),
        customButtonGroup,
        aboutWidget,
        sourceCodeWidget
    ], [fullscreenContainer, aboutWidget, customButtonGroup, sourceCodeWidget]);

    // --- Render ---
    return (
        <div
            ref={fullscreenContainerRef}
            style={{ position: 'relative', width: '100vw', height: '100vh' }}
        >
            <div
                style={{ position: 'relative', width: '100vw', height: '100vh' }}
                onContextMenu={(e) => e.preventDefault()}
            >
                <DeckGL
                    viewState={viewState}
                    onViewStateChange={e => setViewState(e.viewState as MapViewState)}
                    controller={{ type: MapController, touchRotate: true }}
                    layers={layers}
                    widgets={widgets}
                    onHover={handleHover}
                    onClick={handleMapClick}
                    getTooltip={handleGetTooltip}
                >
                    <Map
                        mapboxAccessToken={MAPBOX_TOKEN}
                        mapStyle="style.json"
                        projection="mercator"
                        attributionControl={false}
                        interactive
                    >
                    </Map>
                </DeckGL>
            </div>

            {/* Loading Spinner */}
            {isLoading && (
                <div style={loadingOverlayStyle}>
                    <div style={spinnerStyle}></div>
                </div>
            )}

            {/* Error State */}
            {error && (
                <div style={loadingOverlayStyle}>
                    <div style={{ color: '#ff6b6b', fontSize: '1.2rem', textAlign: 'center', padding: '2rem' }}>
                        <p style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⚠️</p>
                        <p>{error}</p>
                    </div>
                </div>
            )}

            {/* Details Panel */}
            <EarthquakeDetailsPanel
                earthquake={selectedHypocenter}
                onClose={handleCloseDetailsPanel}
            />

            {/* Filter Panel */}
            {activePanel === "filter" && (
                <FilterPanel
                    dataMinMaxMag={dataMinMaxMag}
                    magnitudeRange={magnitudeRange}
                    onMagnitudeRangeChange={setMagnitudeRange}
                    onClose={() => setActivePanel(null)}
                />
            )}

            {/* History Panel */}
            {activePanel === "history" && (
                <EarthquakeListPanel
                    title="Recent 100 Earthquakes"
                    earthquakes={recentEarthquakes}
                    onSelect={handleEarthquakeSelect}
                    onClose={() => setActivePanel(null)}
                />
            )}

            {/* Major Quakes Panel */}
            {activePanel === "major-quakes" && (
                <EarthquakeListPanel
                    title="30 Major Earthquakes"
                    earthquakes={majorEarthquakes}
                    onSelect={handleEarthquakeSelect}
                    onClose={() => setActivePanel(null)}
                />
            )}

            {/* About Panel */}
            {activePanel === "about" && (
                <MasterPanel title="About" onClose={() => setActivePanel(null)}>
                    <p>Check historical earthquakes in the Philippine region dating as far back as 2018.</p>
                    <p>Data obtained from <strong>PHIVOLCS</strong>. Refreshed every day at 10 AM PHT / UTC+8.</p>
                    <p style={{ color: '#aaa', fontSize: '0.85rem', marginTop: '1rem' }}>Made by Rafael Mendoza.</p>
                </MasterPanel>
            )}
        </div>
    );
}
