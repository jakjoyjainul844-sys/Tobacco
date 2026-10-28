# Smart Classroom Entry System

Fingerprint attendance + e-nose breath screening (ESP32) with a MongoDB backend,
faculty alerts and an automatic daily attendance report to the HOD.

> **Important:** the breath result is a **sensor-based screening indicator, not proof**.
> MQ sensors respond to many things (perfume, sanitizer, deodorant, food, smoke from outside).
> Alerts must be verified by a faculty member in person. Get written consent / institutional
> approval before deploying, and follow your college's policy and data-protection rules.

---------------------------------------------------------------------

## 1. How it works

```
 Student touches R307 ──► ESP32 matches fingerprint (template stays inside R307)
        │
        ▼
 Student blows on MQ-135 / MQ-2 / MQ-7 for 6 s ──► ESP32 compares against clean-air baseline
        │
        ├── CLEAR  → green LED, short beep, "WELCOME <name>"
        └── ALERT  → red LED, buzzer, "ALERT"
        │
        ▼  HTTPS/HTTP POST  (x-api-key)
 Node.js backend ──► MongoDB (Scan, Student, Recipient, Telemetry)
        ├── ALERT  → e-mail (+ optional Telegram) to faculty
        └── cron   → daily attendance e-mail (HTML + CSV) to HOD
```

If Wi-Fi is down, up to 20 scan events are queued in RAM and sent when it returns
(queue is lost on reboot).

## 2. Folder structure

```
smart-classroom-entry-system/
├── README.md
├── firmware/smart_classroom_entry/
│   ├── smart_classroom_entry.ino
│   └── config.h              <- edit Wi-Fi, server URL, key, thresholds
└── backend/
    ├── server.js  routes.js  models.js  services.js  seed.js
    ├── package.json
    └── .env.example          <- copy to .env
```

## 3. Hardware and wiring

| Component | Pin | ESP32 |
|---|---|---|
| MQ-135 | AO → divider | GPIO 34 |
| MQ-7 | AO → divider | GPIO 35 |
| MQ-2 | AO → divider | GPIO 32 |
| DHT22 | OUT | GPIO 15 |
| HC-SR04 | TRIG | GPIO 18 |
| HC-SR04 | ECHO → divider | GPIO 19 |
| R307 | TX | GPIO 16 (RX2) |
| R307 | RX | GPIO 17 (TX2) |
| OLED SSD1306 | SDA / SCL | GPIO 21 / 22 |
| RGB LED | R / G / B (each via 220-330 Ω) | GPIO 13 / 14 / **25** |
| Active buzzer | + | GPIO 27 |
| Pump (optional) | via transistor/MOSFET + diode | GPIO 26 |

**Change from the earlier plan:** blue LED moved from GPIO 12 to GPIO 25. GPIO 12 is a boot-strapping
pin; an LED pulling it high at power-up can stop the ESP32 from booting. If you keep GPIO 12, change
`PIN_LED_B` in `config.h` back.

**Dividers**
- Each MQ AO: AO → 10 kΩ → junction (to GPIO) → 15 kΩ → GND (5 V becomes about 3 V).
- HC-SR04 ECHO: ECHO → 2 kΩ → junction (to GPIO 19) → 3.3 kΩ → GND.
- A 100 nF capacitor from each ADC junction to GND reduces noise (optional).

**Power**
- 5 V rail: MQ modules, HC-SR04, R307 (check your R307 datasheet), ESP32 VIN.
- 3.3 V rail: OLED, DHT22.
- Common GND everywhere. MQ heaters draw about 150 mA each, so use a supply of 2 A or more, not the PC USB port alone.
- Pump: separate supply (6 V), transistor/MOSFET, flyback diode across the pump, grounds joined.

**Pin notes:** the MQ analog pins (32, 34, 35) are on ADC1, which keeps working while Wi-Fi is on.
GPIO 34 and 35 are input-only, which is fine here. Do not move analog inputs to ADC2 pins.
Solder resistors on the perfboard, not at the sensor header, and test each junction voltage with a
multimeter (must be below 3.3 V) **before** plugging in the ESP32.

