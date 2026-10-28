require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const mongoose = require('mongoose');
const routes = require('./routes');
const { startScheduler } = require('./services');

for (const k of ['MONGODB_URI', 'DEVICE_API_KEY', 'ADMIN_API_KEY']) {
  if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const app = express();
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.use('/api', routes);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => {
  if (err.code === 11000) return res.status(409).json({ error: 'duplicate value', detail: err.keyValue });
  if (err.name === 'ValidationError' || err.name === 'CastError') return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});

const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, '0.0.0.0', () => console.log(`API listening on :${PORT}`));
    startScheduler();
  })
  .catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
