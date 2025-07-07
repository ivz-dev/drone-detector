// const Gpio = require("onoff").Gpio;
// const led = new Gpio(586, "out");

// led.writeSync(1); // Зажечь светодиод
// console.log("LED ON");
// setTimeout(() => {
//   led.writeSync(0); // Выключить светодиод
//   console.log("LED OFF");
//   led.unexport();
// }, 2000);


const Gpio = require('onoff').Gpio;
const ALERT_PIN = new Gpio(586, 'out');
ALERT_PIN.writeSync(1); // Увімкнути пін
setTimeout(() => ALERT_PIN.writeSync(0), 2000); // Вимкнути через 2 секунди