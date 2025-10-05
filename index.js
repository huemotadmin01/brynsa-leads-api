require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const mongoUrl = process.env.MONGO_URL;

console.log('🔗 Mongo URL:', mongoUrl);

const client = new MongoClient(mongoUrl);

// helper: simple email validator
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e || '');
}

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('brynsaleads');
    const leads = db.collection('leads');
    const exportLogs = db.collection('export_logs');

    // Create indexes for exportLogs
    await exportLogs.createIndex({ linkedinUrl: 1, exportedBy: 1 });
    await exportLogs.createIndex({ leadId: 1, crmType: 1 });

    // ------------------ LOOKUP BY LINKEDIN URL ------------------
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

    // ------------------ UPSERT EMAIL WHEN PLACEHOLDER ------------------
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

    // ------------------ INSERT LEAD ------------------
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

    // ========== ODOO CRM EXPORT ENDPOINTS (FIXED SESSION HANDLING) ==========

    // Direct Odoo Export Endpoint using JSON-RPC with proper session handling
    app.post('/api/crm/export-odoo', async (req, res) => {
      try {
        const { leadData, crmConfig, userEmail, linkedinUrl } = req.body;

        if (!leadData || !leadData.name) {
          return res.status(400).json({ error: 'Lead data with name is required' });
        }

        if (!crmConfig || !crmConfig.endpointUrl || !crmConfig.username || !crmConfig.password) {
          return res.status(400).json({ error: 'CRM configuration is incomplete' });
        }

        console.log('📤 Odoo export request:', {
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
          console.log('ℹ️ Lead already exported:', existingExport.crmId);
          return res.status(200).json({
            success: true,
            message: 'Lead already exported to Odoo',
            crmId: existingExport.crmId,
            crmType: 'odoo',
            alreadyExisted: true,
            exportedAt: existingExport.exportedAt
          });
        }

        // Step 1: Authenticate with Odoo
        console.log('🔐 Authenticating with Odoo...');
        
        const authUrl = `${crmConfig.endpointUrl}/web/session/authenticate`;
        const authPayload = {
          jsonrpc: "2.0",
          params: {
            db: crmConfig.databaseName,
            login: crmConfig.username,
            password: crmConfig.password
          }
        };

        const authResponse = await fetch(authUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(authPayload)
        });

        if (!authResponse.ok) {
          const errorText = await authResponse.text().catch(() => 'Unknown error');
          console.error('❌ Odoo authentication failed:', errorText);
          throw new Error(`Odoo authentication failed: ${authResponse.status}`);
        }

        // Extract cookies from auth response
        const setCookieHeader = authResponse.headers.get('set-cookie');
        let cookies = '';
        if (setCookieHeader) {
          // Parse all cookies from the Set-Cookie header
          const cookieArray = setCookieHeader.split(',').map(cookie => {
            const parts = cookie.trim().split(';');
            return parts[0]; // Get only the name=value part
          });
          cookies = cookieArray.join('; ');
        }

        const authResult = await authResponse.json();
        
        if (!authResult.result || authResult.result.uid === false) {
          console.error('❌ Odoo authentication failed:', authResult);
          throw new Error('Invalid Odoo credentials');
        }

        const userId = authResult.result.uid;
        const sessionId = authResult.result.session_id;
        
        // Construct cookie string
        if (!cookies && sessionId) {
          cookies = `session_id=${sessionId}`;
        }
        
        console.log('✅ Authenticated successfully. User ID:', userId);

        // Step 2: Create partner record using the same session
        console.log('🔄 Creating contact in Odoo...');

        const createUrl = `${crmConfig.endpointUrl}/web/dataset/call_kw/res.partner/create`;
        const createPayload = {
          jsonrpc: "2.0",
          method: "call",
          params: {
            args: [{
              name: leadData.name,
              email: leadData.email || '',
              phone: leadData.phone || '',
              function: leadData.function || '',
              website: leadData.website || '',
              street: leadData.street || '',
              comment: leadData.comment || '',
              is_company: false,
              customer_rank: 1
            }],
            kwargs: {
              context: {
                lang: "en_US",
                tz: false,
                uid: userId
              }
            }
          },
          id: Date.now()
        };

        const createResponse = await fetch(createUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': cookies
          },
          body: JSON.stringify(createPayload)
        });

        if (!createResponse.ok) {
          const errorText = await createResponse.text().catch(() => 'Unknown error');
          console.error('❌ Odoo contact creation failed:', errorText);
          throw new Error(`Odoo contact creation failed: ${createResponse.status}`);
        }

        const createResult = await createResponse.json();
        
        if (createResult.error) {
          console.error('❌ Odoo API error:', createResult.error);
          throw new Error(createResult.error.data?.message || createResult.error.message || 'Odoo API error');
        }

        const contactId = createResult.result;
        console.log('✅ Odoo contact created successfully. ID:', contactId);

        // Log export to database
        try {
          await exportLogs.insertOne({
            leadName: leadData.name,
            leadEmail: leadData.email,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            crmId: contactId,
            exportedBy: userEmail,
            exportedAt: new Date(),
            status: 'success',
            odooUserId: userId
          });
          console.log('📝 Export logged to database');
        } catch (logError) {
          console.warn('⚠️ Failed to log export:', logError.message);
        }

        res.json({
          success: true,
          message: 'Lead exported to Odoo successfully',
          crmId: contactId,
          crmType: 'odoo'
        });

      } catch (error) {
        console.error('❌ Odoo export error:', error);
        
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
          console.warn('⚠️ Failed to log error:', logError.message);
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
          return res.status(400).json({ 
            error: 'URL and userEmail are required',
            alreadyExported: false 
          });
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
        console.error('❌ Export check error:', error);
        res.status(200).json({
          alreadyExported: false,
          error: error.message
        });
      }
    });

    console.log('✅ Odoo CRM export endpoints registered');

    app.listen(3000, () => {
      console.log('🚀 Server is running on http://localhost:3000');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
