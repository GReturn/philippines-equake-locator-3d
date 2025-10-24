import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

const CSV_URL = "https://raw.githubusercontent.com/zekejulia/phivolcs-earthquake-data-scraper/refs/heads/main/data/phivolcs_earthquake_all_years.csv";
const OUTPUT_DIR = path.resolve(process.cwd(), 'public', 'data', 'earthquakes.json');

console.log(`Fetching data from ${CSV_URL}...`);

fetch(CSV_URL)
    .then(response => {
        if (!response.ok) {
            throw new Error(`Network response was not ok: ${response.statusText}`);
        }
        return response.text();
    })
    .then(csvData => {
        console.log("Parsing CSV...");

        const parsedData = Papa.parse(csvData, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true
        });
        console.log(`Parsed ${parsedData.data.length} rows.`);

        const processedData = parsedData.data
            .map((row) => ({
                datetime: row['Date-Time'],
                latitude: row.Latitude,
                longitude: row.Longitude,
                depth_km: row.Depth,
                magnitude: row.Magnitude,
                location: row.Location,
                month: row.Month,
                year: row.Year
            }))
            .filter(d =>
                d.latitude !== null && !isNaN(d.latitude) &&
                d.longitude !== null && !isNaN(d.longitude) &&
                d.magnitude !== null && !isNaN(d.magnitude)
            );
            
        console.log(`Processed ${processedData.length} valid earthquake records.`);

        console.log(`Writing processed data to ${OUTPUT_DIR}...`);
        fs.writeFileSync(OUTPUT_DIR, JSON.stringify(processedData, null, 2));
        console.log("Data processing complete.");
    })
    .catch(error => {
        console.error("Error fetching or processing data:", error);
});
