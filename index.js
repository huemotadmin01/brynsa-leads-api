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

    // ========== ENHANCED ODOO CRM EXPORT WITH CLIENT & CANDIDATE SUPPORT ==========

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

        // Get profile type (client or candidate)
        const profileType = (leadData.profileType || 'client').toLowerCase();
        
        // For candidates, company name is optional; for clients, it's required
        if (profileType === 'client' && (!cleanCompany || cleanCompany.length < 2)) {
          return res.status(400).json({ 
            error: 'Invalid company name. Company name must be at least 2 characters for client profiles.',
            receivedCompany: leadData.companyName,
            extractedFromComment: cleanCompany,
            profileType: profileType
          });
        }

        if (!crmConfig || !crmConfig.endpointUrl || !crmConfig.username || !crmConfig.password) {
          return res.status(400).json({ error: 'CRM configuration is incomplete' });
        }

        // Handle missing email - use placeholder
        const emailToUse = leadData.email && 
                          isValidEmail(leadData.email) && 
                          leadData.email.toLowerCase() !== 'no email found'
          ? leadData.email 
          : 'noemail@domain.com';

        console.log('Odoo export:', { 
          lead: cleanName, 
          company: cleanCompany, 
          sourcedBy, 
          linkedinUrl, 
          profileType,
          email: emailToUse 
        });

        // Check if already exported
        const existingExport = await exportLogs.findOne({
          linkedinUrl: linkedinUrl,
          exportedBy: userEmail,
          crmType: 'odoo',
          profileType: profileType,
          status: 'success'
        });

        if (existingExport) {
          return res.status(200).json({
            success: true,
            message: `${profileType === 'candidate' ? 'Candidate' : 'Lead'} already exported to Odoo CRM`,
            crmId: existingExport.crmId,
            crmType: 'odoo',
            profileType: profileType,
            alreadyExisted: true,
            exportedAt: existingExport.exportedAt
          });
        }

        // Authenticate with Odoo
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

        // Helper function to call Odoo API
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

        // ========== ROUTE BASED ON PROFILE TYPE ==========
        
        if (profileType === 'candidate') {
          // ✅ CANDIDATE CREATION WORKFLOW
          console.log('📋 Creating candidate record...');
          
          // Extract main skill intelligently
          let mainSkill = null;
          const currentTitle = (leadData.function || leadData.currentTitle || '').trim();
          const headline = (leadData.headline || '').trim();
          
          // Priority: currentTitle -> extract from headline -> fallback to currentTitle
          if (currentTitle && currentTitle.toLowerCase() !== 'software engineer') {
            mainSkill = currentTitle;
            console.log(`✓ Using current title as skill: ${mainSkill}`);
          } else if (headline) {
            // Try to extract specific technology/role from headline
            const techKeywords = [
              '.NET', 'Java', 'Python', 'React', 'Angular', 'Vue', 'Node.js',
              'Frontend', 'Backend', 'Full Stack', 'DevOps', 'Data Engineer',
              'Machine Learning', 'AI', 'Cloud', 'AWS', 'Azure', 'GCP',
              'Mobile', 'iOS', 'Android', 'Flutter', 'React Native',
              'QA', 'Test', 'Automation', 'UI/UX', 'Product Manager'
            ];
            
            for (const keyword of techKeywords) {
              if (headline.toLowerCase().includes(keyword.toLowerCase())) {
                mainSkill = keyword + ' Developer';
                console.log(`✓ Extracted skill from headline: ${mainSkill}`);
                break;
              }
            }
            
            // If no keyword found, use current title as fallback
            if (!mainSkill && currentTitle) {
              mainSkill = currentTitle;
              console.log(`✓ Fallback to current title: ${mainSkill}`);
            }
          } else if (currentTitle) {
            mainSkill = currentTitle;
            console.log(`✓ Using current title as fallback: ${mainSkill}`);
          }
          
          if (!mainSkill) {
            mainSkill = 'Software Engineer'; // Ultimate fallback
            console.log(`⚠ No skill found, using default: ${mainSkill}`);
          }
          
          // Find salesperson ID from sourcedBy
          let salespersonId = userId;
          if (sourcedBy) {
            const salespersons = await callOdoo('res.users', 'search_read', [
              [['name', 'ilike', sourcedBy]],
              ['id', 'name']
            ]);
            
            if (salespersons && salespersons.length > 0) {
              salespersonId = salespersons[0].id;
              console.log(`✓ Found salesperson: ${salespersons[0].name} (ID: ${salespersonId})`);
            } else {
              console.log(`⚠ Salesperson "${sourcedBy}" not found, using current user (ID: ${salespersonId})`);
            }
          }

          // Get IT skill type (already exists with 185 records)
          console.log('🔍 Finding IT skill type...');
          const itSkillTypes = await callOdoo('hr.skill.type', 'search_read', [
            [['name', '=', 'IT']],
            ['id', 'name']
          ]);
          
          let itSkillTypeId;
          if (itSkillTypes && itSkillTypes.length > 0) {
            itSkillTypeId = itSkillTypes[0].id;
            console.log(`✓ Found IT skill type (ID: ${itSkillTypeId})`);
          } else {
            // Create IT skill type if not found
            const skillTypeResult = await callOdoo('hr.skill.type', 'create', [[{ name: 'IT' }]]);
            itSkillTypeId = Array.isArray(skillTypeResult) ? skillTypeResult[0] : skillTypeResult;
            console.log(`✓ Created IT skill type (ID: ${itSkillTypeId})`);
          }

          // Check for duplicate skill by name (case-insensitive)
          console.log(`🔍 Checking for existing skill: ${mainSkill}`);
          const existingSkills = await callOdoo('hr.skill', 'search_read', [
            [['name', 'ilike', mainSkill]],
            ['id', 'name', 'skill_type_id']
          ]);

          let mainSkillId;
          if (existingSkills && existingSkills.length > 0) {
            mainSkillId = existingSkills[0].id;
            console.log(`✓ Skill already exists: ${existingSkills[0].name} (ID: ${mainSkillId})`);
          } else {
            // Create skill with correct API - use skill_type_id field
            console.log(`✓ Creating new skill: ${mainSkill} with IT type (ID: ${itSkillTypeId})`);
            const skillResult = await callOdoo('hr.skill', 'create', [[{
              name: mainSkill,
              skill_type_id: itSkillTypeId
            }]]);
            mainSkillId = Array.isArray(skillResult) ? skillResult[0] : skillResult;
            console.log(`✓ Skill created (ID: ${mainSkillId})`);
          }

          // Check if candidate already exists (by name and main skill)
          console.log(`🔍 Checking for existing candidate: ${cleanName} with skill ${mainSkill}`);
          
          // First check by name only
          const existingCandidatesByName = await callOdoo('hr.candidate', 'search_read', [
            [['partner_name', '=', cleanName]],
            ['id', 'partner_name', 'skill_ids']
          ]);

          let candidateExists = false;
          let existingCandidateId = null;

          if (existingCandidatesByName && existingCandidatesByName.length > 0) {
            // Check if any candidate has the same skill
            for (const candidate of existingCandidatesByName) {
              if (candidate.skill_ids && candidate.skill_ids.length > 0) {
                // Get full skill details
                const candidateSkills = await callOdoo('hr.candidate.skill', 'search_read', [
                  [['candidate_id', '=', candidate.id]],
                  ['skill_id']
                ]);
                
                for (const skillRel of candidateSkills) {
                  if (skillRel.skill_id && skillRel.skill_id[0] === mainSkillId) {
                    candidateExists = true;
                    existingCandidateId = candidate.id;
                    console.log(`✓ Candidate already exists with same skill (ID: ${existingCandidateId})`);
                    break;
                  }
                }
              }
              
              if (candidateExists) break;
            }
          }

          // If duplicate found, return "Already in CRM" message
          if (candidateExists) {
            await exportLogs.insertOne({
              leadName: cleanName,
              leadEmail: emailToUse,
              linkedinUrl: linkedinUrl,
              crmType: 'odoo',
              profileType: 'candidate',
              crmId: existingCandidateId,
              exportedBy: userEmail,
              exportedAt: new Date(),
              status: 'success',
              message: 'Candidate already exists',
              mainSkill: mainSkill
            });

            return res.json({
              success: true,
              message: 'Candidate already exists in Odoo CRM',
              crmId: existingCandidateId,
              crmType: 'odoo',
              profileType: 'candidate',
              alreadyExisted: true,
              details: {
                candidateCreated: false,
                mainSkill: mainSkill
              }
            });
          }

          // Create Contact (partner_id) first
          console.log('👤 Creating contact for candidate...');
          
          const contactData = {
            name: cleanName,
            type: 'contact',
            is_company: false,
            email: emailToUse,
            customer_rank: 0
          };

          const phone = (leadData.phone || '').trim();
          if (phone) contactData.phone = phone;

          // Check if contact exists
          const existingContacts = await callOdoo('res.partner', 'search_read', [
            [['name', '=', cleanName], ['email', '=', emailToUse]],
            ['id', 'name', 'email']
          ]);

          let contactId;
          if (existingContacts && existingContacts.length > 0) {
            contactId = existingContacts[0].id;
            console.log(`✓ Contact already exists (ID: ${contactId})`);
          } else {
            const contactResult = await callOdoo('res.partner', 'create', [[contactData]]);
            contactId = Array.isArray(contactResult) ? contactResult[0] : contactResult;
            console.log(`✓ Contact created (ID: ${contactId})`);
          }

          // ✅ FIX: Create candidate without description field (doesn't exist in hr.candidate)
          console.log('✨ Creating candidate...');
          const candidateData = {
            partner_name: cleanName,
            email_from: emailToUse,
            partner_id: contactId,
            user_id: salespersonId, // ✅ This is the recruiter/sourced by user
          };

          // Create candidate first
          const candidateResult = await callOdoo('hr.candidate', 'create', [[candidateData]]);
          const candidateId = Array.isArray(candidateResult) ? candidateResult[0] : candidateResult;
          console.log(`✓ Candidate created (ID: ${candidateId})`);

          // ✅ FIX: Get skill level with 100% progress (Expert level) for the IT skill type
          console.log('🔍 Finding Expert skill level (100% progress) for IT skill type...');
          const skillLevels = await callOdoo('hr.skill.level', 'search_read', [
            [['level_progress', '=', 100], ['skill_type_id', '=', itSkillTypeId]],
            ['id', 'name', 'level_progress', 'skill_type_id']
          ]);
          
          let skillLevelId;
          if (skillLevels && skillLevels.length > 0) {
            // Use the first skill level with 100% progress
            skillLevelId = skillLevels[0].id;
            console.log(`✓ Using skill level: ${skillLevels[0].name} (ID: ${skillLevelId}, Progress: 100%)`);
          } else {
            // Create Expert skill level with 100% progress if none exists
            console.log('⚠ No Expert level found, creating Expert skill level with 100% progress for IT...');
            const defaultLevelResult = await callOdoo('hr.skill.level', 'create', [[{
              name: 'Expert',
              level_progress: 100,
              skill_type_id: itSkillTypeId // ✅ Required field: must link to skill type
            }]]);
            skillLevelId = Array.isArray(defaultLevelResult) ? defaultLevelResult[0] : defaultLevelResult;
            console.log(`✓ Created Expert skill level (ID: ${skillLevelId}, Progress: 100%)`);
          }

          // ✅ FIX: Add skill to candidate with proper skill_level_id
          console.log(`✓ Adding skill ${mainSkill} (ID: ${mainSkillId}) to candidate...`);
          const candidateSkillResult = await callOdoo('hr.candidate.skill', 'create', [[{
            candidate_id: candidateId,
            skill_id: mainSkillId,
            skill_level_id: skillLevelId, // ✅ Use actual skill level ID instead of false
            level_progress: 100 // 100% expert level
          }]]);
          
          console.log(`✅ Candidate skill added successfully`);
          
          // ✅ UPDATE: Add LinkedIn profile URL to candidate
          console.log(`✓ Updating candidate with LinkedIn profile URL...`);
          await callOdoo('hr.candidate', 'write', [
            [candidateId],
            { linkedin_profile: linkedinUrl }
          ]);
          console.log(`✅ Candidate created successfully with LinkedIn URL (ID: ${candidateId})`);

          // Log export
          await exportLogs.insertOne({
            leadName: cleanName,
            leadEmail: emailToUse,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            profileType: 'candidate',
            crmId: candidateId,
            contactId: contactId,
            exportedBy: userEmail,
            exportedAt: new Date(),
            status: 'success',
            salespersonId: salespersonId,
            mainSkill: mainSkill,
            skillId: mainSkillId
          });

          return res.json({
            success: true,
            message: 'Successfully exported to Odoo CRM as Candidate',
            crmId: candidateId,
            crmType: 'odoo',
            profileType: 'candidate',
            details: {
              contactCreated: true,
              candidateCreated: true,
              contactId: contactId,
              salespersonId: salespersonId,
              mainSkill: mainSkill,
              skillId: mainSkillId
            }
          });

        } else {
          // Client profile - use existing opportunity creation logic
          console.log('💼 Creating opportunity record...');

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
              email: emailToUse
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
            
            const contactResult = await callOdoo('res.partner', 'create', [[contactData]]);
            contactId = Array.isArray(contactResult) ? contactResult[0] : contactResult;
            console.log('Contact created. ID:', contactId);
          }

          // Check for existing lead/opportunity
          const existingLeads = await callOdoo('crm.lead', 'search_read', [
            [['partner_id', '=', contactId]],
            ['id', 'name']
          ]);

          let leadId;

          if (existingLeads && existingLeads.length > 0) {
            leadId = existingLeads[0].id;
            
            // Update email field even for existing opportunities
            await callOdoo('crm.lead', 'write', [
              [leadId],
              { email_from: emailToUse, website: linkedinUrl }
            ]);
            
            await exportLogs.insertOne({
              leadName: cleanName,
              leadEmail: emailToUse,
              linkedinUrl: linkedinUrl,
              crmType: 'odoo',
              profileType: 'client',
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
              profileType: 'client',
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
            email_from: emailToUse,
            website: linkedinUrl
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

          const leadResult = await callOdoo('crm.lead', 'create', [[leadCreateData]]);
          leadId = Array.isArray(leadResult) ? leadResult[0] : leadResult;
          console.log('Opportunity created. ID:', leadId);

          await exportLogs.insertOne({
            leadName: cleanName,
            leadEmail: emailToUse,
            linkedinUrl: linkedinUrl,
            crmType: 'odoo',
            profileType: 'client',
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
            profileType: 'client',
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
          profileType: req.body.leadData?.profileType || 'client',
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
            crmType: existingExport.crmType,
            profileType: existingExport.profileType || 'client'
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

    console.log('✅ Enhanced Odoo CRM export endpoints registered (Client & Candidate support)');

    app.listen(3000, () => {
      console.log('🚀 Server running on http://localhost:3000');
      console.log('📋 Supported profile types: client (opportunity) and candidate (hr.candidate)');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
