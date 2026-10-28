/*
 * Smart Classroom Entry System
 * Fingerprint attendance + e-nose breath screening + MongoDB backend + alerts
 *
 * Board : ESP32 Dev Module (Arduino IDE)
 * Libs  : Adafruit Fingerprint Sensor Library, Adafruit SSD1306, Adafruit GFX,
 *         DHT sensor library (+ Adafruit Unified Sensor), ArduinoJson (v7)
 *
 * Serial Monitor (115200, "Newline"): type  help
 *
 * NOTE: the breath result is a SCREENING INDICATOR only (see README).
 */
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <time.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_Fingerprint.h>
#include <DHT.h>
#include <ArduinoJson.h>



#pragma once
// ============================================================
//  config.h  -  edit this file only. Do NOT commit real passwords.
// ============================================================

// ---------- Wi-Fi / Server ----------
#define WIFI_SSID        "Redmi 13 5G"
#define WIFI_PASS        "dinesh26"
// Use http://<PC-LAN-IP>:5000 for a local server, or https://your-host for cloud
#define SERVER_URL       "https://tobacco-mvul.onrender.com"
#define API_KEY          "6077b1e89d6b5c00ec78654d749f3e8100be16a45cf98258"      // must equal DEVICE_API_KEY in backend/.env
#define DEVICE_ID        "CLASSROOM-101"
#define NTP_GMT_OFFSET_SEC 19800                      // IST = UTC+5:30

// ---------- Pins ----------
#define PIN_MQ135   34
#define PIN_MQ7     35
#define PIN_MQ2     32
#define PIN_DHT     15
#define PIN_TRIG    18
#define PIN_ECHO    19    // through 2k / 3.3k divider
#define PIN_FP_RX   16    // ESP32 RX2  <- R307 TX
#define PIN_FP_TX   17    // ESP32 TX2  -> R307 RX
#define PIN_SDA     21
#define PIN_SCL     22
#define PIN_LED_R   14
#define PIN_LED_G   13
#define PIN_LED_B   25    // GPIO12 is a boot-strapping pin; 25 is safer for the blue LED
#define PIN_BUZZER  27    // active buzzer (use a transistor if it draws > 12 mA)
#define PIN_PUMP    26    // optional 6V pump via transistor/MOSFET + flyback diode

#define OLED_ADDR           0x3C
#define LED_COMMON_ANODE    0     // 1 if your RGB LED is common-anode
#define USE_PUMP            0     // 1 once the diaphragm pump circuit is built
#define USE_ULTRASONIC      1     // wakes the OLED when someone is near

// ---------- Fingerprint ----------
#define FP_BAUD             57600

// ---------- E-nose timing ----------
#define WARMUP_SECONDS      60    // use 180+ for real use; new MQ sensors need 24-48 h burn-in
#define SAMPLE_MS           6000  // breath sampling window
#define TELEMETRY_MS        60000UL

// ---------- Detection thresholds (ADC counts above baseline, 0-4095 scale) ----------
// START VALUES ONLY - calibrate with the 'raw' serial command (see README section 9)
#define TH_MQ135            150
#define TH_MQ2              200
#define TH_MQ7              120
#define MIN_SENSORS_TRIGGERED 2   // how many sensors must exceed their threshold

// ---------- Misc ----------
#define PRESENCE_CM         100
#define SCREEN_TIMEOUT_MS   30000UL
#define MAX_FAILED_ATTEMPTS 3     // unknown-fingerprint attempts before the server is told


// ---------------- Objects ----------------
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Adafruit_Fingerprint finger(&Serial2);
DHT dht(PIN_DHT, DHT22);

// ---------------- State ----------------
float base135 = 0, base2 = 0, base7 = 0;
bool r307Ok = false, oledOk = false, displayOn = true;
float lastTemp = NAN, lastHum = NAN, lastDist = -1;
uint8_t failCount = 0;
uint32_t lastTelemetry = 0, lastIdleDraw = 0, lastBaseline = 0, lastWifiTry = 0;
uint32_t lastPresence = 0, lastDistCheck = 0, lastEnvRead = 0, lastQueueTry = 0, lastFpRetry = 0;

struct BreathResult {
  int d135, d2, d7;
  int triggered;
  float score;
};

// Offline queue (RAM) for scan events
#define QUEUE_MAX 20
String qBody[QUEUE_MAX];
int qCount = 0;

// ---------------- Small helpers ----------------
void setLed(bool r, bool g, bool b) {
#if LED_COMMON_ANODE
  r = !r; g = !g; b = !b;
#endif
  digitalWrite(PIN_LED_R, r);
  digitalWrite(PIN_LED_G, g);
  digitalWrite(PIN_LED_B, b);
}

