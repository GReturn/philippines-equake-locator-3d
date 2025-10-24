import DeckGL from "@deck.gl/react";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { FlyToInterpolator } from "deck.gl";
import { type MapViewState }  from "deck.gl";

import { Map } from "react-map-gl/mapbox";
import * as d3 from "d3";
import { useState, useEffect, useRef } from "react";

const PUBLIC_MAPBOX_TOKEN = "pk.eyJ1IjoibGluZHJldyIsImEiOiJjbWg0aGk4emcxajMzcmtzYmxrOGJoN2RmIn0.7iXHqgy1RiWVjzcvKyN-Zg";
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || PUBLIC_MAPBOX_TOKEN;
const DATA_URL = "data/earthquakes.json";
const colorScale = d3.scaleSequential([0, -500000], d3.interpolateSpectral)

interface EarthquakeData {
    id: string;
    datetime: string;
    latitude: number;
    longitude: number;
    depth_km: number;
    magnitude: number;
    location: string;
    month: string;
    year: number;
}

const INITIAL_VIEW_STATE = {
    longitude: 122,
    latitude: 12.5,
    zoom: 5.5,
    pitch: 50,
    bearing: 0
};

const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: 10,
    left: 10,
    width: "250px",
    height: "100%",
    padding: "1rem",
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    boxShadow: "-2px 0 8px rgba(0, 0, 0, 0.3)",
    boxSizing: "border-box",
    borderRadius: "5px",
    fontFamily: "Arial, sans-serif",
    fontSize: "14px",
    zIndex: 1000,
    transition: "transform 0.3s ease-in-out",
    overflowY: "auto"
};

const panelHeaderStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid #ccc",
    paddingBottom: "0.5rem",
};

const closeButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    fontSize: "1.5rem",
    cursor: "pointer",
    padding: "0 0.5rem",
};    

export default function Map3D() {
    const [hoveredHypocenter, setHoverHypocenter] = useState<EarthquakeData | null>(null);
    const [selectedHypocenter, setSelectedHypocenter] = useState<EarthquakeData | null>(null);
    const [rippleAnimation, setRippleAnimation] = useState({scale: 0, opacity: 0});
    // const [data, setData] = useState<EarthquakeData[]>([]);
    const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
    const animationFrameRef = useRef<number>(0);

    // Fetch earthquake data
    // useEffect(() => {
    //     d3.json<EarthquakeData[]>(DATA_URL).then(fetchedData => {
    //         if(fetchedData) {
    //             setData(fetchedData);
    //         }
    //     });
    // }, []);

    // Ripple animation effect
    useEffect(() => {
        if(!hoveredHypocenter) {
            if(animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            setRippleAnimation({scale: 0, opacity: 0});
            return;
        }
        let startTime: number | null = null;
        const animationDuration = 1000;
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

    // Click handler
    const handleMapClick = ({ object }: { object?: EarthquakeData}) => {
        if(object) {
            setSelectedHypocenter(object);

            const pitch = 60;
            const pitchRadians = (pitch * Math.PI) / 180;
            const depthMeters = object.depth_km * 1000;
            
            // Convert the meter offset to a change in latitude
            // ~111,139 meters per degree of latitude
            // https://www.thoughtco.com/degree-of-latitude-and-longitude-distance-4070616
            const meterOffset = depthMeters * Math.tan(pitchRadians);
            const metersPerDegreeLatitude = 111321;
            const deltaLatitude = meterOffset / metersPerDegreeLatitude;
            
            const targetLatitude = object.latitude - deltaLatitude;

            setViewState(current => ({
                ...current,
                longitude: object.longitude,
                latitude: targetLatitude,
                zoom: 9,
                pitch: 60,
                bearing: 0,
                transitionInterpolator: new FlyToInterpolator({ speed: 1.5 }),
                transitionDuration: 2000
            }));
        } else {
            setSelectedHypocenter(null);
        }
    };

    // Scatterplot layer for earthquakes
    const scatterLayer = new ScatterplotLayer<EarthquakeData>({
        id: "earthquakes",
        data: DATA_URL,
        radiusUnits: "meters",
        
        getPosition: d => [d.longitude, d.latitude, -d.depth_km * 1000],
        getRadius: d => Math.pow(2, d.magnitude) * 100,
        // getRadius: 500,
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
        radiusMaxPixels: 20000,
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
        // getRadius: d => Math.pow(2, d.magnitude) * 100,
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

    return (
        <>
        <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={e => setViewState(e.viewState as MapViewState)}
                controller={true}
                layers={layers}

                onHover={info => {
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
                    />
                </DeckGL>
            </div>

            <div style={{
                ...panelStyle,
                transform: selectedHypocenter ? "translateX(0)" : "translateX(-260px)"
            }}>
                <div style={panelHeaderStyle}>
                    <h3 style={{ margin: 0 }}>Earthquake Details</h3>
                    <button
                        style={closeButtonStyle}
                        onClick={() => setSelectedHypocenter(null)}
                    >×</button>
                </div>
                <div style={{ marginTop: "1rem" }}>
                    <p><strong>Magnitude:</strong> {selectedHypocenter?.magnitude}</p>
                    <p><strong>Location:</strong> {selectedHypocenter?.location}</p>
                    <p><strong>Date:</strong> {selectedHypocenter?.datetime}</p>
                    <p><strong>Depth:</strong> {selectedHypocenter?.depth_km}</p>
                    <p><strong>Latitude:</strong> {selectedHypocenter?.latitude}</p>
                    <p><strong>Longitude:</strong> {selectedHypocenter?.longitude}</p>
                    <p><strong>ID:</strong> {selectedHypocenter?.id}</p>
                </div>
            </div>
        </>
    );
}
