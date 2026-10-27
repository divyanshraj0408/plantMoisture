# Plant Moisture

An Arduino Nano waters a pot when the soil gets dry, and a Next.js dashboard graphs the readings and does the maths on them.

- `plant_waterer/`: Arduino sketch (moisture sensor, relay + pump, OLED)
- `dashboard/`: Next.js dashboard that reads the Nano over USB (Web Serial)

## Wiring

| Part | Pin | Nano |
|---|---|---|
| OLED (I2C) | GND / VCC / SCL / SDA | GND / 5V / A5 / A4 |
| Moisture sensor board | VCC / GND / AO | D7 / GND / A0 |
| Relay module | S / + / − | D4 / 5V / GND |

Pump on a separate supply: supply + → relay COM, relay NO → pump +, pump − → supply −.

## Upload the sketch

Needs the U8g2 library. This Nano clone uses the old bootloader:

```bash
arduino-cli compile -u -p /dev/cu.usbserial-A5069RR4 -b arduino:avr:nano:cpu=atmega328old plant_waterer
```

Calibrate `DRY_RAW` / `WET_RAW` in the sketch from the raw value shown on the OLED.

## Run the dashboard

```bash
cd dashboard
npm install
npm run dev
```

Open it in Chrome or Edge (Web Serial), close any Serial Monitor, and click **Connect Nano**. **Demo data** works without the board.

`npm run check` runs the self-check for the statistics code.

## Serial protocol

- Nano → dashboard, every 2 s: `raw,pct,threshold,status`
- Dashboard → Nano: `T<pct>` sets the pump start threshold (saved in EEPROM), `R` clears the tank alarm