## 4. Arduino IDE setup

1. Install Arduino IDE 2.x. In *Boards Manager* install **esp32 by Espressif**.
2. *Tools → Board → ESP32 Dev Module*, port COM5 (or yours), upload speed 115200.
3. *Library Manager*, install:
   - Adafruit Fingerprint Sensor Library
   - Adafruit SSD1306 and Adafruit GFX Library
   - DHT sensor library and Adafruit Unified Sensor
   - ArduinoJson (version 7.x)
4. Open `firmware/smart_classroom_entry/smart_classroom_entry.ino`. Keep `config.h` in the same folder.
5. Edit `config.h`: `WIFI_SSID`, `WIFI_PASS`, `SERVER_URL`, `API_KEY` (same as `DEVICE_API_KEY`), `DEVICE_ID`.
6. Upload. Open Serial Monitor at **115200** with **Newline** line ending.

On boot the OLED shows a self-test: `R307 OK/NOT FOUND`, `DHT22 OK/FAIL`, `MQ-7 raw` (flagged CHECK if near 0).

## 5. Backend setup

Requirements: Node.js 18+ and a MongoDB database (local, or free MongoDB Atlas cluster).

```bash
cd backend
npm install
cp .env.example .env        # Windows: copy .env.example .env
# edit .env  (MongoDB URI, two random keys, SMTP, HOD_EMAIL ...)
npm run seed                # optional: 3 test students + recipients
npm start
```

Check: open `http://localhost:5000/health` and expect `{"ok":true,"db":true}`.

**MongoDB Atlas:** create a free cluster, add a database user, allow your IP (Network Access), copy the
connection string into `MONGODB_URI`.

**Gmail SMTP:** turn on 2-step verification, create an *App Password*, and use it as `SMTP_PASS`.

**Network:** ESP32 and the PC running the backend must be on the same Wi-Fi. Use the PC's LAN IP in
`SERVER_URL` (find it with `ipconfig`) and allow port 5000 in the firewall. For 24/7 operation use an
always-on machine (Raspberry Pi, college server, or a VPS). Sleeping free-tier hosts will miss the
scheduled report.

## 6. Make the keys

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
Run it twice: one value for `DEVICE_API_KEY`, one for `ADMIN_API_KEY`.

## 7. Enroll students (fingerprint + database)

1. Serial Monitor: `enroll 1`, then follow the OLED (place finger, remove, place again).
2. Register the student in MongoDB with the **same** fingerprint ID:

```bash
curl -X POST http://localhost:5000/api/students \
  -H "x-admin-key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"fingerprintId":1,"rollNo":"MCA001","name":"Student One","department":"MCA","year":"II","section":"A"}'
```

Repeat with `enroll 2`, `enroll 3`, and so on. (Windows CMD: put the JSON on one line and escape
quotes, or use Postman / Thunder Client.) Fingerprint templates stay inside the R307. The database
stores only the ID, not biometric data.

Add the HOD and faculty:

```bash
curl -X POST http://localhost:5000/api/recipients -H "x-admin-key: YOUR_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Dr. HOD","email":"hod@college.edu","role":"HOD","receiveAlerts":true,"receiveReports":true}'
```

## 8. Serial console commands

| Command | Action |
|---|---|
| `help` | list commands |
| `enroll <id>` | enroll a fingerprint into slot |
| `delete <id>` | delete one template |
| `empty confirm` | delete all templates |
| `count` | templates stored |
| `raw` | live MQ readings and baselines (for calibration) |
| `baseline` | re-measure clean-air baseline |
| `status` | R307 / OLED / Wi-Fi / queue / time |

## 9. Calibrate the detection (do not skip)

The default thresholds in `config.h` are only starting values.

1. Let the sensors warm up. Brand-new MQ sensors need a 24-48 h burn-in on power before readings are stable.
2. In clean air run `raw` several times; note the numbers.
3. Test with 10+ volunteers who have **not** used tobacco (include perfume/sanitizer cases) and, with consent,
   some who have. Watch the `Breath d135=... d2=... d7=...` lines in Serial Monitor.
