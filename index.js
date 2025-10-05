require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors()); // 🔓 Enable CORS
app.use(express.json());

const mongoUrl = process.env.MONGO_URL;

console.log('🔗 Mongo URL:', mongoUrl); // ← existing log

const client = new MongoClient(mongoUrl);

// helper: simple email validator
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e || '');
}

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('brynsaleads'); // Match your cluster/database name
    const leads = db.collection('leads');

    // ------------------ NEW: LOOKUP BY LINKEDIN URL ------------------
    // GET /api/leads/lookup?linkedinUrl=<full profile url>
    app.get('/api/leads/lookup', async (req, res) => {
      try {
        const { linkedinUrl } = req.query;
        if (!linkedinUrl) {
          return res.status(400).json({ exists: false, error: 'linkedinUrl required' });
        }

        const found = await leads.findOne(
          { linkedinUrl },
          { projection: { email: 1, linkedinUrl: 1 } }
        );

        if (!found) return res.json({ exists: false });

        const email = isValidEmail(found.email) && found.email.toLowerCase() !== 'noemail@domain.com'
          ? found.email
          : null;

        return res.json({ exists: true, email });
      } catch (err) {
        console.error('❌ Lookup failed:', err.message);
        res.status(500).json({ exists: false, error: 'server_error' });
      }
    });

    // ------------------ NEW: UPSERT EMAIL WHEN PLACEHOLDER ------------------
    // PUT /api/leads/upsert-email  { linkedinUrl, email }
    app.put('/api/leads/upsert-email', async (req, res) => {
      try {
        const { linkedinUrl, email } = req.body || {};
        if (!linkedinUrl || !isValidEmail(email)) {
          return res.status(400).json({ updated: false, error: 'linkedinUrl and valid email required' });
        }

        const result = await leads.updateOne(
          {
            linkedinUrl,
            $or: [
              { email: { $exists: false } },
              { email: null },
              { email: '' },
              { email: 'noemail@domain.com' }
            ]
          },
          { $set: { email } }
        );

        return res.json({ updated: result.modifiedCount > 0 });
      } catch (err) {
        console.error('❌ Upsert-email failed:', err.message);
        res.status(500).json({ updated: false, error: 'server_error' });
      }
    });

    // ------------------ EXISTING INSERT ROUTE (left untouched) ------------------
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

    app.listen(3000, () => {
      console.log('🚀 Server is running on http://localhost:3000');
    });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

// ========== ODOO CRM EXPORT ENDPOINTS ==========

// Direct Odoo Export Endpoint
app.post('/api/crm/export-odoo', async (req, res) => {
  try {
    const { leadData, crmConfig, userEmail, linkedinUrl } = req.body;

    if (!leadData || !leadData.name) {
      return res.status(400).json({ error: 'Lead data with name is required' });
    }

    if (!crmConfig || !crmConfig.endpointUrl || !crmConfig.username || !crmConfig.password) {
      return res.status(400).json({ error: 'CRM configuration is incomplete' });
    }

    console.log('Odoo export request:', {
      lead: leadData.name,
      user: userEmail,
      endpoint: crmConfig.endpointUrl
    });

    // Check if already exported to avoid duplicates
    const existingExport = await exportLogs.findOne({
      linkedinUrl: linkedinUrl,
      exportedBy: userEmail,
      crmType: 'odoo',
      status: 'success'
    });

    if (existingExport) {
      console.log('Lead already exported:', existingExport);
      return res.status(200).json({
        success: true,
        message: 'Lead already exported to Odoo',
        crmId: existingExport.crmId,
        crmType: 'odoo',
        alreadyExisted: true,
        exportedAt: existingExport.exportedAt
      });
    }

    // Prepare Odoo API payload
    const odooPayload = {
      name: leadData.name,
      email: leadData.email || '',
      phone: leadData.phone || '',
      function: leadData.function || '',
      website: leadData.website || '',
      street: leadData.street || '',
      comment: leadData.comment || '',
      is_company: false,
      customer_rank: 1,
      supplier_rank: 0,
      partner_type: 'contact'
    };

    console.log('Calling Odoo API at:', crmConfig.endpointUrl);

    // Call Odoo API
    const odooResponse = await fetch(`${crmConfig.endpointUrl}/api/res.partner`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${crmConfig.username}:${crmConfig.password}`).toString('base64')}`
      },
      body: JSON.stringify(odooPayload)
    });

    if (!odooResponse.ok) {
      const errorText = await odooResponse.text().catch(() => 'Unknown error');
      console.error('Odoo API error:', {
        status: odooResponse.status,
        statusText: odooResponse.statusText,
        error: errorText
      });
      
      throw new Error(`Odoo API error: ${odooResponse.status} - ${errorText}`);
    }

    const odooResult = await odooResponse.json();
    console.log('Odoo export successful:', odooResult);

    // Log export to database
    try {
      await exportLogs.insertOne({
        leadName: leadData.name,
        leadEmail: leadData.email,
        linkedinUrl: linkedinUrl,
        crmType: 'odoo',
        crmId: odooResult.id || odooResult.result?.id || 'unknown',
        exportedBy: userEmail,
        exportedAt: new Date(),
        status: 'success',
        odooResponse: odooResult
      });
      console.log('Export logged to database');
    } catch (logError) {
      console.warn('Failed to log export:', logError.message);
      // Don't fail the export if logging fails
    }

    res.json({
      success: true,
      message: 'Lead exported to Odoo successfully',
      crmId: odooResult.id || odooResult.result?.id || 'created',
      crmType: 'odoo'
    });

  } catch (error) {
    console.error('Odoo export error:', error);
    
    // Log failed export
    try {
      await exportLogs.insertOne({
        leadName: req.body.leadData?.name,
        linkedinUrl: req.body.linkedinUrl,
        crmType: 'odoo',
        exportedBy: req.body.userEmail,
        exportedAt: new Date(),
        status: 'failed',
        errorMessage: error.message,
        errorStack: error.stack
      });
    } catch (logError) {
      console.warn('Failed to log error:', logError.message);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to export to Odoo CRM'
    });
  }
});

// Check if lead was already exported
app.get('/api/crm/check-export', async (req, res) => {
  try {
    const { url, userEmail } = req.query;

    if (!url || !userEmail) {
      return res.status(400).json({ error: 'URL and userEmail are required' });
    }

    const existingExport = await exportLogs.findOne({
      linkedinUrl: url,
      exportedBy: userEmail,
      status: 'success',
      crmType: 'odoo'
    });

    if (existingExport) {
      return res.json({
        alreadyExported: true,
        exportedAt: existingExport.exportedAt,
        crmId: existingExport.crmId,
        crmType: existingExport.crmType
      });
    }

    res.json({ alreadyExported: false });

  } catch (error) {
    console.error('Export check error:', error);
    res.status(500).json({
      error: 'Failed to check export status',
      alreadyExported: false
    });
  }
});

console.log('✅ Odoo CRM export endpoints registered');

startServer();
