require('dotenv').config(); // Load .env variables
const express = require('express');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri);

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