void buzz(bool on) { digitalWrite(PIN_BUZZER, on ? HIGH : LOW); }

void beep(uint16_t ms) { buzz(true); delay(ms); buzz(false); }

void pump(bool on) {
#if USE_PUMP
  digitalWrite(PIN_PUMP, on ? HIGH : LOW);
#endif
}

void showLines(const String &l1, const String &l2 = "", const String &l3 = "", const String &l4 = "") {
  if (!oledOk || !displayOn) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);   display.println(l1);
  display.setCursor(0, 16);  display.println(l2);
  display.setCursor(0, 32);  display.println(l3);
  display.setCursor(0, 48);  display.println(l4);
  display.display();
}

void showBig(const String &big, const String &small = "") {
  if (!oledOk || !displayOn) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 8);
  display.println(big);
  display.setTextSize(1);
  display.setCursor(0, 44);
  display.println(small);
  display.display();
}

void drawProgress(const String &title, int pct) {
  if (!oledOk || !displayOn) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 6);
  display.println(title);
  display.drawRect(0, 40, 128, 14, SSD1306_WHITE);
  display.fillRect(2, 42, (124 * constrain(pct, 0, 100)) / 100, 10, SSD1306_WHITE);
  display.display();
}

void setDisplay(bool on) {
  if (!oledOk || on == displayOn) return;
  displayOn = on;
  display.ssd1306_command(on ? SSD1306_DISPLAYON : SSD1306_DISPLAYOFF);
}

String nowStr() {
  struct tm t;
  if (!getLocalTime(&t, 10)) return "--:--:--";
  char b[12];
  strftime(b, sizeof(b), "%H:%M:%S", &t);
  return String(b);
}

uint32_t epochNow() {
  time_t n = time(nullptr);
  return n > 1600000000 ? (uint32_t)n : 0;
}

int readMQ(int pin) {
  long s = 0;
  for (int i = 0; i < 8; i++) { s += analogRead(pin); delayMicroseconds(300); }
  return (int)(s / 8);
}

float readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  long d = pulseIn(PIN_ECHO, HIGH, 30000);
  if (d == 0) return -1;      // no echo = nothing in range
  return d * 0.0343f / 2.0f;
}

// ---------------- Wi-Fi / HTTP ----------------
void wifiConnect(uint32_t timeoutMs = 15000) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < timeoutMs) delay(250);
  if (WiFi.status() == WL_CONNECTED) {
    configTime(NTP_GMT_OFFSET_SEC, 0, "pool.ntp.org", "time.google.com");
    Serial.print("WiFi OK, IP: "); Serial.println(WiFi.localIP());
  } else {
    Serial.println("WiFi FAILED (will keep retrying)");
  }
}

void wifiMaintain() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiTry < 15000) return;
  lastWifiTry = millis();
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

int postJson(const String &path, const String &body, String *resp = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  String url = String(SERVER_URL) + path;
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  if (url.startsWith("https")) {
    secure.setInsecure();   // OK for a college project; pin a CA certificate for production
    http.begin(secure, url);
  } else {
    http.begin(plain, url);
  }
  http.setTimeout(5000);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);
  int code = http.POST(body);
  if (resp && code > 0) *resp = http.getString();
  http.end();
  return code;
}

void queuePush(const String &b) {
  if (qCount == QUEUE_MAX) {
    for (int i = 1; i < QUEUE_MAX; i++) qBody[i - 1] = qBody[i];
    qCount--;
  }
  qBody[qCount++] = b;
}

void flushQueue() {
  if (qCount == 0 || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastQueueTry < 5000) return;
  lastQueueTry = millis();
  int code = postJson("/api/scan", qBody[0]);
  if ((code >= 200 && code < 300) || code == 400) {   // delivered, or permanently invalid
    for (int i = 1; i < qCount; i++) qBody[i - 1] = qBody[i];
    qBody[--qCount] = "";
  }
}

// ---------------- Environment / telemetry ----------------
void readEnv() {
  if (millis() - lastEnvRead < 2500) return;     // DHT22 needs >= 2 s between reads
  lastEnvRead = millis();
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (!isnan(t)) lastTemp = t;
  if (!isnan(h)) lastHum = h;
}

