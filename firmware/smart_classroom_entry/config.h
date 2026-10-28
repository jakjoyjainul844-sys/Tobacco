#pragma once
// ============================================================
//  config.h  -  edit this file only. Do NOT commit real passwords.
// ============================================================

// ---------- Wi-Fi / Server ----------
#define WIFI_SSID        "Redmi 1"
#define WIFI_PASS        "dinesh26"
// Use http://<PC-LAN-IP>:5000 for a local server, or https://your-host for cloud
#define SERVER_URL       "http://192.168.1.50:5000"
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
#define PIN_LED_R   13
#define PIN_LED_G   14
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
