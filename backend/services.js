const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('DNS configure warning:', e.message);
}

const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { Student, Recipient, Scan } = require('./models');

const TZ = process.env.TZ_NAME || 'Asia/Kolkata';

// ---------- time helpers ----------
const dateIST = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });           // YYYY-MM-DD
const fmtTime = d => new Date(d).toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true });
const hm24 = d => new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- mail / telegram ----------
let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false }
    });
  }
  return transporter;
}

async function verifySmtp() {
  const t = getTransporter();
  if (!t) return { ok: false, error: 'SMTP not configured in .env' };
  try {
    await t.verify();
    return { ok: true, host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendMail({ to, subject, html, attachments }) {
  const t = getTransporter();
  if (!t || !to || !to.length) {
    console.warn(`[mail] not sent (SMTP not configured or no recipients): ${subject}`);
    return false;
  }
  await t.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: to.join(','), subject, html, attachments });
  return true;
}

async function sendTestEmail(targetEmail) {
  const to = [targetEmail || process.env.HOD_EMAIL || process.env.SMTP_USER].filter(Boolean);
  const subject = `Smart Classroom Entry System - Test Email (${dateIST()})`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;padding:16px;border:1px solid #e2e8f0;border-radius:8px">
      <h2 style="color:#2563eb;margin:0 0 8px">Smart Classroom Entry System</h2>
      <p>This is a verification email from your IoT Smart Classroom Entry &amp; Screening System.</p>
      <div style="background:#f8fafc;padding:12px;border-radius:6px;margin:12px 0">
        <p style="margin:4px 0"><b>Status:</b> SMTP Email Service is active and working properly!</p>
        <p style="margin:4px 0"><b>Timestamp:</b> ${new Date().toLocaleString('en-IN', { timeZone: TZ })}</p>
        <p style="margin:4px 0"><b>SMTP Host:</b> ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}</p>
        <p style="margin:4px 0"><b>Sender:</b> ${process.env.SMTP_USER}</p>
      </div>
      <p style="color:#64748b;font-size:13px">Fingerprint attendance and e-nose breath screening alerts are live.</p>
    </div>`;
  const sent = await sendMail({ to, subject, html });
  return { sent, to };
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    if (typeof fetch === 'function') {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text })
      });
    }
  } catch (e) { console.error('[telegram]', e.message); }
}

async function recipientEmails(kind) {
  const flag = kind === 'alert' ? 'receiveAlerts' : 'receiveReports';
  const list = await Recipient.find({ active: true, [flag]: true }).lean();
  let emails = list.map(r => r.email);
  if (!emails.length) {
    const fb = kind === 'report' ? process.env.HOD_EMAIL : process.env.FACULTY_EMAIL;
    emails = (fb || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return emails;
}

// ---------- alerts ----------
const lastAlertAt = new Map();

async function notifyAlert(scan, student) {
  const cooldown = Number(process.env.ALERT_COOLDOWN_MIN || 10) * 60 * 1000;
  const key = String(student._id);
  if (Date.now() - (lastAlertAt.get(key) || 0) < cooldown) return;
  lastAlertAt.set(key, Date.now());

  const when = `${scan.date} ${fmtTime(scan.scannedAt)}`;
  const subject = `Screening alert: ${student.name} (${student.rollNo}) at ${fmtTime(scan.scannedAt)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;border:1px solid #fecaca;padding:16px;border-radius:8px">
      <h2 style="color:#b91c1c;margin:0 0 8px">Entry screening alert</h2>
      <p>The e-nose screening at <b>${esc(scan.deviceId)}</b> flagged elevated tobacco-related volatile compounds.</p>
      <table cellpadding="6" style="border-collapse:collapse;width:100%;margin:12px 0">
        <tr style="background:#fee2e2"><td><b>Student</b></td><td>${esc(student.name)} (${esc(student.rollNo)})</td></tr>
        <tr><td><b>Department / Year</b></td><td>${esc(student.department || 'N/A')} - ${esc(student.year || '')} ${esc(student.section || '')}</td></tr>
        <tr style="background:#fef2f2"><td><b>Fingerprint ID</b></td><td>#${student.fingerprintId}</td></tr>
        <tr><td><b>Time</b></td><td>${esc(when)}</td></tr>
        <tr style="background:#fee2e2"><td><b>Score</b></td><td>${(scan.score ?? 0).toFixed(2)} (1.00 = threshold)</td></tr>
        <tr><td><b>MQ-135 / MQ-2 / MQ-7 Delta</b></td><td>+${scan.readings?.mq135 || 0} / +${scan.readings?.mq2 || 0} / +${scan.readings?.mq7 || 0}</td></tr>
      </table>
      <p style="color:#555;font-size:13px">This is a sensor-based screening indicator, not a confirmed result.
      Please verify in person and follow the institution's policy.</p>
    </div>`;
  try {
    const to = await recipientEmails('alert');
    await sendMail({ to, subject, html });
  } catch (e) { console.error('[alert mail]', e.message); }
  await telegram(`Screening alert: ${student.name} (${student.rollNo}) at ${when}. Score ${(scan.score ?? 0).toFixed(2)}. Please verify in person.`);
}

// ---------- attendance report ----------
async function buildReport(date = dateIST()) {
  const students = await Student.find({ active: true }).sort({ rollNo: 1 }).lean();
  const scans = await Scan.find({ date }).sort({ scannedAt: 1 }).lean();
  const lateAfter = process.env.LATE_AFTER || '09:05';

  const map = new Map();
  const flaggedEntries = [];
  let unknownAttempts = 0;

  for (const s of scans) {
    if (s.status === 'UNKNOWN') { unknownAttempts++; continue; }
    const k = String(s.student);
    if (!map.has(k)) map.set(k, { first: s.scannedAt, count: 0, flags: 0 });
    const e = map.get(k);
    e.count++;
    if (s.status === 'ALERT') {
      e.flags++;
      flaggedEntries.push({ rollNo: s.rollNo, name: s.name, time: fmtTime(s.scannedAt), score: s.score });
    }
  }

  const present = [], absent = [];
  for (const st of students) {
    const e = map.get(String(st._id));
    if (!e) { absent.push({ rollNo: st.rollNo, name: st.name, fingerprintId: st.fingerprintId, department: st.department }); continue; }
    present.push({
      rollNo: st.rollNo, name: st.name,
      fingerprintId: st.fingerprintId,
      department: st.department,
      firstEntry: fmtTime(e.first),
      late: hm24(e.first) > lateAfter,
      flagged: e.flags > 0,
      entries: e.count
    });
  }

  return {
    date, lateAfter,
    summary: {
      total: students.length,
      present: present.length,
      absent: absent.length,
      late: present.filter(p => p.late).length,
      flagged: present.filter(p => p.flagged).length,
      unknownAttempts
    },
    present, absent, flaggedEntries
  };
}

const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = "'" + s;           // block spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

function reportToCsv(r) {
  const rows = [['Roll No', 'Name', 'FP ID', 'Dept', 'Status', 'First Entry', 'Late', 'Screening Flag', 'Entries']];
  r.present.forEach(p => rows.push([p.rollNo, p.name, p.fingerprintId, p.department || '', 'Present', p.firstEntry, p.late ? 'Yes' : 'No', p.flagged ? 'FLAGGED' : 'Clear', p.entries]));
  r.absent.forEach(a => rows.push([a.rollNo, a.name, a.fingerprintId, a.department || '', 'Absent', '', '', '', 0]));
  return rows.map(r2 => r2.map(csvCell).join(',')).join('\r\n');
}

function reportToHtml(r) {
  const s = r.summary;
  const th = 'style="text-align:left;background:#f1f5f9;border:1px solid #cbd5e1;padding:6px"';
  const td = 'style="border:1px solid #e2e8f0;padding:6px"';
  const presentRows = r.present.map(p => `<tr>
      <td ${td}>${esc(p.rollNo)}</td><td ${td}>${esc(p.name)}</td><td ${td}>#${p.fingerprintId}</td><td ${td}>${esc(p.firstEntry)}${p.late ? ' <b style="color:#b45309">(late)</b>' : ''}</td>
      <td ${td}>${p.flagged ? '<b style="color:#b91c1c">FLAGGED</b>' : 'Clear'}</td></tr>`).join('');
  const absentRows = r.absent.map(a => `<tr><td ${td}>${esc(a.rollNo)}</td><td ${td}>${esc(a.name)}</td><td ${td}>#${a.fingerprintId}</td></tr>`).join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:720px">
    <h2 style="margin:0">Daily Attendance Report</h2>
    <p style="color:#555;margin:4px 0 14px">Date: <b>${esc(r.date)}</b> &nbsp;|&nbsp; Late after ${esc(r.lateAfter)}</p>
    <p><b>Total:</b> ${s.total} &nbsp; <b>Present:</b> ${s.present} &nbsp; <b>Absent:</b> ${s.absent} &nbsp;
       <b>Late:</b> ${s.late} &nbsp; <b>Screening flags:</b> ${s.flagged} &nbsp; <b>Unrecognised attempts:</b> ${s.unknownAttempts}</p>
    <h3>Present (${s.present})</h3>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}>Roll No</th><th ${th}>Name</th><th ${th}>FP ID</th><th ${th}>First entry</th><th ${th}>Screening</th></tr>${presentRows || `<tr><td ${td} colspan="5">None</td></tr>`}</table>
    <h3>Absent (${s.absent})</h3>
    <table style="border-collapse:collapse;width:100%"><tr><th ${th}>Roll No</th><th ${th}>Name</th><th ${th}>FP ID</th></tr>${absentRows || `<tr><td ${td} colspan="3">None</td></tr>`}</table>
    <p style="color:#666;font-size:12px;margin-top:16px">Screening flags are sensor-based indicators, not confirmed results. Full CSV attached.</p>
  </div>`;
}

async function sendDailyReport(date = dateIST()) {
  const report = await buildReport(date);
  const to = await recipientEmails('report');
  const sent = await sendMail({
    to,
    subject: `Attendance Report ${date} - Present ${report.summary.present}/${report.summary.total}`,
    html: reportToHtml(report),
    attachments: [{ filename: `attendance-${date}.csv`, content: reportToCsv(report), contentType: 'text/csv' }]
  });
  return { sent, to, summary: report.summary };
}

function startScheduler() {
  const expr = process.env.REPORT_CRON || '30 16 * * 1-5';
  if (!cron.validate(expr)) { console.error('Invalid REPORT_CRON:', expr); return; }
  cron.schedule(expr, async () => {
    try { console.log('[report]', await sendDailyReport()); }
    catch (e) { console.error('[report] failed:', e.message); }
  }, { timezone: TZ });
  console.log(`[scheduler] daily report cron "${expr}" (${TZ})`);
}

module.exports = {
  dateIST,
  fmtTime,
  verifySmtp,
  sendTestEmail,
  notifyAlert,
  buildReport,
  reportToCsv,
  sendDailyReport,
  startScheduler
};
