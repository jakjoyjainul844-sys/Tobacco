const express = require('express');
const crypto = require('crypto');
const { Student, Recipient, Scan, Telemetry } = require('./models');
const S = require('./services');

const router = express.Router();

// ---------- auth ----------
function safeEqual(a = '', b = '') {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const requireKey = (envName, header) => (req, res, next) => {
  const expected = process.env[envName];
  if (!expected || !safeEqual(req.get(header), expected)) return res.status(401).json({ error: 'unauthorized' });
  next();
};
const device = requireKey('DEVICE_API_KEY', 'x-api-key');
const admin = requireKey('ADMIN_API_KEY', 'x-admin-key');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const validDate = d => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);

// =============== DEVICE ENDPOINTS ===============
router.post('/scan', device, wrap(async (req, res) => {
  const { deviceId = 'UNKNOWN-DEVICE', fingerprintId, status, score, readings = {}, ts } = req.body || {};
  if (!['CLEAR', 'ALERT', 'UNKNOWN'].includes(status)) return res.status(400).json({ error: 'invalid status' });

  const when = Number(ts) > 1.6e9 ? new Date(Number(ts) * 1000) : new Date();
  const date = S.dateIST(when);

  let student = null;
  if (status !== 'UNKNOWN' && Number.isInteger(fingerprintId)) {
    student = await Student.findOne({ fingerprintId, active: true });
  }

  const scan = await Scan.create({
    deviceId: String(deviceId).slice(0, 40),
    date, scannedAt: when,
    fingerprintId: Number.isInteger(fingerprintId) ? fingerprintId : undefined,
    student: student?._id,
    rollNo: student?.rollNo,
    name: student?.name,
    status: student ? status : 'UNKNOWN',
    score: num(score),
    readings: {
      mq135: num(readings.mq135), mq2: num(readings.mq2), mq7: num(readings.mq7),
      temperature: num(readings.temperature), humidity: num(readings.humidity)
    }
  });

  if (student && status === 'ALERT') S.notifyAlert(scan, student).catch(e => console.error('[alert]', e.message));

  const firstToday = student
    ? (await Scan.countDocuments({ student: student._id, date, status: { $in: ['CLEAR', 'ALERT'] } })) === 1
    : false;

  res.json({ ok: true, known: !!student, name: student?.name || '', rollNo: student?.rollNo || '', firstToday });
}));

router.post('/telemetry', device, wrap(async (req, res) => {
  const b = req.body || {};
  await Telemetry.create({
    deviceId: String(b.deviceId || '').slice(0, 40),
    temperature: num(b.temperature), humidity: num(b.humidity),
    mq135: num(b.mq135), mq2: num(b.mq2), mq7: num(b.mq7),
    distance: num(b.distance), rssi: num(b.rssi)
  });
  res.json({ ok: true });
}));

// =============== ADMIN: STUDENTS ===============
const STUDENT_FIELDS = ['fingerprintId', 'rollNo', 'name', 'department', 'year', 'section', 'email', 'active'];

router.post('/students', admin, wrap(async (req, res) => {
  res.status(201).json(await Student.create(pick(req.body || {}, STUDENT_FIELDS)));
}));
router.get('/students', admin, wrap(async (_req, res) => {
  res.json(await Student.find().sort({ rollNo: 1 }));
}));
router.put('/students/:id', admin, wrap(async (req, res) => {
  const s = await Student.findByIdAndUpdate(req.params.id, pick(req.body || {}, STUDENT_FIELDS), { new: true, runValidators: true });
  s ? res.json(s) : res.status(404).json({ error: 'not found' });
}));
router.delete('/students/:id', admin, wrap(async (req, res) => {   // soft delete keeps history
  const s = await Student.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  s ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
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
