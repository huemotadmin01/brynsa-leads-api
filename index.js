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
    app.post('/api/leads', async (req, res) => {
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


    /*const fetch = require('node-fetch'); // make sure this is installed

    app.post('/proxy-to-sheet', async (req, res) => {
      try {
        const googleSheetWebhook = 'https://script.google.com/macros/s/AKfycbxggAKO9lOHYqCe881LL6wOvVmW4lD98d2i505HfRI9rvHmADQC1nn0xpY74SNR1L5s/exec';
    
        const response = await fetch(googleSheetWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body)
        });
    
        const text = await response.text();
        console.log('✅ Google Sheets response:', text);
        res.status(200).json({ success: true, googleResponse: text });
      } catch (err) {
        console.error('❌ Proxy to Google Sheets failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });*/
    

    


    app.listen(3000, () => {
      console.log('🚀 Server is running on http://localhost:3000');
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
