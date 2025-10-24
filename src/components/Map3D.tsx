import DeckGL from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/mapbox";
import * as d3 from "d3";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const DATA_URL = "/data/earthquakes.json";
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
    const layers = new ScatterplotLayer<EarthquakeData>({
        id: "earthquakes",
        data: DATA_URL,
        radiusUnits: "meters",
        
        getPosition: d => [d.longitude, d.latitude, -d.depth_km * 1000],
        getRadius: 500,
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
            layers={[layers]}
            getTooltip={({object}) => object && (
                `Mag ${object.magnitude} Earthquake\n`+
                `Location: ${object.location}\n`+
                `Depth: ${object.depth} km\n`
            )}
            >
                <Map
                    mapboxAccessToken={MAPBOX_TOKEN}
                    mapStyle="mapbox://styles/mapbox/dark-v11"
                />
            </DeckGL>
    );
}

