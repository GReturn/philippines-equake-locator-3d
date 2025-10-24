import { useState, useEffect, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { LineLayer, ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/mapbox";
import * as d3 from "d3";

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

export default function Map3D() {
    const [hoveredHypocenter, setHoverHypocenter] = useState<EarthquakeData | null>(null);
    const [rippleAnimation, setRippleAnimation] = useState({scale: 0, opacity: 0});
    const animationFrameRef = useRef<number>(0);

    // Ripple animation effect
    useEffect(() => {
        if(!hoveredHypocenter) {
            if(animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            setRippleAnimation({scale: 0, opacity: 0});
            return;
        }
        let startTime: number | null = null;
        const animationDuration = 1000;
        const maxScale = 10000;

        const animateRipple = (currentTime: DOMHighResTimeStamp) => {
            if(!startTime) startTime = currentTime;
            const elapsed = currentTime - startTime;
            const progress = (elapsed % animationDuration) / animationDuration;

            const scale = progress * maxScale;
            const opacity = Math.max(0, 1 - progress);
            setRippleAnimation({scale, opacity});
            animationFrameRef.current = requestAnimationFrame(animateRipple);
        };

        animationFrameRef.current = requestAnimationFrame(animateRipple);

        return () => {
            if(animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [hoveredHypocenter]);

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
        billboard: false,
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
        getFillColor: [255, 255, 255, Math.floor(rippleAnimation.opacity * 255)],
        radiusMinPixels: 0,
        radiusMaxPixels: 1000,
        pickable: false,
        billboard: false,
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
        getPosition: d => [d.longitude, d.latitude, 0],
        getRadius: d => Math.pow(2, d.magnitude) * 100,
        
        getFillColor: [255, 255, 255, 255],
        getLineColor: [0, 0, 0, 255],
        getLineWidth: 2,
        lineWidthUnits: "pixels",
        
        radiusMinPixels: 4,

        pickable: false,
        billboard: false,
    });

    return (
        <DeckGL
            initialViewState={{
                longitude: 122,
                latitude: 12.5,
                zoom: 5.5,
                pitch: 50,
                bearing: 0
            }}
            controller={true}
            layers={[scatterLayer, lineLayer, rippleLayer, epicenterCircleLayer]}

            onHover={info => {
                setHoverHypocenter(info.object as EarthquakeData | null);
            }}

            getTooltip={({object}) => object && (
                `Mag ${object.magnitude} Earthquake\n`+
                `Location: ${object.location}\n`+
                `Depth: ${object.depth_km} km\n`+
                `Date: ${object.datetime}\n`+
                `Latitude: ${object.latitude}\n`+
                `Longitude: ${object.longitude}`
            )}
            >
                <Map
                    mapboxAccessToken={MAPBOX_TOKEN}
                    mapStyle="style.json"
                    projection="mercator"
                />
            </DeckGL>
    );
}

