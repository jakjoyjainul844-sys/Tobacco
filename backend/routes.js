const express = require('express');
const crypto = require('crypto');
const { Student, Recipient, Scan, Telemetry, DeviceCommand } = require('./models');
const S = require('./services');

const router = express.Router();

// ---------- auth ----------
function safeEqual(a = '', b = '') {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const requireKey = (envName, header) => (req, res, next) => {
  const expected = process.env[envName];
  const provided = req.get(header) || req.query.key || req.query.adminKey || (req.headers.authorization ? req.headers.authorization.replace('Bearer ', '') : '');
  if (!expected || !safeEqual(provided, expected)) return res.status(401).json({ error: 'unauthorized', message: `Invalid or missing ${header}` });
  next();
};

const device = requireKey('DEVICE_API_KEY', 'x-api-key');
const admin = requireKey('ADMIN_API_KEY', 'x-admin-key');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o && o[k] !== undefined).map(k => [k, o[k]]));
const validDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);

// =============== SYSTEM & DIAGNOSTICS ===============
router.get('/system/status', wrap(async (_req, res) => {
  const studentCount = await Student.countDocuments({ active: true });
  const recipientCount = await Recipient.countDocuments({ active: true });
  const todayScans = await Scan.countDocuments({ date: S.dateIST() });
  const latestTelemetry = await Telemetry.findOne().sort({ createdAt: -1 }).lean();
  const smtpStatus = await S.verifySmtp();

  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    localTime: new Date().toLocaleString('en-IN', { timeZone: process.env.TZ_NAME || 'Asia/Kolkata' }),
    timezone: process.env.TZ_NAME || 'Asia/Kolkata',
    db: true,
    smtp: smtpStatus,
    counts: {
      students: studentCount,
      recipients: recipientCount,
      todayScans
    },
    latestTelemetry: latestTelemetry || null
  });
}));

router.post('/mail/test', admin, wrap(async (req, res) => {
  const target = req.body?.email;
  const result = await S.sendTestEmail(target);
  res.json({ ok: result.sent, recipients: result.to });
}));

// =============== DEVICE ENDPOINTS (ESP32) ===============
router.post('/scan', device, wrap(async (req, res) => {
  const { deviceId = 'CLASSROOM-101', fingerprintId, status, score, readings = {}, ts } = req.body || {};
  if (!['CLEAR', 'ALERT', 'UNKNOWN'].includes(status)) return res.status(400).json({ error: 'invalid status' });

  const when = Number(ts) > 1.6e9 ? new Date(Number(ts) * 1000) : new Date();
  const date = S.dateIST(when);

  let student = null;
  if (status !== 'UNKNOWN' && Number.isInteger(fingerprintId) && fingerprintId > 0) {
    student = await Student.findOne({ fingerprintId, active: true });
  }

  const scan = await Scan.create({
    deviceId: String(deviceId).slice(0, 40),
    date,
    scannedAt: when,
    fingerprintId: Number.isInteger(fingerprintId) ? fingerprintId : undefined,
    student: student?._id,
    rollNo: student?.rollNo || (fingerprintId ? `FP#${fingerprintId}` : 'UNKNOWN'),
    name: student?.name || 'Unregistered / Unknown',
    status: student ? status : 'UNKNOWN',
    score: num(score),
    readings: {
      mq135: num(readings.mq135),
      mq2: num(readings.mq2),
      mq7: num(readings.mq7),
      temperature: num(readings.temperature),
      humidity: num(readings.humidity)
    }
  });

  if (student && status === 'ALERT') {
    S.notifyAlert(scan, student).catch(e => console.error('[alert]', e.message));
  }

  const firstToday = student
    ? (await Scan.countDocuments({ student: student._id, date, status: { $in: ['CLEAR', 'ALERT'] } })) === 1
    : false;

  res.json({
    ok: true,
    known: !!student,
    fingerprintId: student?.fingerprintId || fingerprintId,
    name: student?.name || '',
    rollNo: student?.rollNo || '',
    department: student?.department || '',
    firstToday
  });
}));

router.post('/telemetry', device, wrap(async (req, res) => {
  const b = req.body || {};
  await Telemetry.create({
    deviceId: String(b.deviceId || 'CLASSROOM-101').slice(0, 40),
    temperature: num(b.temperature),
    humidity: num(b.humidity),
    mq135: num(b.mq135),
    mq2: num(b.mq2),
    mq7: num(b.mq7),
    distance: num(b.distance),
    rssi: num(b.rssi)
  });
  res.json({ ok: true });
}));

