// Enhanced index.js with CRM integration
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const mongoUrl = process.env.MONGO_URL;
const client = new MongoClient(mongoUrl);

// Encryption key for storing sensitive CRM credentials
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32);

// Helper functions for encryption/decryption
function encrypt(text) {
  const cipher = crypto.createCipher('aes-256-cbc', ENCRYPTION_KEY);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

function decrypt(encryptedText) {
  const decipher = crypto.createDecipher('aes-256-cbc', ENCRYPTION_KEY);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Helper: simple email validator
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e || '');
}

// Helper: check if user is admin
function isAdmin(userEmail) {
  return userEmail === 'priyanshu.sahu@huemot.com';
}

// CRM Export Functions
async function exportToOdoo(leadData, crmConfig) {
  try {
    const odooPayload = {
      name: leadData.name,
      email: leadData.email,
      phone: leadData.phone || '',
      function: leadData.currentTitle || leadData.headline,
      website: leadData.linkedinUrl,
      street: leadData.location || '',
      comment: `Sourced by: ${leadData.sourcedBy}\nCompany: ${leadData.companyName}`,
      is_company: false,
      customer_rank: 1, // Mark as customer
      supplier_rank: 0,
      partner_type: 'contact'
    };

    const response = await fetch(`${crmConfig.endpointUrl}/api/res.partner`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${crmConfig.username}:${decrypt(crmConfig.password)}`).toString('base64')}`
      },
      body: JSON.stringify(odooPayload)
    });

    if (!response.ok) {
      throw new Error(`Odoo API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return { success: true, crmId: result.id, crmType: 'odoo' };

  } catch (error) {
    console.error('Odoo export error:', error);
    throw new Error(`Odoo export failed: ${error.message}`);
  }
}

async function exportToSalesforce(leadData, crmConfig) {
  try {
    // First, get access token
    const authResponse = await fetch(`${crmConfig.endpointUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: crmConfig.clientId,
        client_secret: decrypt(crmConfig.clientSecret),
        username: crmConfig.username,
        password: decrypt(crmConfig.password)
      })
    });

    if (!authResponse.ok) {
      throw new Error(`Salesforce auth failed: ${authResponse.status}`);
    }

    const authData = await authResponse.json();

    // Create lead in Salesforce
    const sfPayload = {
      FirstName: leadData.name.split(' ')[0],
      LastName: leadData.name.split(' ').slice(1).join(' ') || leadData.name,
      Email: leadData.email,
      Company: leadData.companyName,
      Title: leadData.currentTitle || leadData.headline,
      Website: leadData.linkedinUrl,
      City: leadData.location ? leadData.location.split(',')[0] : '',
      Description: `Sourced by: ${leadData.sourcedBy}`,
      LeadSource: 'LinkedIn Outreach',
      Status: 'Open - Not Contacted'
    };

    const leadResponse = await fetch(`${crmConfig.endpointUrl}/services/data/v58.0/sobjects/Lead/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authData.access_token}`
      },
      body: JSON.stringify(sfPayload)
    });

    if (!leadResponse.ok) {
      throw new Error(`Salesforce lead creation failed: ${leadResponse.status}`);
    }

    const leadResult = await leadResponse.json();
    return { success: true, crmId: leadResult.id, crmType: 'salesforce' };

  } catch (error) {
    console.error('Salesforce export error:', error);
    throw new Error(`Salesforce export failed: ${error.message}`);
  }
}

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('brynsaleads');
    const leads = db.collection('leads');
    const crmConfigs = db.collection('crm_configs');
    const exportLogs = db.collection('export_logs');

    // Create indexes
    await crmConfigs.createIndex({ userId: 1, crmType: 1 }, { unique: true });
    await exportLogs.createIndex({ leadId: 1, crmType: 1 });

    // ========== EXISTING ROUTES ==========
    
    // Lookup by LinkedIn URL
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

    // Upsert email when placeholder
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

    // Insert lead
    app.post('/api/leads', async (req, res) => {
      try {
        const lead = req.body;

        if (!lead.name || !lead.email) {
          return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Check if lead already exists by LinkedIn URL
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

    // ========== NEW CRM CONFIGURATION ROUTES ==========

    // Get CRM configurations (Admin only)
    app.get('/api/crm/configs', async (req, res) => {
      try {
        const { userEmail } = req.query;
        
        if (!userEmail || !isAdmin(userEmail)) {
          return res.status(403).json({ error: 'Admin access required' });
        }

        const configs = await crmConfigs.find({}, {
          projection: { 
            crmType: 1, 
            endpointUrl: 1, 
            username: 1, 
            databaseName: 1,
            clientId: 1,
            isActive: 1,
            createdAt: 1,
            updatedAt: 1
            // Exclude encrypted fields from response
          }
        }).toArray();

        res.json({ configs });
      } catch (err) {
        console.error('❌ Get CRM configs failed:', err.message);
        res.status(500).json({ error: 'Failed to fetch CRM configurations' });
      }
    });

    // Save/Update CRM configuration (Admin only)
    app.post('/api/crm/config', async (req, res) => {
      try {
        const { userEmail, crmType, endpointUrl, username, password, databaseName, clientId, clientSecret } = req.body;
        
        if (!userEmail || !isAdmin(userEmail)) {
          return res.status(403).json({ error: 'Admin access required' });
        }

        if (!crmType || !endpointUrl || !username || !password) {
          return res.status(400).json({ error: 'Missing required fields' });
        }

        if (!['odoo', 'salesforce'].includes(crmType)) {
          return res.status(400).json({ error: 'Invalid CRM type. Must be odoo or salesforce' });
        }

        // Validate Salesforce-specific fields
        if (crmType === 'salesforce' && (!clientId || !clientSecret)) {
          return res.status(400).json({ error: 'Salesforce requires clientId and clientSecret' });
        }

        const configData = {
          userId: userEmail,
          crmType,
          endpointUrl: endpointUrl.replace(/\/$/, ''), // Remove trailing slash
          username,
          password: encrypt(password),
          databaseName: databaseName || null,
          clientId: clientId || null,
          clientSecret: clientSecret ? encrypt(clientSecret) : null,
          isActive: true,
          updatedAt: new Date()
        };

        const result = await crmConfigs.updateOne(
          { userId: userEmail, crmType },
          { 
            $set: configData,
            $setOnInsert: { createdAt: new Date() }
          },
          { upsert: true }
        );

        res.json({ 
          success: true, 
          message: `${crmType} configuration ${result.upsertedId ? 'created' : 'updated'} successfully`,
          configId: result.upsertedId || result.upsertedId
        });

      } catch (err) {
        console.error('❌ Save CRM config failed:', err.message);
        res.status(500).json({ error: 'Failed to save CRM configuration' });
      }
    });

    // Test CRM connection (Admin only)
    app.post('/api/crm/test', async (req, res) => {
      try {
        const { userEmail, crmType } = req.body;
        
        if (!userEmail || !isAdmin(userEmail)) {
          return res.status(403).json({ error: 'Admin access required' });
        }

        const config = await crmConfigs.findOne({ userId: userEmail, crmType, isActive: true });
        if (!config) {
          return res.status(404).json({ error: 'CRM configuration not found' });
        }

        let testResult;
        if (crmType === 'odoo') {
          // Test Odoo connection
          const response = await fetch(`${config.endpointUrl}/api/res.partner?limit=1`, {
            method: 'GET',
            headers: {
              'Authorization': `Basic ${Buffer.from(`${config.username}:${decrypt(config.password)}`).toString('base64')}`
            }
          });
          testResult = { success: response.ok, status: response.status };
        } else if (crmType === 'salesforce') {
          // Test Salesforce connection
          const authResponse = await fetch(`${config.endpointUrl}/services/oauth2/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'password',
              client_id: config.clientId,
              client_secret: decrypt(config.clientSecret),
              username: config.username,
              password: decrypt(config.password)
            })
          });
          testResult = { success: authResponse.ok, status: authResponse.status };
        }

        res.json(testResult);

      } catch (err) {
        console.error('❌ Test CRM connection failed:', err.message);
        res.status(500).json({ error: 'Connection test failed', details: err.message });
      }
    });

    // ========== CRM EXPORT ROUTES ==========

    // Export lead to CRM
    app.post('/api/leads/:leadId/export', async (req, res) => {
      try {
        const { leadId } = req.params;
        const { userEmail, crmType } = req.body;

        if (!userEmail) {
          return res.status(400).json({ error: 'User email required' });
        }

        // Get lead data
        const lead = await leads.findOne({ _id: new require('mongodb').ObjectId(leadId) });
        if (!lead) {
          return res.status(404).json({ error: 'Lead not found' });
        }

        // Check if already exported to this CRM
        const existingExport = await exportLogs.findOne({ 
          leadId: leadId, 
          crmType, 
          status: 'success' 
        });

        if (existingExport) {
          return res.status(400).json({ 
            error: 'Lead already exported to this CRM',
            exportDate: existingExport.exportedAt,
            crmId: existingExport.crmId
          });
        }

        // Get CRM configuration (use admin config for all users)
        const adminEmail = 'priyanshu.sahu@huemot.com';
        const crmConfig = await crmConfigs.findOne({ 
          userId: adminEmail, 
          crmType, 
          isActive: true 
        });

        if (!crmConfig) {
          return res.status(404).json({ error: `${crmType} not configured. Please contact admin.` });
        }

        // Export to CRM
        let exportResult;
        if (crmType === 'odoo') {
          exportResult = await exportToOdoo(lead, crmConfig);
        } else if (crmType === 'salesforce') {
          exportResult = await exportToSalesforce(lead, crmConfig);
        } else {
          return res.status(400).json({ error: 'Invalid CRM type' });
        }

        // Log the export
        await exportLogs.insertOne({
          leadId: leadId,
          leadName: lead.name,
          leadEmail: lead.email,
          crmType,
          crmId: exportResult.crmId,
          exportedBy: userEmail,
          exportedAt: new Date(),
          status: 'success'
        });

        res.json({
          success: true,
          message: `Lead exported to ${crmType} successfully`,
          crmId: exportResult.crmId
        });

      } catch (err) {
        console.error('❌ CRM export failed:', err.message);
        
        // Log failed export
        await exportLogs.insertOne({
          leadId: req.params.leadId,
          crmType: req.body.crmType,
          exportedBy: req.body.userEmail,
          exportedAt: new Date(),
          status: 'failed',
          errorMessage: err.message
        }).catch(console.error);

        res.status(500).json({ error: 'Export failed', details: err.message });
      }
    });

    // Get export history for a lead
    app.get('/api/leads/:leadId/exports', async (req, res) => {
      try {
        const { leadId } = req.params;
        
        const exports = await exportLogs.find(
          { leadId },
          { 
            projection: { 
              crmType: 1, 
              crmId: 1, 
              exportedBy: 1, 
              exportedAt: 1, 
              status: 1 
            } 
          }
        ).sort({ exportedAt: -1 }).toArray();

        res.json({ exports });
      } catch (err) {
        console.error('❌ Get export history failed:', err.message);
        res.status(500).json({ error: 'Failed to fetch export history' });
      }
    });

    // Get available CRM types for export
    app.get('/api/crm/available', async (req, res) => {
      try {
        const adminEmail = 'priyanshu.sahu@huemot.com';
        
        const availableCRMs = await crmConfigs.find(
          { userId: adminEmail, isActive: true },
          { projection: { crmType: 1, _id: 0 } }
        ).toArray();

        res.json({ 
          crms: availableCRMs.map(c => c.crmType)
        });
      } catch (err) {
        console.error('❌ Get available CRMs failed:', err.message);
        res.status(500).json({ error: 'Failed to fetch available CRMs' });
      }
    });

    app.listen(3000, () => {
      console.log('🚀 Server running on http://localhost:3000');
      console.log('🔧 CRM Integration enabled - Odoo & Salesforce');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