void sendTelemetry() {
  lastTelemetry = millis();
  readEnv();
  JsonDocument d;
  d["deviceId"] = DEVICE_ID;
  if (!isnan(lastTemp)) d["temperature"] = lastTemp;
  if (!isnan(lastHum))  d["humidity"] = lastHum;
  d["mq135"] = readMQ(PIN_MQ135);
  d["mq2"]   = readMQ(PIN_MQ2);
  d["mq7"]   = readMQ(PIN_MQ7);
  if (lastDist >= 0) d["distance"] = lastDist;
  d["rssi"] = WiFi.RSSI();
  String s; serializeJson(d, s);
  int code = postJson("/api/telemetry", s);
  Serial.printf("[telemetry] HTTP %d\n", code);
}

void updatePresence() {
#if USE_ULTRASONIC
  if (millis() - lastDistCheck < 500) return;
  lastDistCheck = millis();
  lastDist = readDistanceCm();
  if (lastDist > 0 && lastDist < PRESENCE_CM) lastPresence = millis();
  setDisplay(millis() - lastPresence < SCREEN_TIMEOUT_MS);
#endif
}

void updateBaseline() {   // slow tracking of clean-air level; ignores elevated readings
  if (millis() - lastBaseline < 5000) return;
  lastBaseline = millis();
  int a = readMQ(PIN_MQ135), b = readMQ(PIN_MQ2), c = readMQ(PIN_MQ7);
  if (a < base135 + TH_MQ135 / 2) base135 = base135 * 0.98f + a * 0.02f;
  if (b < base2   + TH_MQ2   / 2) base2   = base2   * 0.98f + b * 0.02f;
  if (c < base7   + TH_MQ7   / 2) base7   = base7   * 0.98f + c * 0.02f;
}

void calibrateBaseline() {
  showBig("Calibrating", "Keep air clean");
  long a = 0, b = 0, c = 0; int n = 40;
  for (int i = 0; i < n; i++) {
    a += readMQ(PIN_MQ135); b += readMQ(PIN_MQ2); c += readMQ(PIN_MQ7);
    delay(75);
  }
  base135 = a / (float)n; base2 = b / (float)n; base7 = c / (float)n;
  Serial.printf("Baseline  MQ135=%.0f  MQ2=%.0f  MQ7=%.0f\n", base135, base2, base7);
}

// ---------------- Fingerprint ----------------
// returns -1 no finger, -2 finger but no match, >=1 matched ID
int readFingerprint() {
  if (finger.getImage() != FINGERPRINT_OK) return -1;
  if (finger.image2Tz() != FINGERPRINT_OK) return -2;
  if (finger.fingerFastSearch() != FINGERPRINT_OK) return -2;
  return finger.fingerID;
}

bool captureToSlot(uint8_t slot, uint32_t timeoutMs = 15000) {
  uint32_t t = millis();
  uint8_t p;
  do {
    p = finger.getImage();
    if (millis() - t > timeoutMs) return false;
    delay(50);
  } while (p != FINGERPRINT_OK);
  return finger.image2Tz(slot) == FINGERPRINT_OK;
}

void waitFingerRemoved(uint32_t timeoutMs = 8000) {
  uint32_t t = millis();
  while (millis() - t < timeoutMs && finger.getImage() != FINGERPRINT_NOFINGER) delay(100);
}

bool enrollFingerprint(uint16_t id) {
  setDisplay(true);
  showBig("Enroll #" + String(id), "Place finger");
  if (!captureToSlot(1)) return false;
  showBig("Remove", "finger");
  delay(1200);
  waitFingerRemoved(5000);
  showBig("Same finger", "Place again");
  if (!captureToSlot(2)) return false;
  if (finger.createModel() != FINGERPRINT_OK) return false;     // two scans did not match
  return finger.storeModel(id) == FINGERPRINT_OK;
}

// ---------------- Breath sampling ----------------
BreathResult sampleBreath() {
  int p135 = 0, p2 = 0, p7 = 0;
  pump(true);
  uint32_t t0 = millis(), lastDraw = 0;
  while (millis() - t0 < SAMPLE_MS) {
    p135 = max(p135, readMQ(PIN_MQ135));
    p2   = max(p2,   readMQ(PIN_MQ2));
    p7   = max(p7,   readMQ(PIN_MQ7));
    if (millis() - lastDraw > 250) {
      lastDraw = millis();
      drawProgress("BLOW", (int)((millis() - t0) * 100UL / SAMPLE_MS));
    }
    delay(20);
  }
  pump(false);

  BreathResult r;
  r.d135 = p135 - (int)base135;
  r.d2   = p2   - (int)base2;
  r.d7   = p7   - (int)base7;
  r.triggered = (r.d135 >= TH_MQ135) + (r.d2 >= TH_MQ2) + (r.d7 >= TH_MQ7);
  r.score = (max(0, r.d135) / (float)TH_MQ135 + max(0, r.d2) / (float)TH_MQ2 + max(0, r.d7) / (float)TH_MQ7) / 3.0f;
  Serial.printf("Breath  d135=%d d2=%d d7=%d  triggered=%d score=%.2f\n", r.d135, r.d2, r.d7, r.triggered, r.score);
  return r;
}

