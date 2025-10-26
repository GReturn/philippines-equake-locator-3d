import { } from "@luma.gl/webgl";

import * as d3 from "d3";
import DeckGL from "@deck.gl/react";
import { Map } from "react-map-gl/mapbox";
import { useState, useEffect, useRef } from "react";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { FlyToInterpolator, type MapViewState } from "deck.gl";
import {
    CompassWidget, 
    FullscreenWidget, 
    ZoomWidget 
} from "@deck.gl/widgets"

import '@deck.gl/widgets/stylesheet.css';

import { CustomIconWidget } from "./widgets/CustomIconWidget";
import { IconButtonGroupWidget, type ButtonDefinition } from "./widgets/IconButtonGroupWidget";
import { MasterPanel } from "./MasterPanel"

import "./widgets/widgets.css";

import { parseCustomDateTime } from "../utils/datetime-parser";
import { type EarthquakeData } from "../types/earthquake";
import { INITIAL_VIEW_STATE } from "../constants/map";
import { 
    panelStyle, 
    panelHeaderStyle,
    closeButtonStyle, 
    listItemStyle, 
    listItemDateStyle, 
    listItemLocationStyle,

} from "../styles/earthquakePanelStyles";
import { 
    loadingOverlayStyle,
    spinnerStyle,
    spinnerKeyframes
} from "../styles/loaderStyles";

const PUBLIC_MAPBOX_TOKEN = "pk.eyJ1IjoibGluZHJldyIsImEiOiJjbWg0aGk4emcxajMzcmtzYmxrOGJoN2RmIn0.7iXHqgy1RiWVjzcvKyN-Zg";
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || PUBLIC_MAPBOX_TOKEN;
const DATA_URL = "https://raw.githubusercontent.com/GReturn/phivolcs-earthquake-data-scraper/refs/heads/main/data/earthquakes.json";

const colorScale = d3.scaleSequential([0, -500000], d3.interpolateSpectral)
const DEFAULT_MIN_MAGNITUDE = 4.3;



