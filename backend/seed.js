// Sample data for testing:  npm run seed
require('dotenv').config();
const mongoose = require('mongoose');
const { Student, Recipient } = require('./models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Student.deleteMany({});
  await Recipient.deleteMany({});
  await Student.insertMany([
    { fingerprintId: 1, rollNo: 'MCA001', name: 'Student One',   department: 'MCA', year: 'II', section: 'A' },
    { fingerprintId: 2, rollNo: 'MCA002', name: 'Student Two',   department: 'MCA', year: 'II', section: 'A' },
    { fingerprintId: 3, rollNo: 'MCA003', name: 'Student Three', department: 'MCA', year: 'II', section: 'A' }
  ]);
  await Recipient.insertMany([
    { name: 'HOD',     email: process.env.HOD_EMAIL     || 'hod@college.edu',     role: 'HOD',     receiveAlerts: true, receiveReports: true },
    { name: 'Faculty', email: process.env.FACULTY_EMAIL || 'faculty@college.edu', role: 'FACULTY', receiveAlerts: true, receiveReports: false }
  ]);
  console.log('Seeded 3 students and 2 recipients');
  await mongoose.disconnect();
})();
