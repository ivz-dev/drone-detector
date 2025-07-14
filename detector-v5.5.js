const { spawn } = require("child_process");
const readline = require("readline");
const blessed = require("blessed");
const contrib = require("blessed-contrib");
const Gpio = require("onoff").Gpio;
const fs = require("fs");

function logToFile(message) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}\n`;
  const dateStr = new Date().toISOString().split("T")[0];
  const logFile = `/home/pi/drone-detector/logs/log-${dateStr}.log`;
  try {
    fs.appendFileSync(logFile, logMessage);
  } catch (err) {
    console.error(`Log file write error: ${err.message}`);
  }
}

logToFile("Script started");

const BANDS = [
  { start: 5625, end: 5850, name: "5.8GHz", threshold: -60.3 },
  // { start: 5625, end: 5850, name: "5.8GHz", threshold: -61.4 },

  //   { start: 2400, end: 2485, name: "2.4GHz", threshold: -40.1 },
  // { start: 3300, end: 3400, name: '3.3GHz', threshold: -57  },
  // { start: 1160, end: 1280, name: '1.2GHz', threshold: -57  },
  // { start: 1280, end: 1320, name: '1.3GHz', threshold: -57  },
];

// Object to store stats for each band
const bandStats = {
  "2.4GHz": { sum: 0, count: 0, avg: 0 },
  "5.8GHz": { sum: 0, count: 0, avg: 0 },
};

function logStatsToFile() {
  const timestamp = new Date().toLocaleString();
  const dateStr = new Date().toISOString().split("T")[0];
  const logFile = `/home/pi/drone-detector/logs/stats-${dateStr}.log`;
  const logMessage = `[${timestamp}] Avg for 2.4 band: ${bandStats["2.4GHz"].avg.toFixed(1)} by ${bandStats["2.4GHz"].count} samples\n` +
                    `[${timestamp}] Avg for 5.8 band: ${bandStats["5.8GHz"].avg.toFixed(1)} by ${bandStats["5.8GHz"].count} samples\n`;
  try {
    fs.writeFileSync(logFile, logMessage); // Overwrite the file instead of appending
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

let ALERT_PIN;
try {
  ALERT_PIN = new Gpio(586, "out");
} catch (err) {
  logToFile(`GPIO init error: ${err.message}`);
  process.exit(1);
}

let screen = blessed.screen();
let line = contrib.line({
  label: "Drone Frequency Power (dBm)",
  showLegend: true,
  minY: -100,
  maxY: 0,
  style: { line: "yellow", text: "green", baseline: "black" },
});
screen.append(line);
screen.key(["escape", "q", "C-c"], () => {
  logToFile("Exiting script");
  if (ALERT_PIN) ALERT_PIN.unexport();
  process.exit(0);
});

function parseLine(line) {
  const parts = line.trim().split(",");
  if (parts.length < 7) return [];
  const freqStart = parseFloat(parts[2]) / 1e6;
  const binWidth = parseFloat(parts[4]) / 1e6;
  const powers = parts.slice(6).map(p => parseFloat(p));
  const freqs = [];
  for (let i = 0; i < powers.length; i++) {
    const freq = freqStart + i * binWidth;
    const power = powers[i];
    if (!isNaN(freq) && !isNaN(power)) freqs.push({ freq, power });
  }
  return freqs;
}

function detect(freqs) {
  const alerts = [];
  BANDS.forEach(({ start, end, name, threshold }) => {
    const inBand = freqs.filter(f => f.freq >= start && f.freq <= end);
    if (inBand.length > 0) {
      const avgPower = inBand.reduce((sum, f) => sum + f.power, 0) / inBand.length;
      logToFile(`Average power for ${name}: ${avgPower.toFixed(1)} dBm`);
      updateBackgroundStats(name, avgPower);
      if (avgPower > threshold) {
        alerts.push({ start, end, name, avgPower: avgPower.toFixed(1) });
      }
    } else {
      logToFile(`No frequencies in ${name}`);
    }
  });
  return alerts;
}

function checkHackrfTemperature() {
  const tempProc = spawn("hackrf_debug", ["--si5351c", "-n", "0", "--read", "1"]);
  tempProc.stdout.on("data", (data) => {
    const output = data.toString();
    const match = output.match(/Value\s*=\s*(\d+)/);
    if (match) {
      const val = parseInt(match[1]);
      const temp = (val - 25) * 0.8; // Approx formula
      logToFile(`HackRF Temp: ~${temp.toFixed(1)} °C`);
    }
  });
  tempProc.stderr.on("data", (err) => {
    logToFile(`Temp read error: ${err.toString()}`);
  });
}

function scanBand(band, callback) {
  const freqRange = `${band.start}:${band.end}`;
  const bandwidth = 2000000;
  const rangeHz = (band.end - band.start) * 1e6;
  const estimatedDuration = Math.min(Math.max(rangeHz / bandwidth * 1000, 1500), 5000);

  const hackrf = spawn("hackrf_sweep", ["-f", freqRange, "-w", bandwidth.toString(), "-l", "24", "-g", "20"]);

  const rl = readline.createInterface({ input: hackrf.stdout });
  const freqs = [];
  rl.on("line", line => freqs.push(...parseLine(line)));

  hackrf.on("close", () => callback(freqs));
  hackrf.on("error", err => {
    logToFile(`hackrf_sweep error: ${err.message}`);
    callback([]);
  });

  setTimeout(() => {
    hackrf.kill();
    logToFile(`hackrf_sweep for ${band.name} timed out`);
  }, estimatedDuration);
}

let bandIndex = 0;
let paused = false;

function runSweep() {
  if (paused) return;

  checkHackrfTemperature();
  let allFreqs = [];

  function scanNextBand() {
    if (paused) return;

    if (bandIndex >= BANDS.length) {
      bandIndex = 0;
      const now = new Date().toLocaleTimeString();
      const sorted = allFreqs.sort((a, b) => a.freq - b.freq);
      const MAX_POINTS = 100;
      const step = Math.max(1, Math.floor(sorted.length / MAX_POINTS));
      const reduced = sorted.filter((_, i) => i % step === 0);
      const x = reduced.map(p => p.freq.toFixed(2));
      const y = reduced.map(p => p.power);

      if (x.length > 0 && y.length > 0) {
        line.setData([{ title: "Power", x, y }]);
      }

      const alerts = detect(sorted);
      if (alerts.length > 0) {
        ALERT_PIN.writeSync(1);
        paused = true;
        alerts.forEach(({ name, avgPower }) => logToFile(`🛸 Drone detected in ${name} (${avgPower} dBm)`));

        setTimeout(() => {
          ALERT_PIN.writeSync(0);
          paused = false;
          runSweep();
        }, 10000);
      } else {
        logToFile(`[${now}] No suspicious activity.`);
        setTimeout(runSweep, 2000);
      }

      screen.render();
      return;
    }

    const band = BANDS[bandIndex];
    logToFile(`Scanning ${band.name} (${bandIndex + 1}/${BANDS.length})`);
    scanBand(band, (freqs) => {
      allFreqs = allFreqs.concat(freqs);
      bandIndex++;
      scanNextBand();
    });
  }

  scanNextBand();
}

runSweep();