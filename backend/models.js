const mongoose = require('mongoose');
const { Schema } = mongoose;

const studentSchema = new Schema({
  fingerprintId: { type: Number, required: true, unique: true, min: 1 },
  rollNo: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  department: { type: String, default: '', trim: true },
  year: { type: String, default: '' },
  section: { type: String, default: '' },
  email: { type: String, default: '', lowercase: true, trim: true },
  phone: { type: String, default: '', trim: true },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const recipientSchema = new Schema({
  name: { type: String, default: '' },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  role: { type: String, enum: ['HOD', 'FACULTY'], default: 'FACULTY' },
  receiveAlerts: { type: Boolean, default: true },
  receiveReports: { type: Boolean, default: true },
  active: { type: Boolean, default: true }
}, { timestamps: true });

const scanSchema = new Schema({
  deviceId: String,
  date: { type: String, index: true },              // YYYY-MM-DD in local (IST) time
  scannedAt: { type: Date, default: Date.now, index: true },
  fingerprintId: Number,
  student: { type: Schema.Types.ObjectId, ref: 'Student' },
  rollNo: String,
  name: String,
  status: { type: String, enum: ['CLEAR', 'ALERT', 'UNKNOWN'], required: true },
  score: Number,
  readings: { mq135: Number, mq2: Number, mq7: Number, temperature: Number, humidity: Number }
});
scanSchema.index({ student: 1, date: 1 });

const telemetrySchema = new Schema({
  deviceId: String,
  temperature: Number, humidity: Number,
  mq135: Number, mq2: Number, mq7: Number,
  distance: Number, rssi: Number,
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }   // auto-delete after 30 days
});

const deviceCommandSchema = new Schema({
  deviceId: { type: String, default: 'CLASSROOM-101' },
  command: { type: String, required: true }, // 'enroll', 'delete', 'sync'
  payload: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'], default: 'PENDING' },
  result: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now, expires: 600 }
});

module.exports = {
  Student: mongoose.model('Student', studentSchema),
  Recipient: mongoose.model('Recipient', recipientSchema),
  Scan: mongoose.model('Scan', scanSchema),
  Telemetry: mongoose.model('Telemetry', telemetrySchema),
  DeviceCommand: mongoose.model('DeviceCommand', deviceCommandSchema)
};
