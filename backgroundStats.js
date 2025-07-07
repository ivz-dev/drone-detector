const fs = require("fs");

// Object to store stats for each band
const bandStats = {
  "2.4GHz": { sum: 0, count: 0, avg: 0 },
  "5.8GHz": { sum: 0, count: 0, avg: 0 },
};

function logStatsToFile() {
  const timestamp = new Date().toLocaleString();
  const dateStr = new Date().toISOString().split("T")[0];
  const logFile = `./logs/stats-${dateStr}.log`;
  const logMessage = `[${timestamp}] Avg for 2.4 band: ${bandStats["2.4GHz"].avg.toFixed(1)} by ${bandStats["2.4GHz"].count} samples\n` +
                    `[${timestamp}] Avg for 5.8 band: ${bandStats["5.8GHz"].avg.toFixed(1)} by ${bandStats["5.8GHz"].count} samples\n`;
  try {
    fs.appendFileSync(logFile, logMessage);
  } catch (err) {
    console.error(`Stats log file write error: ${err.message}`);
  }
}

function updateBackgroundStats(bandName, avgPower) {
  if (bandStats[bandName]) {
    bandStats[bandName].sum += avgPower;
    bandStats[bandName].count += 1;
    bandStats[bandName].avg = bandStats[bandName].sum / bandStats[bandName].count;
    logStatsToFile();
  }
}

module.exports = { updateBackgroundStats };