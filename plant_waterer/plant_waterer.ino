#include <EEPROM.h>
#include <U8x8lib.h>

// --- Pins ---
const byte SENSOR_PIN = A0;        // sensor AO
const byte SENSOR_POWER_PIN = 7;   // sensor VCC: powered only while reading, slows probe corrosion
const byte RELAY_PIN = 4;          // relay IN
const bool RELAY_ACTIVE_LOW = true; // most relay modules turn on with LOW; flip if pump runs when it shouldn't

// --- Calibration: read the raw number on the OLED, then set these ---
const int DRY_RAW = 800;   // probe in dry soil (or in air)
const int WET_RAW = 350;   // probe in freshly watered soil

// Start threshold is set from the dashboard ("T<pct>\n") and kept in EEPROM.
const byte DEFAULT_START_PCT = 30;
const byte STOP_MARGIN_PCT = 30; // keep watering until start + this
byte startPct;

// --- Watering behaviour ---
const unsigned long PUMP_BURST_MS = 3000; // one squirt
const unsigned long SOAK_MS = 30000;      // wait for water to reach the probe before watering again
const byte MAX_BURSTS = 5;                // still dry after this many = empty tank / probe out of pot
const unsigned long READ_EVERY_MS = 2000;

// Screen garbled or shifted 2 pixels? Swap to U8X8_SH1106_128X64_NONAME_HW_I2C
U8X8_SSD1306_128X64_NONAME_HW_I2C oled;

bool watering = false;
bool fault = false;
byte bursts = 0;
unsigned long soakUntil = 0;

void pump(bool on) {
  digitalWrite(RELAY_PIN, on != RELAY_ACTIVE_LOW ? HIGH : LOW);
}

int readRaw() {
  digitalWrite(SENSOR_POWER_PIN, HIGH);
  delay(10);
  int raw = analogRead(SENSOR_PIN);
  digitalWrite(SENSOR_POWER_PIN, LOW);
  return raw;
}

byte toPct(int raw) {
  return constrain(map(raw, DRY_RAW, WET_RAW, 0, 100), 0, 100);
}

byte stopPct() {
  return min(startPct + STOP_MARGIN_PCT, 100);
}

// Commands from the dashboard: "T<pct>" sets start threshold, "R" clears a fault.
void readCommand() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'T') {
      long v = Serial.parseInt();
      if (v >= 1 && v <= 95) {
        startPct = v;
        EEPROM.update(0, startPct);
      }
    } else if (c == 'R') {
      fault = false;
      bursts = 0;
    }
  }
}

// Serial line format (read by the dashboard): raw,pct,startPct,status
void show(int raw, byte pct, const char *status) {
  char buf[17];
  oled.clear();
  oled.drawString(0, 0, "Soil moisture");
  snprintf(buf, sizeof buf, "%3u%%", pct);
  oled.draw2x2String(2, 2, buf);
  snprintf(buf, sizeof buf, "raw %4d", raw);
  oled.drawString(0, 5, buf);
  snprintf(buf, sizeof buf, "water <%u%%", startPct);
  oled.drawString(0, 6, buf);
  oled.drawString(0, 7, status);

  Serial.print(raw);
  Serial.print(',');
  Serial.print(pct);
  Serial.print(',');
  Serial.print(startPct);
  Serial.print(',');
  Serial.println(status);
}

void setup() {
  pump(false); // set level before enabling output so the pump doesn't blip at boot
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(SENSOR_POWER_PIN, OUTPUT);
  Serial.begin(9600);
  oled.begin();
  oled.setFont(u8x8_font_chroma48medium8_r);

  startPct = EEPROM.read(0);
  if (startPct < 1 || startPct > 95) startPct = DEFAULT_START_PCT; // blank EEPROM reads 255
}

void loop() {
  readCommand();
  int raw = readRaw();
  byte pct = toPct(raw);
  const char *status;

  if (fault) {
    status = "CHECK TANK/RESET";
  } else if ((long)(soakUntil - millis()) > 0) {
    status = "Soaking...";
  } else if (pct < startPct || (watering && pct < stopPct())) {
    if (bursts >= MAX_BURSTS) {
      fault = true;
      status = "CHECK TANK/RESET";
    } else {
      watering = true;
      bursts++;
      show(raw, pct, "Watering...");
      pump(true);
      delay(PUMP_BURST_MS);
      pump(false);
      soakUntil = millis() + SOAK_MS;
      status = "Soaking...";
    }
  } else {
    watering = false;
    bursts = 0;
    status = pct < stopPct() ? "OK" : "Wet";
  }

  show(raw, pct, status);
  delay(READ_EVERY_MS);
}
