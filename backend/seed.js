// Sample data for testing:  npm run seed
require('dotenv').config();
const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('DNS configure warning:', e.message);
}

const mongoose = require('mongoose');
const { Student, Recipient } = require('./models');

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB Atlas');

    const existingCount = await Student.countDocuments();
    if (existingCount === 0) {
      await Student.insertMany([
        { fingerprintId: 1, rollNo: '23MCA001', name: 'Dinesh Kumar', department: 'MCA', year: 'II', section: 'A', email: 'dinesh267204@gmail.com' },
        { fingerprintId: 2, rollNo: '23MCA002', name: 'Gokulnath R', department: 'MCA', year: 'II', section: 'A', email: 'gokul@college.edu' },
        { fingerprintId: 3, rollNo: '23MCA003', name: 'Karthik S', department: 'MCA', year: 'II', section: 'A', email: 'karthik@college.edu' }
      ]);
      console.log('Seeded sample real student biometric profiles (IDs #1, #2, #3)');
    } else {
      console.log(`Database already has ${existingCount} students. Preserving existing records.`);
    }

    const recCount = await Recipient.countDocuments();
    if (recCount === 0) {
      const hodEmail = (process.env.HOD_EMAIL || 'dinesh267204@gmail.com').toLowerCase().trim();
      const facEmail = (process.env.FACULTY_EMAIL || 'faculty@college.edu').toLowerCase().trim();

      const recipientsToInsert = [
        { name: 'Dr. HOD & Faculty In-Charge', email: hodEmail, role: 'HOD', receiveAlerts: true, receiveReports: true }
      ];

      if (facEmail && facEmail !== hodEmail) {
        recipientsToInsert.push({ name: 'Faculty Coordinator', email: facEmail, role: 'FACULTY', receiveAlerts: true, receiveReports: false });
      }

      await Recipient.insertMany(recipientsToInsert);
      console.log(`Seeded ${recipientsToInsert.length} alert/report recipient(s)`);
    }

    await mongoose.disconnect();
    console.log('Seed completed successfully.');
  } catch (err) {
    console.error('Seed error:', err.message);
    process.exit(1);
  }
})();
