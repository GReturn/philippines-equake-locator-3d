import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import https from 'https';

const CSV_URL = "https://raw.githubusercontent.com/GReturn/phivolcs-earthquake-data-scraper/refs/heads/main/data/phivolcs_earthquake_all_years.csv";
// const CSV_URL = "https://raw.githubusercontent.com/zekejulia/phivolcs-earthquake-data-scraper/refs/heads/main/data/phivolcs_earthquake_all_years.csv";
const OUTPUT_DIR = path.resolve(process.cwd(), 'public', 'data', 'earthquakes.json');

console.log(`Fetching data from ${CSV_URL}...`);

https.get(CSV_URL, (response) => {
    const { statusCode } = response;
    if (statusCode !== 200) {
        console.error(`Request Failed.\nStatus Code: ${statusCode}`);
        response.resume(); // consume response data to free up memory
        return;
    }
    
    response.setEncoding('utf8');
    let csvData = '';

    // collect data chunks
    response.on('data', (chunk) => {
        csvData += chunk;
    });

    // do everything after the response ends
    response.on('end', () => {
        try {
            console.log("Parsing CSV...");

            const parsedData = Papa.parse(csvData, {
                header: true,
                dynamicTyping: true,
                skipEmptyLines: true
            });

            console.log(`Parsed ${parsedData.data.length} rows.`);

        const processedData = parsedData.data
            .map((row, index) => ({
                id: `${row.Year}-${index}`,
                datetime: row['Date-Time'],
                latitude: row.Latitude,
                longitude: row.Longitude,
                depth_km: row.Depth,
                magnitude: row.Magnitude,
                location: row.Location ? row.Location.replace(/Â/g, '') : '', // theres a weird character Â preceding the degree character symbol, this removes it
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
        }
        catch (e) {
            console.error("Error parsing CSV data:", e.message);
        }
    });
}).on('error', (e) => {
    console.error(`Got error: ${e.message}`);
});