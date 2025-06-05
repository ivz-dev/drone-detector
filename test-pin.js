const Gpio = require("onoff").Gpio;
const led = new Gpio(586, "out");

led.writeSync(1); // Зажечь светодиод
console.log("LED ON");
setTimeout(() => {
  led.writeSync(0); // Выключить светодиод
  console.log("LED OFF");
  led.unexport();
}, 2000);
