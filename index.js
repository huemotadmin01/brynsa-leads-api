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

    // ========== ODOO CRM EXPORT - COMPLETE WORKFLOW WITH VALIDATION ==========
app.post('/api/crm/export-odoo', async (req, res) => {
  try {
    const { leadData, crmConfig, userEmail, linkedinUrl } = req.body;

    // ADD THIS DEBUG LOGGING
    console.log('==================== DEBUG START ====================');
    console.log('Full request body:', JSON.stringify(req.body, null, 2));
    console.log('leadData object:', leadData);
    console.log('leadData.name:', leadData?.name);
    console.log('leadData.companyName:', leadData?.companyName);
    console.log('leadData.company:', leadData?.company);
    console.log('==================== DEBUG END ====================');

    // Enhanced validation
    if (!leadData || !leadData.name) {
      return res.status(400).json({ error: 'Lead data with name is required' });
    }

    // Validate name length
    const cleanName = (leadData.name || '').trim();
    if (cleanName.length < 2) {
      return res.status(400).json({ 
        error: 'Invalid name. Name must be at least 2 characters.',
        receivedName: leadData.name 
      });
    }

    // FIX: Check both companyName and company fields
    const cleanCompany = (leadData.companyName || leadData.company || '').trim();
    if (!cleanCompany || cleanCompany.length < 2) {
      return res.status(400).json({ 
        error: 'Invalid company name. Company name must be at least 2 characters.',
        receivedCompany: leadData.companyName,
        receivedCompanyAlt: leadData.company,
        allLeadDataKeys: Object.keys(leadData)
      });
    }

        if (!crmConfig || !crmConfig.endpointUrl || !crmConfig.username || !crmConfig.password) {
          return res.status(400).json({ error: 'CRM configuration is incomplete' });
        }

        console.log('Odoo CRM export:', {
          lead: cleanName,
          company: cleanCompany,
          sourcedBy: leadData.sourcedBy
        });

        // Check if already exported
        const existingExport = await exportLogs.findOne({
          linkedinUrl: linkedinUrl,
          exportedBy: userEmail,
          crmType: 'odoo',
          status: 'success'
        });

        if (existingExport) {
          return res.status(200).json({
            success: true,
            message: 'Lead already exported to Odoo CRM',
            crmId: existingExport.crmId,
            crmType: 'odoo',
            alreadyExisted: true,
            exportedAt: existingExport.exportedAt
          });
        }

        // Step 1: Authenticate
        console.log('Authenticating...');
        const authUrl = `${crmConfig.endpointUrl}/web/session/authenticate`;
        const authResponse = await fetch(authUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: "2.0",
            params: {
              db: crmConfig.databaseName,
              login: crmConfig.username,
              password: crmConfig.password
            }
          })
        });

        if (!authResponse.ok) {
          throw new Error(`Authentication failed: ${authResponse.status}`);
        }

        const setCookieHeader = authResponse.headers.get('set-cookie');
        let cookies = '';
        if (setCookieHeader) {
          cookies = setCookieHeader.split(',').map(c => c.trim().split(';')[0]).join('; ');
        }

        const authResult = await authResponse.json();
        if (!authResult.result?.uid) {
          throw new Error('Invalid Odoo credentials');
        }

        const userId = authResult.result.uid;
        const sessionId = authResult.result.session_id;
        if (!cookies && sessionId) cookies = `session_id=${sessionId}`;

        console.log('Authenticated. User ID:', userId);

        const odooUrl = `${crmConfig.endpointUrl}/jsonrpc`;

        // Helper function to call Odoo
        async function callOdoo(model, method, args) {
          const response = await fetch(odooUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cookie': cookies
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "call",
              params: {
                service: "object",
                method: "execute_kw",
                args: [crmConfig.databaseName, userId, crmConfig.password, model, method, args]
              },
              id: Date.now()
            })
          });

          if (!response.ok) {
            throw new Error(`Odoo API failed: ${response.status}`);
          }

          const result = await response.json();
          if (result.error) {
            console.error('Odoo API Error:', result.error);
            throw new Error(result.error.data?.message || result.error.message || 'Odoo API error');
          }

          return result.result;
        }

        // Step 2: Get LinkedIn source ID
        console.log('Finding LinkedIn source...');
        
        let linkedinSourceId = null;
        const sources = await callOdoo('utm.source', 'search_read', [
          [['name', '=', 'LinkedIn']],
          ['id', 'name']
        ]);
        
        if (sources && sources.length > 0) {
          linkedinSourceId = sources[0].id;
          console.log('LinkedIn source ID:', linkedinSourceId);
        } else {
          console.log('Creating LinkedIn source...');
          linkedinSourceId = await callOdoo('utm.source', 'create', [
            [{ name: 'LinkedIn' }]
          ]);
          console.log('LinkedIn source created. ID:', linkedinSourceId);
        }

        // Step 3: Find salesperson
        console.log('Finding salesperson:', leadData.sourcedBy);
        
        let salespersonId = null;
        if (leadData.sourcedBy) {
          const salespersons = await callOdoo('res.users', 'search_read', [
            [['name', 'ilike', leadData.sourcedBy]],
            ['id', 'name']
          ]);
          
          if (salespersons && salespersons.length > 0) {
            salespersonId = salespersons[0].id;
            console.log('Found salesperson ID:', salespersonId);
          } else {
            console.log('Salesperson not found, using current user');
            salespersonId = userId;
          }
        } else {
          salespersonId = userId;
        }

        // Step 4: Check if company exists
        console.log('Checking company:', cleanCompany);
        
        const existingCompanies = await callOdoo('res.partner', 'search_read', [
          [['name', '=', cleanCompany], ['is_company', '=', true]],
          ['id', 'name', 'user_id']
        ]);

        let companyId;
        let isExistingCompany = false;
        let clientType;

        if (existingCompanies && existingCompanies.length > 0) {
          companyId = existingCompanies[0].id;
          isExistingCompany = true;
          clientType = 'Existing Client';
          console.log('Company exists. ID:', companyId);
        } else {
          console.log('Creating company...');
          companyId = await callOdoo('res.partner', 'create', [
            [{
              name: cleanCompany,
              is_company: true,
              customer_rank: 1,
              user_id: salespersonId,
              website: (leadData.website || '').trim() || false,
              street: (leadData.street || '').trim() || false,
              comment: `Company created via LinkedIn import for ${cleanName}`
            }]
          ]);
          clientType = 'New Prospect';
          console.log('Company created. ID:', companyId);
        }

        // Step 5: Check if individual contact exists
        console.log('Checking contact:', cleanName);
        
        const existingContacts = await callOdoo('res.partner', 'search_read', [
          [['name', '=', cleanName], ['parent_id', '=', companyId]],
          ['id', 'name', 'email']
        ]);

        let contactId;
        let contactAlreadyExists = false;

        if (existingContacts && existingContacts.length > 0) {
          contactId = existingContacts[0].id;
          contactAlreadyExists = true;
          console.log('Contact exists. ID:', contactId);
        } else {
          console.log('Creating contact...');
          
          // Prepare contact data with proper validation
          const contactData = {
            name: cleanName,
            parent_id: companyId,
            type: 'contact',
            is_company: false,
            customer_rank: 1
          };

          // Only add fields if they have valid values
          const email = (leadData.email || '').trim();
          if (email && isValidEmail(email)) {
            contactData.email = email;
          }

          const phone = (leadData.phone || '').trim();
          if (phone) {
            contactData.phone = phone;
          }

          const func = (leadData.function || '').trim();
          if (func) {
            contactData.function = func;
          }

          const website = (leadData.website || '').trim();
          if (website) {
            contactData.website = website;
          }

          const street = (leadData.street || '').trim();
          if (street) {
            contactData.street = street;
          }

          const comment = (leadData.comment || '').trim();
          if (comment) {
            contactData.comment = comment;
          }

          console.log('Contact data:', contactData);
          
          contactId = await callOdoo('res.partner', 'create', [
            [contactData]
          ]);
          console.log('Contact created. ID:', contactId);
        }

        // Step 6: Check if lead exists
        console.log('Checking for existing lead...');
        
        const existingLeads = await callOdoo('crm.lead', 'search_read', [
          [['partner_id', '=', contactId]],
          ['id', 'name']
        ]);

        let leadId;

        if (existingLeads && existingLeads.length > 0) {
          leadId = existingLeads[0].id;
          console.log('Lead exists. ID:', leadId);
          
          await exportLogs.insertOne({
            leadName: cleanName,
            leadEmail: leadData.email,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            crmId: leadId,
            exportedBy: userEmail,
            exportedAt: new Date(),
            status: 'success',
            message: 'Lead already exists',
            companyId: companyId,
            contactId: contactId
          });

          return res.json({
            success: true,
            message: `Lead already exists in Odoo CRM. ${isExistingCompany ? 'Company and contact were found.' : 'New company was created.'}`,
            crmId: leadId,
            crmType: 'odoo',
            details: {
              companyCreated: !isExistingCompany,
              contactCreated: !contactAlreadyExists,
              leadCreated: false,
              clientType: clientType
            }
          });
        }

        // Step 7: Create lead
        console.log('Creating lead with Client Type:', clientType);
        
        const leadCreateData = {
          name: `${cleanName} - LinkedIn Opportunity`,
          partner_id: contactId,
          partner_name: cleanName,
          type: 'opportunity',
          user_id: salespersonId,
          source_id: linkedinSourceId,
          x_studio_client_type: clientType
        };

        // Add optional fields
        const emailFrom = (leadData.email || '').trim();
        if (emailFrom && isValidEmail(emailFrom)) {
          leadCreateData.email_from = emailFrom;
        }

        const phone = (leadData.phone || '').trim();
        if (phone) {
          leadCreateData.phone = phone;
        }

        const func = (leadData.function || '').trim();
        if (func) {
          leadCreateData.function = func;
        }

        const website = (leadData.website || '').trim();
        if (website) {
          leadCreateData.website = website;
        }

        const street = (leadData.street || '').trim();
        if (street) {
          leadCreateData.street = street;
        }

        const description = (leadData.comment || '').trim() || `Sourced from LinkedIn: ${website || ''}`;
        if (description) {
          leadCreateData.description = description;
        }

        console.log('Lead data:', leadCreateData);

        leadId = await callOdoo('crm.lead', 'create', [
          [leadCreateData]
        ]);

        console.log('Lead created. ID:', leadId);

        // Log to database
        await exportLogs.insertOne({
          leadName: cleanName,
          leadEmail: leadData.email,
          linkedinUrl: linkedinUrl,
          crmType: 'odoo',
          crmId: leadId,
          companyId: companyId,
          contactId: contactId,
          exportedBy: userEmail,
          exportedAt: new Date(),
          status: 'success',
          clientType: clientType,
          salespersonId: salespersonId,
          sourceId: linkedinSourceId
        });

        res.json({
          success: true,
          message: `Successfully exported to Odoo CRM as ${clientType} from LinkedIn`,
          crmId: leadId,
          crmType: 'odoo',
          details: {
            companyCreated: !isExistingCompany,
            contactCreated: !contactAlreadyExists,
            leadCreated: true,
            clientType: clientType,
            source: 'LinkedIn',
            companyId: companyId,
            contactId: contactId
          }
        });

      } catch (error) {
        console.error('Odoo export error:', error);
        
        await exportLogs.insertOne({
          leadName: req.body.leadData?.name,
          linkedinUrl: req.body.linkedinUrl,
          crmType: 'odoo',
          exportedBy: req.body.userEmail,
          exportedAt: new Date(),
          status: 'failed',
          errorMessage: error.message,
          errorStack: error.stack
        }).catch(() => {});

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
            error: 'URL and userEmail required',
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
        console.error('Export check error:', error);
        res.status(200).json({
          alreadyExported: false,
          error: error.message
        });
      }
    });

    console.log('✅ Odoo CRM export endpoints registered');

    app.listen(3000, () => {
      console.log('🚀 Server running on http://localhost:3000');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
