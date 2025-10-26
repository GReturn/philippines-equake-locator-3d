const monthMap: { [key: string]: number } = {
    'January': 0, 'February': 1, 'March': 2, 'April': 3, 'May': 4, 'June': 5,
    'July': 6, 'August': 7, 'September': 8, 'October': 9, 'November': 10, 'December': 11
};

export const parseCustomDateTime = (datetime: string): Date => {
    // Example: "31 January 2018 - 11:07 PM"
    try {
        const [datePart, timePart] = datetime.split(' - '); // ["31 January 2018", "11:07 PM"]
        
        // Process date part
        const [dayStr, monthName, yearStr] = datePart.split(' '); // ["31", "January", "2018"]
        const day = parseInt(dayStr);
        const month = monthMap[monthName];
        const year = parseInt(yearStr);

        // Process time part
        const [time, ampm] = timePart.split(' '); // ["11:07", "PM"]
        const [hourStr, minuteStr] = time.split(':'); // ["11", "07"]
        let hour = parseInt(hourStr);
        const minute = parseInt(minuteStr);

        // Adjust hour for PM/AM
        if (ampm === 'PM' && hour !== 12) {
            hour += 12;
        }
        if (ampm === 'AM' && hour === 12) {
            hour = 0; // Midnight case
        }

        return new Date(year, month, day, hour, minute);
    } catch (e) {
        console.error("Failed to parse date string:", datetime, e);
        return new Date(0); // Return epoch on failure
    }
};