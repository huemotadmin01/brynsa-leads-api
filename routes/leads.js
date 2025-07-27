// routes/leads.js
const express = require('express');
const router = express.Router();

router.post('/', async (req, res) => {
  const { name, email, company, title, salesperson, source } = req.body;

  if (!name || !email || !company || !title || !salesperson) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  try {
    const db = req.app.locals.db;
    const result = await db.collection('leads').insertOne({
      name,
      email,
      company,
      title,
      salesperson,
      source: source || 'Chrome Extension',
      createdAt: new Date()
    });

    res.json({ success: true, insertedId: result.insertedId });
  } catch (err) {
    console.error('❌ Insert error:', err);
    res.status(500).json({ success: false, message: 'Failed to insert lead.' });
  }
});

module.exports = router;
