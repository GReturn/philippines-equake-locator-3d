import DeckGL from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/mapbox";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const DATA_URL = "/data/earthquakes.json";

interface EarthquakeData {
    id: string;
    datetime: string;
    latitude: number;
    longitude: number;
    depth: number;
    magnitude: number;
    location: string;
    month: string;
    year: number;
}

export default function Map3D() {
    // TODO change the visuals
    const layers = new ScatterplotLayer<EarthquakeData>({
        id: "earthquakes",
        data: DATA_URL,
        getPosition: d => [d.longitude, d.latitude, -d.depth * 1000],
        getRadius: d => Math.pow(1.5, d.magnitude) * 100,
        getFillColor: d => [255, 255 - d.depth * 2, 0, 180],
        radiusMinPixels: 2,
        radiusMaxPixels: 20,
        pickable: true,
        autoHighlight: true,
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