4. Set `TH_MQ135`, `TH_MQ2`, `TH_MQ7` above the non-user readings. Adjust `MIN_SENSORS_TRIGGERED`
   (2 = fewer false alarms, 1 = more sensitive).
5. Record your test table. It is useful for the accuracy chapter of your report.

## 10. REST API

Device (header `x-api-key`):
- `POST /api/scan` body `{deviceId, fingerprintId, status:"CLEAR|ALERT|UNKNOWN", score, readings{mq135,mq2,mq7,temperature,humidity}, ts}`
- `POST /api/telemetry`

Admin (header `x-admin-key`):
- `GET/POST /api/students`, `PUT/DELETE /api/students/:id` (delete = deactivate)
- `GET/POST /api/recipients`, `PUT/DELETE /api/recipients/:id`
- `GET /api/attendance?date=YYYY-MM-DD` (JSON), `GET /api/attendance/csv?date=...`
- `POST /api/reports/send` body `{"date":"YYYY-MM-DD"}` (send the report now)
- `GET /api/scans?date=&status=&limit=`, `GET /api/telemetry/latest`

Test the report without waiting for the schedule:
```bash
curl -X POST http://localhost:5000/api/reports/send -H "x-admin-key: YOUR_ADMIN_KEY"
```

## 11. Alerts and reports

- **Alert:** an `ALERT` scan e-mails every recipient with `receiveAlerts: true` (and Telegram if configured).
  One alert per student per `ALERT_COOLDOWN_MIN` minutes (default 10) to avoid spam.
- **Daily report:** sent at `REPORT_CRON` (default 4:30 PM Mon-Fri, Asia/Kolkata) to recipients with
  `receiveReports: true`; falls back to `HOD_EMAIL`. Contains present/absent lists, first entry time,
  late arrivals (after `LATE_AFTER`), screening flags, unrecognised-fingerprint attempts, plus a CSV attachment.
- **Telegram (optional):** create a bot with @BotFather, put the token in `TELEGRAM_BOT_TOKEN`, and your chat ID in `TELEGRAM_CHAT_ID`.

## 12. Troubleshooting

| Symptom | Check |
|---|---|
| `R307 NOT FOUND` | ESP32 RX2 (GPIO 16) must go to R307 **TX**, GPIO 17 to R307 **RX**; common GND; supply voltage per datasheet; baud 57600 |
| `No match` every time | Enroll first; clean sensor and finger; enroll the same finger twice |
| MQ-7 = 0 | AO not reaching GPIO 35, missing common GND, wrong divider, or dead module. Measure the AO pin and the junction with a multimeter |
| HC-SR04 "No echo" | Normal if nothing is within about 4 m. Otherwise check 5 V on VCC, TRIG on GPIO 18, ECHO divider |
| Boot loop / won't flash | Disconnect GPIO 12 / 15 loads; hold BOOT while uploading |
| Brown-outs / random resets | Weak 5 V supply; MQ heaters need current. Use 2 A+ and a 470 µF capacitor near the ESP32 |
| HTTP -1 in Serial | Wrong `SERVER_URL`, different network, or firewall blocking port 5000 |
| HTTP 401 | `API_KEY` in `config.h` differs from `DEVICE_API_KEY` |
| No e-mail | Check SMTP values; Gmail needs an App Password; see backend console for `[mail]` messages |
| Wrong time in reports | Backend timezone is `TZ_NAME`; the ESP32 time comes from NTP and needs Wi-Fi |

## 13. Known limits and next steps

- MQ sensors are not selective; results depend on calibration, humidity and temperature.
- `WiFiClientSecure.setInsecure()` skips certificate checks. Pin a CA certificate for production.
- Offline queue is in RAM only. Use SPIFFS/Preferences for persistence if needed.
- Possible additions: web dashboard (React), door relay, per-section reports, MQ-7 heating-cycle driving, admin login UI.
