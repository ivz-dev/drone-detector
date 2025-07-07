const { spawn } = require("child_process");
const readline = require("readline");
const blessed = require("blessed");
const contrib = require("blessed-contrib");
const Gpio = require("onoff").Gpio;
const fs = require("fs");

// Функция для записи логов в файл
function logToFile(message) {
  const timestamp = new Date().toLocaleString();
  const logMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync("debug.log", logMessage, (err) => {
    if (err) console.error("Ошибка записи в файл:", err);
  });
}

// Частотные диапазоны
const BANDS = [
  { start: 2400, end: 2485, name: "2.4GHz", threshold: -65 },
  { start: 5625, end: 5850, name: "5.8GHz", threshold: -70 },
];

// GPIO настройка
let ALERT_PIN;
try {
  ALERT_PIN = new Gpio(586, "out");
} catch (err) {
  console.error(`Ошибка инициализации GPIO 586: ${err.message}`);
  process.exit(1);
}

// UI: график
const screen = blessed.screen();
const line = contrib.line({
  label: "Drone Frequency Power (dBm)",
  showLegend: true,
  minY: -100,
  maxY: 0,
  style: { line: "yellow", text: "green", baseline: "black" },
});
screen.append(line);
screen.key(["escape", "q", "C-c"], () => {
  if (ALERT_PIN) ALERT_PIN.unexport();
  process.exit(0);
});
screen.render();

function parseLine(line) {
  const parts = line.trim().split(",");
  if (parts.length < 7) return [];
  const freqStart = parseFloat(parts[2]) / 1e6;
  const binWidth = parseFloat(parts[4]) / 1e6;
  const powers = parts.slice(6).map((p) => parseFloat(p));
  const freqs = [];
  for (let i = 0; i < powers.length; i++) {
    const freq = freqStart + i * binWidth;
    const power = powers[i];
    if (!isNaN(freq) && !isNaN(power)) {
      freqs.push({ freq, power });
    }
  }
  return freqs;
}

function detect(freqs) {
  const alerts = [];
  const now = new Date().toLocaleString();
  BANDS.forEach(({ start, end, name }) => {
    const inBand = freqs.filter((f) => f.freq >= start && f.freq <= end);
    if (inBand.length > 0) {
      const avgPower =
        inBand.reduce((sum, f) => sum + f.power, 0) / inBand.length;
      const peaks = [];
      for (let i = 2; i < inBand.length - 2; i++) {
        const localAvg =
          (inBand[i - 2].power +
            inBand[i - 1].power +
            inBand[i + 1].power +
            inBand[i + 2].power) /
          4;
        if (inBand[i].power > localAvg + 10) {
          peaks.push(inBand[i].freq);
        }
      }
      logToFile(
        `[${now}] Band ${name}: Avg power ${avgPower.toFixed(1)} dBm${
          peaks.length > 0
            ? `, Peaks: ${peaks.map((f) => f.toFixed(1)).join(", ")} MHz`
            : ""
        }`
      );
      if (peaks.length >= 3) {
        alerts.push({ name, peaks });
      }
    }
  });
  return alerts;
}

function scanBand(band, callback) {
  const freqRange = `${band.start}:${band.end}`;
  const hackrf = spawn("hackrf_sweep", [
    "-f",
    freqRange,
    "-w",
    "2000000",
    "-l",
    "24",
    "-g",
    "20",
  ]);

  const rl = readline.createInterface({ input: hackrf.stdout });
  const freqs = [];

  rl.on("line", (line) => {
    const parsed = parseLine(line);
    freqs.push(...parsed);
  });

  hackrf.on("close", () => {
    callback(freqs);
  });

  setTimeout(() => {
    hackrf.kill();
  }, 1000);
}

function runSweep() {
  let allFreqs = [];
  let bandIndex = 0;

  function scanNextBand() {
    if (bandIndex >= BANDS.length) {
      const sorted = allFreqs.sort((a, b) => a.freq - b.freq);
      const x = sorted.map((p) => p.freq.toFixed(2));
      const y = sorted.map((p) => p.power);

      if (x.length > 0 && y.length > 0) {
        line.setData([{ title: "Power", x, y }]);
      }

      const alerts = detect(sorted);
      if (alerts.length > 0) {
        const now = new Date().toLocaleTimeString();

        logToFile("Activating ALERT_PIN");
        ALERT_PIN.writeSync(1);
        logToFile(
          `[${now}] 🛸 Дрон Мощность: ${avgPower} dB`
        );
        console.log(
          `[${now}] 🛸 Дрон Мощность: ${avgPower} dB`
        );
        setTimeout(() => {
          logToFile("Deactivating ALERT_PIN");

          ALERT_PIN.writeSync(0);
        }, 2000);
      }

      screen.render();
      setTimeout(runSweep, 100);
      return;
    }

    const band = BANDS[bandIndex];
    scanBand(band, (freqs) => {
      allFreqs = allFreqs.concat(freqs);
      bandIndex++;
      scanNextBand();
    });
  }

  scanNextBand();
}

runSweep();
