const { spawn } = require('child_process');
const readline = require('readline');
const blessed = require('blessed');
const contrib = require('blessed-contrib');
const Gpio = require('onoff').Gpio; // для роботи з GPIO

// --- Частотні діапазони
const BANDS = [
//  { start: 2400, end: 2485, name: '2.4GHz' },
  { start: 5625, end: 5850, name: '5.8GHz' },
  { start: 902, end: 928, name: '900MHz' },
  { start: 1280, end: 1320, name: '1.3GHz' },
  { start: 3300, end: 3400, name: '3.3GHz' },
  { start: 1160, end: 1280, name: '1.2GHz' }
];

// --- Поріг потужності
const THRESHOLD_DBM = -70;

// --- GPIO налаштування
const ALERT_PIN = new Gpio(586, 'out'); // GPIO17 для сигналізації

// --- UI: графік
const screen = blessed.screen();
const line = contrib.line({
  label: 'Drone Frequency Power (dBm)',
  showLegend: true,
  minY: -100,
  maxY: 0,
  wholeNumbersOnly: false,
  style: { line: "yellow", text: "green", baseline: "black" }
});
screen.append(line);
screen.key(['escape', 'q', 'C-c'], () => {
  ALERT_PIN.unexport(); // очищення GPIO при виході
  process.exit(0);
});
screen.render();

function parseLine(line) {
  const parts = line.trim().split(',');
  if (parts.length < 7) return [];

  const freqStart = parseFloat(parts[2]) / 1e6;
  const binWidth = parseFloat(parts[4]) / 1e6;
  const powers = parts.slice(6).map(p => parseFloat(p));

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
  BANDS.forEach(({ start, end, name }) => {
    const inBand = freqs.filter(f => f.freq >= start && f.freq <= end);
	console.log(`inBand for ${name} is: ${inBand}`);
    if (inBand.length > 0) {
      const avgPower = inBand.reduce((sum, f) => sum + f.power, 0) / inBand.length;
	console.log(`avgPower is: ${avgPower}`);
      if (avgPower > THRESHOLD_DBM) {
        alerts.push({ start, end, name, avgPower: avgPower.toFixed(1) });
      }
    }
  });
  return alerts;
}

function runSweep() {
  // Скануємо всі діапазони
  const freqRanges = BANDS.map(band => `${band.start}:${band.end}`).join(',');
  const hackrf = spawn('hackrf_sweep', [
    '-f', freqRanges,
    '-w', '2000000',
    '-l', '24',
    '-g', '20',
    '-N', '1000'
  ]);

  const rl = readline.createInterface({ input: hackrf.stdout });
  const freqs = [];

//  rl.on('line', (line) => {
//    const parsed = parseLine(line);
//    freqs.push(...parsed);
//  });

rl.on('line', (line) => {
    console.log(line)
    const parsed = parseLine(line);

    console.log(parsed)
    freqs.push(...parsed);
  });

  hackrf.on('close', () => {
    const now = new Date().toLocaleTimeString();
    const sorted = freqs.sort((a, b) => a.freq - b.freq);
    const x = sorted.map(p => p.freq.toFixed(2));
    const y = sorted.map(p => p.power);

    line.setData([{
      title: "Power",
      x: x,
      y: y
    }]);

    const alerts = detect(sorted);
    if (alerts.length > 0) {
      // Активуємо GPIO пін
      ALERT_PIN.writeSync(1);
      
      alerts.forEach(({ start, end, name, avgPower }) => {
        console.log(`[${now}] 🛸 Дрон у діапазоні ${name} (${start}–${end} MHz). Потужність: ${avgPower} dB`);
      });
      
      // Вимикаємо GPIO пін через 2 секунди
      setTimeout(() => {
        ALERT_PIN.writeSync(0);
      }, 2000);
    } else {
      console.log(`[${now}] OK — нічого підозрілого`);
    }

    screen.render();
    setTimeout(runSweep, 2000);
  });
}

runSweep();
