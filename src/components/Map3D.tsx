import { useEffect, useState } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { Map } from "react-map-gl/mapbox";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

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
    const [data, setData] = useState<EarthquakeData[]>([]);

    useEffect(() => {
        fetch("https://raw.githubusercontent.com/GReturn/phivolcs-earthquake-data-scraper/refs/heads/main/data/phivolcs_earthquake_all_years.csv")
        .then((response) => response.text())
        .then((csvText) => {
            const rows = csvText.split("\n").slice(1, 1001); // TODO edit this later when done tweaking shit; should be .slice(1)
            const parsedData: EarthquakeData[] = rows.map((row) => {
                const [id, datetime, latitude, longitude, depth, magnitude, location, month, year] = row.split(",");
                return {
                    id,
                    datetime,
                    latitude: parseFloat(latitude),
                    longitude: parseFloat(longitude),
                    depth: parseFloat(depth),
                    magnitude: parseFloat(magnitude),
                    location,
                    month,
                    year: parseInt(year)
                }
            }).filter((d) => !isNaN(d.latitude) && !isNaN(d.longitude) && !isNaN(d.magnitude));
            setData(parsedData);
        })
    }, []);

    const layers = new ScatterplotLayer({
        id: "earthquakes",
        data,
        getPosition: (d: EarthquakeData) => [d.longitude, d.latitude, -d.depth],
        getRadius: (d: EarthquakeData) => d.magnitude * 100,
        getFillColor: (d: EarthquakeData) => [255, 128 - d.depth, 0, 150],
        radiusMinPixels: 2,
        pickable: true,
    });

    return (
        <DeckGL
            initialViewState={{
                longitude: 122,
                latitude: 12,
                zoom: 4,
                pitch: 40,
                bearing: 0
            }}
            controller={true}
            layers={[layers]}
            >
                <Map
                    mapboxAccessToken={MAPBOX_TOKEN}
                    mapStyle="mapbox://styles/mapbox/dark-v11"
                />
            </DeckGL>
    );
}

