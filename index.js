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

    // ========== ODOO CRM EXPORT - UPDATED WITH ALL 3 REQUIREMENTS ==========

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

        // REQUIREMENT 2: Extract profile type
        let profileType = leadData.profileType || 'client'; // Default to client
        if (!profileType && leadData.comment) {
          const profileTypeMatch = leadData.comment.match(/Profile Type:\s*(.+)/i);
          if (profileTypeMatch && profileTypeMatch[1]) {
            profileType = profileTypeMatch[1].split('\n')[0].trim().toLowerCase();
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

        console.log('Odoo export:', { 
          lead: cleanName, 
          company: cleanCompany, 
          profileType: profileType,
          sourcedBy, 
          linkedinUrl 
        });

        // REQUIREMENT 2: Check if this is a candidate or client export
        const isCandidate = profileType === 'candidate';

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
            message: `${isCandidate ? 'Candidate' : 'Lead'} already exported to Odoo CRM`,
            crmId: existingExport.crmId,
            crmType: 'odoo',
            alreadyExisted: true,
            exportedAt: existingExport.exportedAt
          });
        }

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

        // REQUIREMENT 3: Handle email - use noemail@domain.com if not found
        const emailToUse = leadData.email && 
                           leadData.email !== 'No email found' && 
                           isValidEmail(leadData.email) 
                           ? leadData.email 
                           : 'noemail@domain.com';

        // REQUIREMENT 2: Branch logic based on profile type
        if (isCandidate) {
          // ============ CANDIDATE FLOW ============
          console.log('Creating candidate record...');

          // Get LinkedIn source (same for both flows)
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
          let salespersonId = userId; // Default to current user
          if (sourcedBy) {
            const salespersons = await callOdoo('res.users', 'search_read', [
              [['name', 'ilike', sourcedBy]],
              ['id', 'name']
            ]);
            
            if (salespersons && salespersons.length > 0) {
              salespersonId = salespersons[0].id;
            }
          }

          // REQUIREMENT 2: Check if candidate already exists
          const existingCandidates = await callOdoo('hr.applicant', 'search_read', [
            [['partner_name', '=', cleanName]],
            ['id', 'name', 'partner_name']
          ]);

          let candidateId;

          if (existingCandidates && existingCandidates.length > 0) {
            candidateId = existingCandidates[0].id;
            console.log('Candidate already exists. ID:', candidateId);

            await exportLogs.insertOne({
              leadName: cleanName,
              leadEmail: emailToUse,
              linkedinUrl: linkedinUrl,
              crmType: 'odoo',
              recordType: 'candidate',
              crmId: candidateId,
              exportedBy: userEmail,
              exportedAt: new Date(),
              status: 'success',
              message: 'Candidate already exists'
            });

            return res.json({
              success: true,
              message: 'Candidate already exists in Odoo CRM',
              crmId: candidateId,
              crmType: 'odoo',
              recordType: 'candidate',
              details: {
                candidateCreated: false
              }
            });
          }

          // REQUIREMENT 2: Create candidate data
          const candidateData = {
            partner_name: cleanName,
            name: `${cleanName} - ${cleanCompany}`, // Job title/position
            email_from: emailToUse,
            user_id: salespersonId,
            source_id: linkedinSourceId,
            company_id: cleanCompany,
            description: linkedinUrl ? `LinkedIn: ${linkedinUrl}` : ''
          };

          // REQUIREMENT 2: Handle skills if provided
          if (leadData.skills && Array.isArray(leadData.skills) && leadData.skills.length > 0) {
            const skillIds = [];
            
            for (const skillName of leadData.skills.slice(0, 10)) { // Limit to 10 skills
              try {
                // Check if skill exists
                const existingSkills = await callOdoo('hr.skill', 'search_read', [
                  [['name', '=', skillName]],
                  ['id', 'name']
                ]);

                let skillId;
                if (existingSkills && existingSkills.length > 0) {
                  skillId = existingSkills[0].id;
                } else {
                  // Create skill
                  skillId = await callOdoo('hr.skill', 'create', [
                    [{ name: skillName }]
                  ]);
                }

                if (skillId) {
                  skillIds.push([0, 0, {
                    skill_id: skillId,
                    skill_level_id: false,
                    skill_type_id: false
                  }]);
                }
              } catch (skillError) {
                console.warn(`Failed to process skill "${skillName}":`, skillError.message);
              }
            }

            if (skillIds.length > 0) {
              candidateData.applicant_skill_ids = skillIds;
            }
          }

          console.log('Creating candidate with data:', {
            name: candidateData.partner_name,
            email: candidateData.email_from,
            skillCount: candidateData.applicant_skill_ids?.length || 0
          });

          const candidateResult = await callOdoo('hr.applicant', 'create', [
            [candidateData]
          ]);

          candidateId = Array.isArray(candidateResult) ? candidateResult[0] : candidateResult;
          console.log('Candidate created. ID:', candidateId);

          await exportLogs.insertOne({
            leadName: cleanName,
            leadEmail: emailToUse,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            recordType: 'candidate',
            crmId: candidateId,
            exportedBy: userEmail,
            exportedAt: new Date(),
            status: 'success',
            salespersonId: salespersonId,
            sourceId: linkedinSourceId,
            skillsCount: candidateData.applicant_skill_ids?.length || 0
          });

          res.json({
            success: true,
            message: `Successfully exported to Odoo CRM as Candidate from LinkedIn`,
            crmId: candidateId,
            crmType: 'odoo',
            recordType: 'candidate',
            details: {
              candidateCreated: true,
              source: 'LinkedIn',
              skillsAdded: candidateData.applicant_skill_ids?.length || 0,
              websiteUrl: linkedinUrl
            }
          });

        } else {
          // ============ CLIENT/OPPORTUNITY FLOW (EXISTING LOGIC) ============
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
            console.log('Company exists. ID:', companyId);
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
              customer_rank: 1,
              email: emailToUse // REQUIREMENT 3: Use noemail@domain.com if no email
            };

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
            console.log('Contact created. ID:', contactId);
          }

          // Check for existing lead
          const existingLeads = await callOdoo('crm.lead', 'search_read', [
            [['partner_id', '=', contactId]],
            ['id', 'name']
          ]);

          let leadId;

          if (existingLeads && existingLeads.length > 0) {
            leadId = existingLeads[0].id;
            
            await exportLogs.insertOne({
              leadName: cleanName,
              leadEmail: emailToUse,
              linkedinUrl: linkedinUrl,
              crmType: 'odoo',
              recordType: 'opportunity',
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
              recordType: 'opportunity',
              details: {
                companyCreated: !isExistingCompany,
                contactCreated: !contactAlreadyExists,
                leadCreated: false,
                clientType: clientType
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
            x_studio_client_type: clientType,
            email_from: emailToUse, // REQUIREMENT 3: Use noemail@domain.com if no email
            website: linkedinUrl // LinkedIn URL in website field
          };

          const phone = (leadData.phone || '').trim();
          if (phone) leadCreateData.phone = phone;

          const func = (leadData.function || '').trim();
          if (func) leadCreateData.function = func;

          const street = (leadData.street || '').trim();
          if (street) leadCreateData.street = street;

          console.log('Creating opportunity with data:', { 
            clientType, 
            isExistingCompany, 
            website: linkedinUrl,
            email: emailToUse
          });

          const leadResult = await callOdoo('crm.lead', 'create', [
            [leadCreateData]
          ]);

          leadId = Array.isArray(leadResult) ? leadResult[0] : leadResult;
          console.log('Opportunity created. ID:', leadId);

          await exportLogs.insertOne({
            leadName: cleanName,
            leadEmail: emailToUse,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            recordType: 'opportunity',
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
            recordType: 'opportunity',
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
          error: error.message || 'Failed to export to Odoo CRM'
        });
      }
    });

    // Check if already exported
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