export default function Map3D() {
    const [hoveredHypocenter, setHoverHypocenter] = useState<EarthquakeData | null>(null);
    const [selectedHypocenter, setSelectedHypocenter] = useState<EarthquakeData | null>(null);
    const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
    
    const [isLoading, setIsLoading] = useState(true);
    const [activePanel, setActivePanel] = useState<"filter" | "history" | "major-quakes" | null>(null); // TODO add more if needed
    const [rippleAnimation, setRippleAnimation] = useState({scale: 0, opacity: 0});
    const animationFrameRef = useRef<number>(0);
    const fullscreenContainerRef = useRef<HTMLDivElement>(null);

    // --- STATES FOR FILTERING ---
    const [data, setData] = useState<EarthquakeData[]>([]);
    const [filteredData, setFilteredData] = useState<EarthquakeData[]>([]);
    const [dataMinMaxMag, setDataMinMaxMag] = useState<[number, number]>([0, 10]);
    const [magnitudeRange, setMagnitudeRange] = useState<[number, number]>([DEFAULT_MIN_MAGNITUDE, 10]);
    const [recentEarthquakes, setRecentEarthquakes] = useState<EarthquakeData[]>([]);
    const [majorEarthquakes, setMajorEarthquakes] = useState<EarthquakeData[]>([]);


    // Fetch earthquake data
    useEffect(() => {
        d3.json<EarthquakeData[]>(DATA_URL).then(fetchedData => {
            if(fetchedData) {
                setData(fetchedData);

                // for magnitude filters
                const magnitudes = fetchedData.map(d => d.magnitude);
                const minMagitude = Math.floor(Math.min(...magnitudes) * 10) / 10;
                const maxMagitude = Math.floor(Math.max(...magnitudes) * 10) / 10;
                
                setDataMinMaxMag([minMagitude, maxMagitude]);
                setMagnitudeRange([Math.min(DEFAULT_MIN_MAGNITUDE, maxMagitude), maxMagitude]);
                
                // for recent quakes
                const sortedData = [...fetchedData].sort((a, b) => 
                    parseCustomDateTime(b.datetime).getTime() - parseCustomDateTime(a.datetime).getTime()
                );
                const recent100 = sortedData.slice(0,100);
                setRecentEarthquakes(recent100);

                // for major quakes
                const majorQuakes = [...fetchedData].sort((a, b) =>
                    b.magnitude - a.magnitude
                );
                const major10 = majorQuakes.slice(0, 30);
                setMajorEarthquakes(major10);
            }
        })
        .catch(err => {
            console.error("Failed to fetch earthquake data:", err);
            alert("Failed to fetch earthquake data. Please reload the site or try again later.");
        })
        .finally(() => {
            setIsLoading(false);
        })
    }, []);
    // For filters
    useEffect(() => {
        const [minMagnitude, maxMagnitude] = magnitudeRange;
        const result = data.filter(d => d.magnitude >= minMagnitude && d.magnitude <= maxMagnitude);
        setFilteredData(result);

        if(selectedHypocenter && !result.find(d => d.id === selectedHypocenter.id)) {
            setSelectedHypocenter(null);
            setHoverHypocenter(null);
        }
    }, [data, magnitudeRange, selectedHypocenter]);
    // Ripple animation effect
    useEffect(() => {
        if(!hoveredHypocenter) {
            if(animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            setRippleAnimation({scale: 0, opacity: 0});
            return;
        }
        let startTime: number | null = null;
        const animationDuration = 2000;
        const maxScale = 50000;

        const animateRipple = (currentTime: DOMHighResTimeStamp) => {
            if(!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            const progress = (elapsed % animationDuration) / animationDuration;
            setRippleAnimation({
                scale: progress * maxScale,
                opacity: Math.max(0, 0.7 - progress * 0.7)
            });
            animationFrameRef.current = requestAnimationFrame(animateRipple);
        };

        animationFrameRef.current = requestAnimationFrame(animateRipple);
        return () => {
            if(animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [hoveredHypocenter]);

    // Scatterplot layer for earthquakes
    const scatterLayer = new ScatterplotLayer<EarthquakeData>({
        id: "earthquakes",
        data: filteredData,
        radiusUnits: "meters",
        
        getPosition: d => [d.longitude, d.latitude, -d.depth_km * 1000],
        getRadius: d => Math.pow(2, d.magnitude) * 100,
        getFillColor: d => {
            const colorString = colorScale(-d.depth_km * 1000);
            const color = d3.rgb(colorString); 
            return [color.r, color.g, color.b];
        },

        radiusMinPixels: 2,
        
        pickable: true,
        autoHighlight: true,
        billboard: true,
    });
    // Line layer for depth lines
    const lineLayer = new LineLayer<EarthquakeData>({
        id: "depth-lines",
        data: hoveredHypocenter ? [hoveredHypocenter] : [],
        
        getSourcePosition: d => [d.longitude, d.latitude, -d.depth_km * 1000],
        getTargetPosition: d => [d.longitude, d.latitude, 0],
        getColor: [255, 255, 255],
        getWidth: 2,
        
        pickable: false,
    });
    // Ripple effect layer
    const rippleLayer = new ScatterplotLayer<EarthquakeData>({
        id: "epicenter-ripple",
        data: hoveredHypocenter ? [hoveredHypocenter] : [],
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
    });
    // Epicenter circle layer
    const epicenterCircleLayer = new ScatterplotLayer<EarthquakeData>({
        id: "epicenter-circle",
        data: hoveredHypocenter ? [hoveredHypocenter] : [],
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

    });
    const layers = [
        scatterLayer,
        lineLayer,
        rippleLayer, 
        epicenterCircleLayer,  // There is a visual anomaly when ripple is animating. By drawing static circle LAST, it's on top, this fixes the issue for the larger magnitude earthquakes :P
    ];
    
    const flyToEarthquake = (equake: EarthquakeData) => {
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
        }))
    };
    const handleMapClick = ({ object }: { object?: EarthquakeData}) => {
        if(object) {
            setSelectedHypocenter(object);
            setHoverHypocenter(object);
            setActivePanel(null);
            flyToEarthquake(object);
        } else {
            setSelectedHypocenter(null);
            setHoverHypocenter(null);
        }
    };
    const handleRecentEarthquakeClick = (quake: EarthquakeData) => {
        let [min, max] = magnitudeRange;
        let rangeChanged = false;

        if(quake.magnitude < min) {
            min = quake.magnitude;
            rangeChanged = true;
        }
        if(quake.magnitude > max) {
            max = quake.magnitude;
            rangeChanged = true;
        }

        if(rangeChanged) setMagnitudeRange([min, max]);

        flyToEarthquake(quake);
        setSelectedHypocenter(quake);
        setHoverHypocenter(quake);
        setActivePanel(null);
    };
    const handleMinMagChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newMin = +e.target.value;
        setMagnitudeRange([newMin, Math.max(newMin, magnitudeRange[1])]);
    }
    const handleMaxMagChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newMax = +e.target.value;
        setMagnitudeRange([Math.min(magnitudeRange[0], newMax), newMax]);
    }
    const handleHistoryClick = () => {
        setActivePanel(prev => prev === "history" ? null : "history");
    };
    const handleFilterClick = () => {
        setActivePanel(prev => prev === "filter" ? null : "filter");
    };
    const handleMajorQuakesClick = () => {
        setActivePanel(prev => prev === "major-quakes" ? null : "major-quakes");
    }
    const handleAboutClick = () => {
        alert('Check historical earthquakes in the Philippine region dating as far back as 2018. Data obtained from PHIVOLCS. Made by Rafael Mendoza.');
    };
    const handleSourceCodeClick = () => {
        open("https://github.com/GReturn/philippines-equake-locator-3d");
    };

    const sourceCodeWidget = new CustomIconWidget({
        id: 'source-code-widget',
        placement: 'bottom-right',
        title: 'Source Code',
        onClick: handleSourceCodeClick,
        iconName: 'code', // for the Google svg icon name: https://fonts.google.com/icons  
        iconClassName: 'deck-widget-icon-button my-custom-widget-button'
    });
    const aboutWidget = new CustomIconWidget({
        id: 'about-widget',
        placement: 'bottom-right',
        title: 'About',
        onClick: handleAboutClick,
        iconName: 'info',
        iconClassName: 'deck-widget-icon-button my-custom-widget-button'
    });
    const customButtons: ButtonDefinition[] = 
    [
        {
            id: 'filter-widget',
            title: 'Add Filters',
            iconName: 'filter_list',
            onClick: handleFilterClick
        },
        {
            id: 'history-widget',
            title: 'Recent 100 Earthquakes',
            iconName: 'list',
            onClick: handleHistoryClick
        },
        {
            id: 'major-quakes-widget',
            title: '30 Major Earthquakes',
            iconName: 'earthquake',
            onClick: handleMajorQuakesClick
        }
    ];
    const customButtonGroup = new IconButtonGroupWidget({
        id: 'my-tools-widget',
        placement: 'top-right',
        orientation: 'vertical',
        buttons: customButtons,
        className: 'my-custom-group'
    });

    const widgets = [
        // new LoadingWidget,
        new ZoomWidget({placement:"top-right"}),
        new CompassWidget({placement:"top-right"}),
        new FullscreenWidget({
            placement:"top-right",
            container: fullscreenContainerRef.current || undefined
        }),
        customButtonGroup,
        aboutWidget,
        sourceCodeWidget
    ];

    return (
        <>
            <style>{spinnerKeyframes}</style>
            <div 
                ref={fullscreenContainerRef} 
                style={{ 
                    position: 'relative', 
                    width: '100vw', 
                    height: '100vh',
                }}
            >
                <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
                    <DeckGL
                        viewState={viewState}
                        onViewStateChange={e => setViewState(e.viewState as MapViewState)}
                        controller
                        layers={layers}
                        widgets={widgets}
                        onHover={info => {
                            if(selectedHypocenter) return;
                            setHoverHypocenter(info.object as EarthquakeData | null);
                        }}
                        onClick={handleMapClick}
                        getTooltip={({object}) => object && (
                            `Mag ${object.magnitude} Earthquake\n`+
                            `- Depth: ${object.depth_km} km`
                        )}
                    >
                        <Map
                            mapboxAccessToken={MAPBOX_TOKEN}
                            mapStyle="style.json"
                            projection="mercator"
                            attributionControl={false}
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

                {/* Details Panel */}
                <div style={{
                    ...panelStyle,
                    transform: selectedHypocenter ? "translateX(0)" : "translateX(-450px)"
                }}>
                    <div style={panelHeaderStyle}>
                        <h3 style={{ margin: 0 }}>Earthquake Details</h3>
                        <button
                            style={closeButtonStyle}
                            onClick={() => {
                                setSelectedHypocenter(null);
                                setHoverHypocenter(null);
                            }}
                        >&times;</button>
                    </div>
                    <div style={{ marginTop: "1rem" }}>
                        <p><strong>Magnitude:</strong> {selectedHypocenter?.magnitude}</p>
                        <p><strong>Location:</strong> {selectedHypocenter?.location}</p>
                        <p><strong>Date:</strong> {selectedHypocenter ? parseCustomDateTime(selectedHypocenter.datetime).toLocaleString() : '' }</p>
                        <p><strong>Depth:</strong> {selectedHypocenter?.depth_km} km</p>
                        <p><strong>Latitude:</strong> {selectedHypocenter?.latitude}</p>
                        <p><strong>Longitude:</strong> {selectedHypocenter?.longitude}</p>
                        <p><strong>ID:</strong> {selectedHypocenter?.id}</p>
                    </div>
                </div>

                {/* Filter Panel */}
                {activePanel === "filter" && (
                    <MasterPanel title="Filter by Magnitude" onClose={() => setActivePanel(null)}>
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
                )}

                {/* History Panel */}
                {activePanel === "history" && (
                    <MasterPanel title="Recent 100 Earthquakes" onClose={() => setActivePanel(null)}>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {recentEarthquakes.map(quake => (
                                <li 
                                    key={quake.id} 
                                    onClick={() => handleRecentEarthquakeClick(quake)}
                                    style={listItemStyle}
                                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#333')}
                                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                                >
                                    <strong>Mag {quake.magnitude}</strong>
                                    <span style={listItemLocationStyle}>
                                        {quake.location}
                                    </span>
                                    <span style={listItemDateStyle}>
                                        { parseCustomDateTime(quake.datetime).toLocaleString() }
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </MasterPanel>
                )}

                {/* Major Quakes Panel */}
                {activePanel === "major-quakes" && (
                    <MasterPanel title="30 Major Earthquakes" onClose={() => setActivePanel(null)}>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {majorEarthquakes.map(quake => (
                                <li 
                                    key={quake.id} 
                                    onClick={() => handleRecentEarthquakeClick(quake)}
                                    style={listItemStyle}
                                    onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#333')}
                                    onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
                                >
                                    <strong>Mag {quake.magnitude}</strong>
                                    <span style={listItemLocationStyle}>
                                        {quake.location}
                                    </span>
                                    <span style={listItemDateStyle}>
                                        { parseCustomDateTime(quake.datetime).toLocaleString() }
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </MasterPanel>
                )}
            </div>
        </>
    );
}