// ESP32 polls this to check if an admin initiated enrollment or other action
router.get('/device/command', device, wrap(async (req, res) => {
  const cmd = await DeviceCommand.findOne({
    status: 'PENDING'
  }).sort({ createdAt: 1 });

  if (!cmd) return res.json({ hasCommand: false });

  cmd.status = 'IN_PROGRESS';
  await cmd.save();

  res.json({
    hasCommand: true,
    commandId: String(cmd._id),
    command: cmd.command,
    payload: cmd.payload
  });
}));

// ESP32 reports result of executing the command
router.post('/device/command-result', device, wrap(async (req, res) => {
  const { commandId, success, message, result } = req.body || {};
  if (commandId) {
    const cmd = await DeviceCommand.findById(commandId);
    if (cmd) {
      cmd.status = success ? 'COMPLETED' : 'FAILED';
      cmd.result = { message, ...result };
      await cmd.save();
    }
  }
  res.json({ ok: true });
}));

// =============== ADMIN: REAL STUDENT & FINGERPRINT MANAGEMENT ===============
const STUDENT_FIELDS = ['fingerprintId', 'rollNo', 'name', 'department', 'year', 'section', 'email', 'phone', 'active'];

// Find next available unused fingerprint slot ID (1 to 1000)
router.get('/students/next-slot', admin, wrap(async (_req, res) => {
  const usedSlots = await Student.find({ active: true }).distinct('fingerprintId');
  const usedSet = new Set(usedSlots);
  let nextSlot = 1;
  while (usedSet.has(nextSlot) && nextSlot <= 1000) {
    nextSlot++;
  }
  res.json({ nextSlot, totalAssigned: usedSlots.length, capacity: 1000 });
}));

// Trigger remote enrollment on the ESP32 hardware
router.post('/students/enroll-request', admin, wrap(async (req, res) => {
  const { fingerprintId, rollNo, name, department, year, section, email, phone } = req.body || {};
  const fpId = Number(fingerprintId);
  if (!fpId || fpId < 1 || fpId > 1000) {
    return res.status(400).json({ error: 'fingerprintId must be an integer between 1 and 1000' });
  }
  if (!rollNo || !name) {
    return res.status(400).json({ error: 'rollNo and name are required' });
  }

  // Check if rollNo or fingerprintId already exists in active students
  const existingFp = await Student.findOne({ fingerprintId: fpId, active: true });
  if (existingFp) {
    return res.status(409).json({ error: `Fingerprint Slot #${fpId} is already assigned to ${existingFp.name} (${existingFp.rollNo})` });
  }
  const existingRoll = await Student.findOne({ rollNo, active: true });
  if (existingRoll) {
    return res.status(409).json({ error: `Roll number ${rollNo} is already registered to ${existingRoll.name}` });
  }

  // Create or prepare student record
  let student = await Student.findOne({ rollNo });
  if (!student) {
    student = await Student.create({
      fingerprintId: fpId,
      rollNo,
      name,
      department: department || '',
      year: year || '',
      section: section || '',
      email: email || '',
      phone: phone || '',
      active: true
    });
  } else {
    student.fingerprintId = fpId;
    student.name = name;
    student.department = department || student.department;
    student.year = year || student.year;
    student.section = section || student.section;
    student.email = email || student.email;
    student.phone = phone || student.phone;
    student.active = true;
    await student.save();
  }

  // Queue command for ESP32
  const cmd = await DeviceCommand.create({
    command: 'enroll',
    payload: {
      fingerprintId: fpId,
      rollNo: student.rollNo,
      name: student.name
    }
  });

  res.status(202).json({
    ok: true,
    message: `Enrollment command queued for Slot #${fpId}. Place finger on the R307 sensor when prompted.`,
    commandId: String(cmd._id),
    student
  });
}));

// Check status of queued enrollment command
router.get('/students/enroll-status/:commandId', admin, wrap(async (req, res) => {
  const cmd = await DeviceCommand.findById(req.params.commandId);
  if (!cmd) return res.status(404).json({ error: 'command not found or expired' });
  res.json({
    commandId: String(cmd._id),
    command: cmd.command,
    status: cmd.status,
    result: cmd.result,
    createdAt: cmd.createdAt
  });
}));

router.post('/students', admin, wrap(async (req, res) => {
  const data = pick(req.body || {}, STUDENT_FIELDS);
  if (!data.fingerprintId || !data.rollNo || !data.name) {
    return res.status(400).json({ error: 'fingerprintId, rollNo, and name are required' });
  }
  const s = await Student.create(data);
  res.status(201).json(s);
}));

router.get('/students', admin, wrap(async (_req, res) => {
  res.json(await Student.find().sort({ fingerprintId: 1 }));
}));

