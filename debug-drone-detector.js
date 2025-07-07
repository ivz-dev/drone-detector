const { spawn } = require("child_process");
const readline = require("readline");
const blessed = require("blessed");
const contrib = require("blessed-contrib");
const Gpio = require("onoff").Gpio;
const fs = require("fs");

// --- Функция для записи логов в файл
function logToFile(message) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync("debug.log", logMessage, (err) => {
    if (err) console.error("Ошибка записи в файл:", err);
  });
}

// Тестовое сообщение при старте
// logToFile("Script started");

// --- Частотные диапазоны
const BANDS = [
  { start: 2400, end: 2485, name: "2.4GHz", threshold: -59.8 }, 
  // { start: 5625, end: 5850, name: "5.8GHz", threshold: -60.6 }, 
  { start: 5625, end: 5850, name: "5.8GHz", threshold: -60.4 }, 
  // { start: 902, end: 928, name: "900MHz", threshold: -60.4  },
  // { start: 1280, end: 1320, name: "1.3GHz", threshold: -60.5   },
  // { start: 3300, end: 3400, name: "3.3GHz", threshold: -60.5  },
  // { start: 1160, end: 1280, name: "1.2GHz", threshold: -60.5 },
];

// --- GPIO настройка
const ALERT_PIN = new Gpio(586, "out");

// --- UI: график
const screen = blessed.screen();
const line = contrib.line({
  label: "Drone Frequency Power (dBm)",
  showLegend: true,
  minY: -100,
  maxY: 0,
  wholeNumbersOnly: false,
  style: { line: "yellow", text: "green", baseline: "black" },
});
screen.append(line);
screen.key(["escape", "q", "C-c"], () => {
  // logToFile("Exiting script");
  console.log('Exiting script')
  ALERT_PIN.unexport();
  process.exit(0);
});
screen.render();

function parseLine(line) {
   const parts = line.trim().split(",");
  if (parts.length < 7) {
    // logToFile(`Invalid line format, parts: ${parts.length}`);
    return [];
  }

  const freqStart = parseFloat(parts[2]) / 1e6;
  const binWidth = parseFloat(parts[4]) / 1e6;
  const powers = parts.slice(6).map((p) => parseFloat(p));

  const freqs = [];
  for (let i = 0; i < powers.length; i++) {
    const freq = freqStart + i * binWidth;
    const power = powers[i];
    if (!isNaN(freq) && !isNaN(power)) {
      freqs.push({ freq, power });
    } else {
      // logToFile(`Invalid freq or power at index ${i}: freq=${freq}, power=${power}`);
    }
  }
  return freqs;
}


function detect(freqs) {
  const alerts = [];
  BANDS.forEach(({ start, end, name, threshold }) => {
    const inBand = freqs.filter((f) => f.freq >= start && f.freq <= end);
    // logToFile(`Band ${name} (${start}-${end} MHz)`);
    if (inBand.length > 0) {
      const avgPower = inBand.reduce((sum, f) => sum + f.power, 0) / inBand.length;
      logToFile(`Average power for ${name}: ${avgPower.toFixed(1)} dBm`);
      if (avgPower > threshold) {
        alerts.push({ start, end, name, avgPower: avgPower.toFixed(1) });
      } else {
        // logToFile(`No alert for ${name}: avgPower ${avgPower.toFixed(1)} dBm <= ${threshold} dBm`);
      }
    } else {
      // logToFile(`No frequencies in band ${name} (${start}-${end} MHz)`);
    }
  });
  return alerts;
}

function scanBand(band, callback) {
  const freqRange = `${band.start}:${band.end}`;
  // logToFile(`Starting hackrf_sweep for band: ${band.name} (${freqRange} MHz)`);
  const hackrf = spawn("hackrf_sweep", [
    "-f",
    freqRange,
    "-w",
    "2000000", // Уменьшили ширину бина до 2 МГц
    "-l",
    "24",
    "-g",
    "20",
    // "-N",
    // "1000"
    // Убрали -N, чтобы избежать непрерывного режима
  ]);

  hackrf.stderr.on("data", (data) => {
    // logToFile(`hackrf_sweep stderr: ${data.toString()}`);
  });


  const rl = readline.createInterface({ input: hackrf.stdout });
  const freqs = [];

  rl.on("line", (line) => {
    const parsed = parseLine(line);
    freqs.push(...parsed);
  });

  hackrf.on("close", (code) => {
    // logToFile(`hackrf_sweep closed with code: ${code}`);
    callback(freqs);
  });

  hackrf.on("error", (err) => {
    // logToFile(`hackrf_sweep process error: ${err.message}`);
    callback([]);
  });

  // Принудительно завершаем процесс через 5 секунд, чтобы избежать зависания
  setTimeout(() => {
    hackrf.kill();
    // logToFile(`hackrf_sweep for band ${band.name} timed out and was killed`);
  }, 1000);
}

function runSweep() {
  // logToFile("Starting new sweep cycle");
  let allFreqs = [];
  let bandIndex = 0;

  function scanNextBand() {
    if (bandIndex >= BANDS.length) {
      const now = new Date().toLocaleTimeString();
      // logToFile(`All bands scanned, total frequencies: ${allFreqs.length}`);
      const sorted = allFreqs.sort((a, b) => a.freq - b.freq);
      const x = sorted.map((p) => p.freq.toFixed(2));
      const y = sorted.map((p) => p.power);
   
      if (x.length > 0 && y.length > 0) {
               line.setData([
          {
            title: "Power",
            x: x,
            y: y,
          },
        ]);
      } else {
        // logToFile("No data to set for graph");
      }

      const alerts = detect(sorted);
      if (alerts.length > 0) {
        // logToFile("Activating ALERT_PIN");
        ALERT_PIN.writeSync(1);
        alerts.forEach(({ start, end, name, avgPower }) => {
          logToFile(
            `[${now}] 🛸 Дрон у диапазоне ${name} (${start}–${end} MHz). Мощность: ${avgPower} dB`
          );
          console.log(
            `[${now}] 🛸 Дрон у диапазоне ${name} (${start}–${end} MHz). Мощность: ${avgPower} dB`
          );
        });
        setTimeout(() => {
          // logToFile("Deactivating ALERT_PIN");
          ALERT_PIN.writeSync(0);
        }, 3000);
      } else {
        // logToFile(`[${now}] OK — ничего подозрительного`);
      }

      screen.render();
      setTimeout(runSweep, 100);
      return;
    }

    const band = BANDS[bandIndex];
    // logToFile(`Processing band ${band.name} (${bandIndex + 1}/${BANDS.length}). Threshhold ${band.threshold}`);
    scanBand(band, (freqs) => {
      allFreqs = allFreqs.concat(freqs);
      bandIndex++;
      scanNextBand();
    });
  }

  scanNextBand();
}

runSweep();