require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors()); // 🔓 Enable CORS
app.use(express.json());

const mongoUrl = process.env.MONGO_URL;

console.log('🔗 Mongo URL:', mongoUrl); // ← ADD THIS LINE

const client = new MongoClient(mongoUrl);

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('brynsaleads'); // Match your cluster/database name
    const leads = db.collection('leads');

    app.post('/save-lead', async (req, res) => {
      try {
        const lead = req.body;

        if (!lead.name || !lead.email) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // 🛡️ Check if lead already exists by LinkedIn URL
const existing = await leads.findOne({ linkedinUrl: lead.linkedinUrl });
if (existing) {
  return res.status(200).json({ message: 'Lead already exists', inserted: false });
}

        await leads.insertOne(lead);
        res.status(200).json({ success: true, message: 'Lead saved to MongoDB!' });
      } catch (err) {
        console.error('❌ Insert failed:', err.message);
        res.status(500).json({ success: false, message: 'Failed to save lead.' });
      }
    });

    app.listen(3000, () => {
      console.log('🚀 Server is running on http://localhost:3000');
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