// ---------------- Server events ----------------
String buildScanJson(int id, const char *status, const BreathResult *r) {
  JsonDocument d;
  d["deviceId"] = DEVICE_ID;
  d["fingerprintId"] = id;
  d["status"] = status;
  d["ts"] = epochNow();
  if (r) {
    d["score"] = r->score;
    JsonObject rd = d["readings"].to<JsonObject>();
    rd["mq135"] = r->d135; rd["mq2"] = r->d2; rd["mq7"] = r->d7;
    if (!isnan(lastTemp)) rd["temperature"] = lastTemp;
    if (!isnan(lastHum))  rd["humidity"] = lastHum;
  }
  String s; serializeJson(d, s);
  return s;
}

// returns true if the server accepted it; name filled when known
bool sendScan(int id, const char *status, const BreathResult *r, String &name) {
  String body = buildScanJson(id, status, r), resp;
  int code = postJson("/api/scan", body, &resp);
  if (code >= 200 && code < 300) {
    JsonDocument d;
    if (!deserializeJson(d, resp)) name = String((const char *)(d["name"] | ""));
    return true;
  }
  queuePush(body);       // keep for later
  return false;
}

// ---------------- Flows ----------------
void handleMatch(int id) {
  failCount = 0;
  setLed(0, 0, 1);
  beep(80);
  showBig("Verified", "ID " + String(id) + " - blow now");
  delay(800);

  BreathResult r = sampleBreath();
  bool flagged = r.triggered >= MIN_SENSORS_TRIGGERED;
  String name;
  bool sent = sendScan(id, flagged ? "ALERT" : "CLEAR", &r, name);
  String line = name.length() ? name.substring(0, 21) : ("ID " + String(id));
  String net = sent ? "Recorded" : "Saved offline";

  if (flagged) {
    setLed(1, 0, 0);
    showBig("ALERT", line + " / " + net);
    for (int i = 0; i < 6; i++) { buzz(true); delay(200); buzz(false); delay(120); }
    delay(2000);
  } else {
    setLed(0, 1, 0);
    showBig("WELCOME", line + " / " + net);
    beep(150);
    delay(2000);
  }
  setLed(0, 0, 0);
  waitFingerRemoved();
  delay(500);
}

void handleNoMatch() {
  failCount++;
  setLed(1, 0, 0);
  showBig("NO MATCH", "Try again (" + String(failCount) + ")");
  beep(100); delay(100); beep(100);
  if (failCount >= MAX_FAILED_ATTEMPTS) {
    String n;
    sendScan(0, "UNKNOWN", nullptr, n);
    failCount = 0;
  }
  delay(1200);
  setLed(0, 0, 0);
  waitFingerRemoved(3000);
}

void drawIdle() {
  if (millis() - lastIdleDraw < 1000) return;
  lastIdleDraw = millis();
  readEnv();
  String l1 = "SMART CLASSROOM " + nowStr().substring(0, 5);
  String l2 = WiFi.status() == WL_CONNECTED ? "WiFi OK  Q:" + String(qCount) : "WiFi OFFLINE Q:" + String(qCount);
  String l3 = isnan(lastTemp) ? String("T/H: --") : (String(lastTemp, 1) + "C  " + String(lastHum, 0) + "%");
  showLines(l1, l2, l3, "Place finger");
}

// ---------------- Serial console ----------------
void printHelp() {
  Serial.println(F("Commands:"));
  Serial.println(F("  enroll <id>      enroll a fingerprint into slot <id>"));
  Serial.println(F("  delete <id>      delete one template"));
  Serial.println(F("  empty confirm    delete ALL templates"));
  Serial.println(F("  count            number of stored templates"));
  Serial.println(F("  raw              print live sensor readings (for calibration)"));
  Serial.println(F("  baseline         recalibrate clean-air baseline"));
  Serial.println(F("  status           system status"));
}

