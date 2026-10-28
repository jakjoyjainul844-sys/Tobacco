require('dotenv').config();
const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('DNS configure warning:', e.message);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const mongoose = require('mongoose');
const routes = require('./routes');
const { startScheduler } = require('./services');

for (const k of ['MONGODB_URI', 'DEVICE_API_KEY', 'ADMIN_API_KEY']) {
  if (!process.env[k]) {
    console.error(`Missing ${k} in .env`);
    process.exit(1);
  }
}

const app = express();

// CORS & Security headers
app.use(cors());
app.use(
  helmet({
    contentSecurityPolicy: false // Allow inline scripts/styles for dashboard
  })
);
app.use(express.json({ limit: '50kb' }));

// Serve Web Dashboard
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    db: mongoose.connection.readyState === 1,
    time: new Date().toISOString()
  });
});

app.use('/api', routes);

// Fallback for SPA dashboard
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, _req, res, _next) => {
  if (err.code === 11000) return res.status(409).json({ error: 'duplicate value', detail: err.keyValue });
  if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ error: err.message });
  console.error('[server error]', err);
  res.status(500).json({ error: 'server error', message: err.message });
});

const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ MongoDB connected successfully');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Smart Classroom API & Dashboard listening on :${PORT}`);
      console.log(`🌐 Web Dashboard: http://localhost:${PORT}`);
    });
    startScheduler();
  })
  .catch(e => {
    console.error('❌ MongoDB connection failed:', e.message);
    process.exit(1);
  });