router.put('/students/:id', admin, wrap(async (req, res) => {
  const s = await Student.findByIdAndUpdate(req.params.id, pick(req.body || {}, STUDENT_FIELDS), { new: true, runValidators: true });
  s ? res.json(s) : res.status(404).json({ error: 'not found' });
}));

router.delete('/students/:id', admin, wrap(async (req, res) => {
  const hard = req.query.hard === 'true';
  let s;
  if (hard) {
    s = await Student.findByIdAndDelete(req.params.id);
  } else {
    s = await Student.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  }
  s ? res.json({ ok: true, student: s }) : res.status(404).json({ error: 'not found' });
}));

// Batch import students
router.post('/students/batch', admin, wrap(async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : req.body?.students;
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'Expected non-empty array of students' });
  }
  const created = [], errors = [];
  for (const item of list) {
    try {
      const data = pick(item, STUDENT_FIELDS);
      if (!data.fingerprintId || !data.rollNo || !data.name) {
        errors.push({ item, error: 'Missing required fields' });
        continue;
      }
      const s = await Student.create(data);
      created.push(s);
    } catch (e) {
      errors.push({ item, error: e.message });
    }
  }
  res.json({ ok: true, createdCount: created.length, errorCount: errors.length, created, errors });
}));

// =============== SIMULATION ENDPOINT (FOR TESTING) ===============
router.post('/simulate/scan', admin, wrap(async (req, res) => {
  const { fingerprintId, status = 'CLEAR', score, readings } = req.body || {};
  let student = null;
  if (fingerprintId) {
    student = await Student.findOne({ fingerprintId: Number(fingerprintId), active: true });
  }

  const date = S.dateIST();
  const scan = await Scan.create({
    deviceId: 'SIMULATOR-01',
    date,
    scannedAt: new Date(),
    fingerprintId: Number(fingerprintId) || undefined,
    student: student?._id,
    rollNo: student?.rollNo || 'UNKNOWN',
    name: student?.name || 'Unregistered Visitor',
    status,
    score: score !== undefined ? score : (status === 'ALERT' ? 1.45 : 0.25),
    readings: readings || {
      mq135: status === 'ALERT' ? 220 : 45,
      mq2: status === 'ALERT' ? 280 : 60,
      mq7: status === 'ALERT' ? 180 : 35,
      temperature: 28.5,
      humidity: 58.0
    }
  });

  if (student && status === 'ALERT') {
    await S.notifyAlert(scan, student);
  }

  res.json({
    ok: true,
    scan,
    student: student || null
  });
}));

// =============== ADMIN: RECIPIENTS (HOD / faculty) ===============
const RECIPIENT_FIELDS = ['name', 'email', 'role', 'receiveAlerts', 'receiveReports', 'active'];

router.post('/recipients', admin, wrap(async (req, res) => {
  res.status(201).json(await Recipient.create(pick(req.body || {}, RECIPIENT_FIELDS)));
}));
router.get('/recipients', admin, wrap(async (_req, res) => res.json(await Recipient.find())));
router.put('/recipients/:id', admin, wrap(async (req, res) => {
  const r = await Recipient.findByIdAndUpdate(req.params.id, pick(req.body || {}, RECIPIENT_FIELDS), { new: true, runValidators: true });
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
}));
router.delete('/recipients/:id', admin, wrap(async (req, res) => {
  const r = await Recipient.findByIdAndDelete(req.params.id);
  r ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
}));

// =============== ADMIN: ATTENDANCE / REPORTS / LOGS ===============
router.get('/attendance', admin, wrap(async (req, res) => {
  res.json(await S.buildReport(validDate(req.query.date) || S.dateIST()));
}));
router.get('/attendance/csv', admin, wrap(async (req, res) => {
  const date = validDate(req.query.date) || S.dateIST();
  res.type('text/csv').attachment(`attendance-${date}.csv`).send(S.reportToCsv(await S.buildReport(date)));
}));
router.post('/reports/send', admin, wrap(async (req, res) => {
  res.json(await S.sendDailyReport(validDate(req.body?.date) || S.dateIST()));
}));
router.get('/scans', admin, wrap(async (req, res) => {
  const q = {};
  if (validDate(req.query.date)) q.date = req.query.date;
  if (['CLEAR', 'ALERT', 'UNKNOWN'].includes(req.query.status)) q.status = req.query.status;
  res.json(await Scan.find(q).sort({ scannedAt: -1 }).limit(Math.min(Number(req.query.limit) || 100, 500)));
}));
router.get('/telemetry/latest', admin, wrap(async (_req, res) => {
  res.json(await Telemetry.find().sort({ createdAt: -1 }).limit(60));
}));

module.exports = router;
