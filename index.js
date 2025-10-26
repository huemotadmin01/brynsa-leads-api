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

    // ========== ODOO CRM EXPORT ==========

    // Helper function to rollback created records
    async function rollbackCreatedRecords(callOdoo, createdRecords) {
      const rollbackResults = [];
      
      try {
        // Delete in reverse order: opportunity -> contact -> company
        if (createdRecords.opportunity) {
          console.log('Rolling back opportunity:', createdRecords.opportunity);
          try {
            await callOdoo('crm.lead', 'unlink', [[createdRecords.opportunity]]);
            rollbackResults.push({ type: 'opportunity', id: createdRecords.opportunity, status: 'deleted' });
            console.log('✅ Opportunity rolled back');
          } catch (err) {
            console.error('❌ Failed to rollback opportunity:', err.message);
            rollbackResults.push({ type: 'opportunity', id: createdRecords.opportunity, status: 'failed', error: err.message });
          }
        }

        if (createdRecords.contact) {
          console.log('Rolling back contact:', createdRecords.contact);
          try {
            await callOdoo('res.partner', 'unlink', [[createdRecords.contact]]);
            rollbackResults.push({ type: 'contact', id: createdRecords.contact, status: 'deleted' });
            console.log('✅ Contact rolled back');
          } catch (err) {
            console.error('❌ Failed to rollback contact:', err.message);
            rollbackResults.push({ type: 'contact', id: createdRecords.contact, status: 'failed', error: err.message });
          }
        }

        if (createdRecords.company) {
          console.log('Rolling back company:', createdRecords.company);
          try {
            await callOdoo('res.partner', 'unlink', [[createdRecords.company]]);
            rollbackResults.push({ type: 'company', id: createdRecords.company, status: 'deleted' });
            console.log('✅ Company rolled back');
          } catch (err) {
            console.error('❌ Failed to rollback company:', err.message);
            rollbackResults.push({ type: 'company', id: createdRecords.company, status: 'failed', error: err.message });
          }
        }
      } catch (err) {
        console.error('❌ Rollback process error:', err.message);
      }

      return rollbackResults;
    }

    app.post('/api/crm/export-odoo', async (req, res) => {
      try {
        const { leadData, crmConfig, userEmail, linkedinUrl } = req.body;

        if (!leadData || !leadData.name) {
          return res.status(400).json({ error: 'Lead data with name is required' });
        }

        const cleanName = (leadData.name || '').trim();
        if (cleanName.length < 2) {
          return res.status(400).json({ 
            error: 'Invalid name. Name must be at least 2 characters.',
            receivedName: leadData.name 
          });
        }

        // Extract company name from comment if not provided
        let cleanCompany = (leadData.companyName || leadData.company || '').trim();
        if (!cleanCompany && leadData.comment) {
          const commentMatch = leadData.comment.match(/Company:\s*(.+)/);
          if (commentMatch && commentMatch[1]) {
            cleanCompany = commentMatch[1].split('\n')[0].trim();
          }
        }

        // Extract sourcedBy from comment if not provided
        let sourcedBy = leadData.sourcedBy;
        if (!sourcedBy && leadData.comment) {
          const sourcedByMatch = leadData.comment.match(/Sourced by:\s*(.+)/);
          if (sourcedByMatch && sourcedByMatch[1]) {
            sourcedBy = sourcedByMatch[1].split('\n')[0].trim();
          }
        }

        if (!cleanCompany || cleanCompany.length < 2) {
          return res.status(400).json({ 
            error: 'Invalid company name. Company name must be at least 2 characters.',
            receivedCompany: leadData.companyName,
            extractedFromComment: cleanCompany
          });
        }

        if (!crmConfig || !crmConfig.endpointUrl || !crmConfig.username || !crmConfig.password) {
          return res.status(400).json({ error: 'CRM configuration is incomplete' });
        }

        console.log('Odoo export:', { lead: cleanName, company: cleanCompany, sourcedBy, linkedinUrl });

        // Authenticate
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

        const odooUrl = `${crmConfig.endpointUrl}/jsonrpc`;

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

        // Get LinkedIn source
        let linkedinSourceId = null;
        const sources = await callOdoo('utm.source', 'search_read', [
          [['name', '=', 'LinkedIn']],
          ['id', 'name']
        ]);
        
        if (sources && sources.length > 0) {
          linkedinSourceId = sources[0].id;
        } else {
          linkedinSourceId = await callOdoo('utm.source', 'create', [
            [{ name: 'LinkedIn' }]
          ]);
        }

        // Find salesperson
        let salespersonId = null;
        if (sourcedBy) {
          const salespersons = await callOdoo('res.users', 'search_read', [
            [['name', 'ilike', sourcedBy]],
            ['id', 'name']
          ]);
          
          if (salespersons && salespersons.length > 0) {
            salespersonId = salespersons[0].id;
          } else {
            salespersonId = userId;
          }
        } else {
          salespersonId = userId;
        }

        // Track created records for rollback
        const createdRecords = {
          company: null,
          contact: null,
          opportunity: null
        };

        try {
          // Check company
          const existingCompanies = await callOdoo('res.partner', 'search_read', [
            [['name', '=', cleanCompany], ['is_company', '=', true]],
            ['id', 'name']
          ]);

          let companyId;
          let isExistingCompany = false;
          let clientType;

          if (existingCompanies && existingCompanies.length > 0) {
            companyId = existingCompanies[0].id;
            isExistingCompany = true;
            clientType = 'Existing Client';
            console.log('Company exists. ID:', companyId, 'Client Type:', clientType);
          } else {
            console.log('Creating company...');
            const companyResult = await callOdoo('res.partner', 'create', [
              [{
                name: cleanCompany,
                is_company: true,
                customer_rank: 1,
                user_id: salespersonId
              }]
            ]);
            
            companyId = Array.isArray(companyResult) ? companyResult[0] : companyResult;
            isExistingCompany = false;
            clientType = 'New Prospect';
            createdRecords.company = companyId; // Track for rollback
            console.log('Company created. ID:', companyId, 'Client Type:', clientType);
          }

        // Check contact
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
          
          const contactData = {
            name: cleanName,
            parent_id: parseInt(companyId, 10),
            type: 'contact',
            is_company: false,
            customer_rank: 1
          };

          const email = (leadData.email || '').trim();
          if (email && isValidEmail(email) && email !== 'No email found') {
            contactData.email = email;
          } else {
            contactData.email = 'noemail@domain.com';
          }

          const phone = (leadData.phone || '').trim();
          if (phone) contactData.phone = phone;

          const func = (leadData.function || '').trim();
          if (func) contactData.function = func;

          const street = (leadData.street || '').trim();
          if (street) contactData.street = street;

          const comment = (leadData.comment || '').trim();
          if (comment) contactData.comment = comment;

          console.log('Contact data:', contactData);
          
          const contactResult = await callOdoo('res.partner', 'create', [
            [contactData]
          ]);
          
          contactId = Array.isArray(contactResult) ? contactResult[0] : contactResult;
          createdRecords.contact = contactId; // Track for rollback
          console.log('Contact created. ID:', contactId);
        }

        // ✅ CHECK FOR DUPLICATE OPPORTUNITIES IN ODOO (not archived)
        // Check by contact (partner_id)
        const existingLeadsByContact = await callOdoo('crm.lead', 'search_read', [
          [
            ['partner_id', '=', contactId],
            ['active', '=', true] // Excludes archived records
          ],
          ['id', 'name', 'stage_id', 'probability']
        ]);

        // Also check by LinkedIn URL in website field (more specific check)
        let existingLeadsByLinkedIn = [];
        if (linkedinUrl) {
          existingLeadsByLinkedIn = await callOdoo('crm.lead', 'search_read', [
            [
              ['website', '=', linkedinUrl],
              ['active', '=', true]
            ],
            ['id', 'name', 'stage_id', 'probability', 'partner_id']
          ]);
        }

        // Combine both checks
        const allExistingLeads = [...existingLeadsByContact, ...existingLeadsByLinkedIn];
        
        // Remove duplicates by ID
        const uniqueLeads = allExistingLeads.filter((lead, index, self) =>
          index === self.findIndex(l => l.id === lead.id)
        );

        if (uniqueLeads && uniqueLeads.length > 0) {
          const existingLead = uniqueLeads[0];
          
          console.log('Duplicate opportunity found in Odoo:', {
            id: existingLead.id,
            name: existingLead.name,
            stage: existingLead.stage_id?.[1] || 'Unknown',
            probability: existingLead.probability
          });

          // Rollback any created records
          await rollbackCreatedRecords(callOdoo, createdRecords);

          // Log to MongoDB for tracking
          await exportLogs.insertOne({
            leadName: cleanName,
            leadEmail: leadData.email,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            crmId: existingLead.id,
            exportedBy: userEmail,
            exportedAt: new Date(),
            status: 'duplicate',
            message: 'Opportunity already exists in Odoo',
            companyId: companyId,
            contactId: contactId
          });

          return res.json({
            success: false,
            alreadyExists: true,
            message: `Opportunity already exists in Odoo CRM (ID: ${existingLead.id})`,
            crmId: existingLead.id,
            crmType: 'odoo',
            opportunityName: existingLead.name,
            stage: existingLead.stage_id?.[1] || 'Unknown',
            details: {
              companyCreated: false,
              contactCreated: false,
              leadCreated: false,
              rolledBack: createdRecords.company || createdRecords.contact ? true : false
            }
          });
        }

        // Create lead/opportunity
        const leadCreateData = {
          name: `${cleanName}'s opportunity`,
          partner_id: parseInt(contactId, 10),
          contact_name: cleanName,
          type: 'opportunity',
          user_id: salespersonId,
          source_id: linkedinSourceId,
          x_studio_client_type: clientType
        };

        const emailFrom = (leadData.email || '').trim();
        if (emailFrom && isValidEmail(emailFrom) && emailFrom !== 'No email found') {
          leadCreateData.email_from = emailFrom;
        } else {
          leadCreateData.email_from = 'noemail@domain.com';
        }

        const phone = (leadData.phone || '').trim();
        if (phone) leadCreateData.phone = phone;

        const func = (leadData.function || '').trim();
        if (func) leadCreateData.function = func;

        const street = (leadData.street || '').trim();
        if (street) leadCreateData.street = street;

        // ✅ UPDATED: Add LinkedIn URL to website field instead of description
        if (linkedinUrl) {
          leadCreateData.website = linkedinUrl;
        }

        console.log('Creating opportunity with data:', { 
          clientType, 
          isExistingCompany, 
          website: linkedinUrl 
        });

        const leadResult = await callOdoo('crm.lead', 'create', [
          [leadCreateData]
        ]);

        const leadId = Array.isArray(leadResult) ? leadResult[0] : leadResult;
        createdRecords.opportunity = leadId; // Track for rollback
        console.log('Opportunity created. ID:', leadId);

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
            contactId: contactId,
            websiteUrl: linkedinUrl
          }
        });

      } catch (creationError) {
        console.error('Error during Odoo record creation:', creationError);
        
        // Rollback any created records
        await rollbackCreatedRecords(callOdoo, createdRecords);
        
        throw creationError; // Re-throw to be caught by outer catch
      }

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
          error: error.message || 'Failed to export to Odoo CRM',
          message: 'Export failed. Any partially created records have been rolled back.'
        });
      }
    });

    // Check if already exported - UPDATED to verify in Odoo
    app.get('/api/crm/check-export', async (req, res) => {
      try {
        const { url, userEmail, crmConfig } = req.query;

        if (!url || !userEmail) {
          return res.status(400).json({ 
            error: 'URL and userEmail required',
            alreadyExported: false 
          });
        }

        // First check MongoDB logs
        const existingExport = await exportLogs.findOne({
          linkedinUrl: url,
          exportedBy: userEmail,
          status: 'success',
          crmType: 'odoo'
        });

        // If not in MongoDB, definitely not exported
        if (!existingExport) {
          return res.json({ alreadyExported: false });
        }

        // ✅ IMPORTANT: Verify the record still exists in Odoo
        // (In case it was manually deleted from Odoo)
        
        // If no CRM config provided, can't verify in Odoo
        if (!crmConfig) {
          console.warn('No CRM config provided, cannot verify in Odoo');
          return res.json({
            alreadyExported: true,
            exportedAt: existingExport.exportedAt,
            crmId: existingExport.crmId,
            crmType: existingExport.crmType,
            verified: false
          });
        }

        try {
          // Parse CRM config
          const config = JSON.parse(crmConfig);
          
          if (!config.endpointUrl || !config.username || !config.password || !config.databaseName) {
            throw new Error('Incomplete CRM config');
          }

          // Authenticate with Odoo
          const authUrl = `${config.endpointUrl}/web/session/authenticate`;
          const authResponse = await fetch(authUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: "2.0",
              params: {
                db: config.databaseName,
                login: config.username,
                password: config.password
              }
            })
          });

          if (!authResponse.ok) {
            throw new Error('Odoo authentication failed');
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

          const odooUrl = `${config.endpointUrl}/jsonrpc`;

          // Check if the opportunity still exists in Odoo by ID
          const checkResponse = await fetch(odooUrl, {
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
                args: [
                  config.databaseName,
                  userId,
                  config.password,
                  'crm.lead',
                  'search_read',
                  [[['id', '=', existingExport.crmId]]],
                  ['id', 'name', 'active']
                ]
              },
              id: Date.now()
            })
          });

          if (!checkResponse.ok) {
            console.warn('Failed to check Odoo, assuming exists');
            // If we can't check Odoo, return based on MongoDB
            return res.json({
              alreadyExported: true,
              exportedAt: existingExport.exportedAt,
              crmId: existingExport.crmId,
              crmType: existingExport.crmType,
              verified: false
            });
          }

          const checkResult = await checkResponse.json();
          const opportunities = checkResult.result || [];

          // If opportunity doesn't exist in Odoo (was deleted)
          if (opportunities.length === 0) {
            console.log(`Opportunity ${existingExport.crmId} not found in Odoo (was deleted manually)`);
            
            // ✅ Don't clean up MongoDB - just return that it doesn't exist in Odoo
            return res.json({ 
              alreadyExported: false,
              wasDeleted: true,
              mongoDbHasLog: true // MongoDB still has the log
            });
          }

          // Opportunity exists in Odoo
          return res.json({
            alreadyExported: true,
            exportedAt: existingExport.exportedAt,
            crmId: existingExport.crmId,
            crmType: existingExport.crmType,
            verified: true
          });

        } catch (odooError) {
          console.warn('Error verifying in Odoo:', odooError.message);
          // If verification fails, return based on MongoDB
          return res.json({
            alreadyExported: true,
            exportedAt: existingExport.exportedAt,
            crmId: existingExport.crmId,
            crmType: existingExport.crmType,
            verified: false
          });
        }

      } catch (error) {
        console.error('Export check error:', error);
        res.status(200).json({
          alreadyExported: false,
          error: error.message
        });
      }
    });

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