void handleSerial() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd.isEmpty()) return;

  if (cmd == "help") {
    printHelp();
  } else if (cmd.startsWith("enroll ")) {
    int id = cmd.substring(7).toInt();
    finger.getParameters();
    if (!r307Ok || id < 1 || id > finger.capacity) { Serial.println("Invalid id or sensor offline"); return; }
    bool ok = enrollFingerprint(id);
    Serial.println(ok ? "Enrolled OK. Now register this ID for the student in the backend (README sec. 7)."
                      : "Enrollment FAILED - try again");
    showBig(ok ? "Enrolled" : "Failed", "ID " + String(id));
    delay(1500);
  } else if (cmd.startsWith("delete ")) {
    int id = cmd.substring(7).toInt();
    Serial.println(finger.deleteModel(id) == FINGERPRINT_OK ? "Deleted" : "Delete failed");
  } else if (cmd == "empty confirm") {
    Serial.println(finger.emptyDatabase() == FINGERPRINT_OK ? "All templates deleted" : "Failed");
  } else if (cmd == "count") {
    finger.getTemplateCount();
    Serial.printf("Templates stored: %d\n", finger.templateCount);
  } else if (cmd == "raw") {
    Serial.printf("MQ-135=%d (base %.0f)  MQ-2=%d (base %.0f)  MQ-7=%d (base %.0f)\n",
                  readMQ(PIN_MQ135), base135, readMQ(PIN_MQ2), base2, readMQ(PIN_MQ7), base7);
    Serial.printf("Temp=%.1f  Hum=%.1f  Dist=%.1f cm\n", lastTemp, lastHum, readDistanceCm());
  } else if (cmd == "baseline") {
    calibrateBaseline();
  } else if (cmd == "status") {
    Serial.printf("R307:%s  OLED:%s  WiFi:%s  Queue:%d  Time:%s\n", r307Ok ? "OK" : "NOT FOUND",
                  oledOk ? "OK" : "NOT FOUND", WiFi.status() == WL_CONNECTED ? "OK" : "OFF", qCount, nowStr().c_str());
  } else {
    Serial.println("Unknown command. Type: help");
  }
}

// ---------------- Setup / loop ----------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=== Smart Classroom Entry System ==="));

  pinMode(PIN_LED_R, OUTPUT); pinMode(PIN_LED_G, OUTPUT); pinMode(PIN_LED_B, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT); pinMode(PIN_TRIG, OUTPUT); pinMode(PIN_ECHO, INPUT);
#if USE_PUMP
  pinMode(PIN_PUMP, OUTPUT);
#endif
  setLed(0, 0, 0); buzz(false); pump(false);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  Wire.begin(PIN_SDA, PIN_SCL);
  oledOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  dht.begin();

  Serial2.begin(FP_BAUD, SERIAL_8N1, PIN_FP_RX, PIN_FP_TX);
  finger.begin(FP_BAUD);
  delay(100);
  r307Ok = finger.verifyPassword();
  if (r307Ok) { finger.getParameters(); finger.getTemplateCount(); }

  // ---- self-test screen ----
  float t = dht.readTemperature();
  int m7 = readMQ(PIN_MQ7);
  showLines(String("R307: ") + (r307Ok ? "OK" : "NOT FOUND"),
            String("DHT22: ") + (isnan(t) ? "FAIL" : "OK"),
            String("MQ-7 raw: ") + m7 + (m7 < 20 ? " CHECK" : ""),
            String("Templates: ") + (r307Ok ? finger.templateCount : 0));
  Serial.printf("R307:%s DHT22:%s MQ7raw:%d\n", r307Ok ? "OK" : "NOT FOUND", isnan(t) ? "FAIL" : "OK", m7);
  delay(2500);

  showBig("WiFi...", WIFI_SSID);
  wifiConnect();

  // ---- sensor warm-up ----
  setLed(0, 0, 1);
  for (int s = WARMUP_SECONDS; s > 0; s--) {
    showBig("Warm-up", String(s) + " s remaining");
    delay(1000);
    handleSerial();
  }
  setLed(0, 0, 0);
  calibrateBaseline();
  lastPresence = millis();
  printHelp();
  beep(100);
}

void loop() {
  handleSerial();
  wifiMaintain();
  flushQueue();
  updatePresence();
  updateBaseline();
  if (millis() - lastTelemetry > TELEMETRY_MS) sendTelemetry();

  if (!r307Ok) {
    if (millis() - lastFpRetry > 5000) { lastFpRetry = millis(); r307Ok = finger.verifyPassword(); }
    showLines("R307 NOT FOUND", "Check TX/RX wiring", "and 5V / GND");
    delay(300);
    return;
  }

  int id = readFingerprint();
  if (id == -1) { drawIdle(); delay(30); return; }

  setDisplay(true);
  lastPresence = millis();
  if (id == -2) handleNoMatch();
  else handleMatch(id);
}
