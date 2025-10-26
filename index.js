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

    // ------------------ EXISTING ENDPOINTS (UNCHANGED) ------------------
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

    // Helper function to rollback created records
    async function rollbackCreatedRecords(callOdoo, createdRecords) {
      const rollbackResults = [];
      
      try {
        // Delete in reverse order: opportunity/candidate -> contact -> company/skill
        if (createdRecords.opportunity || createdRecords.candidate) {
          const entityType = createdRecords.opportunity ? 'opportunity' : 'candidate';
          const entityId = createdRecords.opportunity || createdRecords.candidate;
          const modelName = createdRecords.opportunity ? 'crm.lead' : 'hr.candidate';
          
          console.log(`Rolling back ${entityType}:`, entityId);
          try {
            await callOdoo(modelName, 'unlink', [[entityId]]);
            rollbackResults.push({ type: entityType, id: entityId, status: 'deleted' });
            console.log(`✅ ${entityType} rolled back`);
          } catch (err) {
            console.error(`❌ Failed to rollback ${entityType}:`, err.message);
            rollbackResults.push({ type: entityType, id: entityId, status: 'failed', error: err.message });
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

        if (createdRecords.skill) {
          console.log('Rolling back skill:', createdRecords.skill);
          try {
            await callOdoo('hr.candidate.skill', 'unlink', [[createdRecords.skill]]);
            rollbackResults.push({ type: 'skill', id: createdRecords.skill, status: 'deleted' });
            console.log('✅ Skill rolled back');
          } catch (err) {
            console.error('❌ Failed to rollback skill:', err.message);
            rollbackResults.push({ type: 'skill', id: createdRecords.skill, status: 'failed', error: err.message });
          }
        }
      } catch (err) {
        console.error('❌ Rollback process error:', err.message);
      }

      return rollbackResults;
    }

    // ✅ UNIFIED ODOO EXPORT ENDPOINT (handles both Client and Candidate)
    app.post('/api/crm/export-odoo', async (req, res) => {
      try {
        const { leadData, crmConfig, userEmail, linkedinUrl, profileType, extractedSkill } = req.body;

        if (!leadData || !leadData.name) {
          return res.status(400).json({ error: 'Lead data with name is required' });
        }

        if (!profileType || !['client', 'candidate'].includes(profileType.toLowerCase())) {
          return res.status(400).json({ error: 'Valid profileType (client or candidate) is required' });
        }

        const cleanName = (leadData.name || '').trim();
        if (cleanName.length < 2) {
          return res.status(400).json({ 
            error: 'Invalid name. Name must be at least 2 characters.',
            receivedName: leadData.name 
          });
        }

        // Extract company name
        let cleanCompany = (leadData.companyName || leadData.company || '').trim();
        if (!cleanCompany && leadData.comment) {
          const commentMatch = leadData.comment.match(/Company:\s*(.+)/);
          if (commentMatch && commentMatch[1]) {
            cleanCompany = commentMatch[1].split('\n')[0].trim();
          }
        }

        // Extract sourcedBy
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

        const isCandidate = profileType.toLowerCase() === 'candidate';
        const entityType = isCandidate ? 'candidate' : 'client';
        
        console.log(`Odoo export (${entityType}):`, { lead: cleanName, company: cleanCompany, sourcedBy, linkedinUrl });

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

        // Track created records for rollback
        const createdRecords = {
          company: null,
          contact: null,
          opportunity: null,
          candidate: null,
          skill: null
        };

        try {
          // ========== CANDIDATE FLOW ==========
          if (isCandidate) {
            const email = (leadData.email || '').trim();
            const cleanEmail = (email && isValidEmail(email) && email !== 'No email found') ? email : null;

            // ✅ 3.1 IMPROVED Duplicate Check - Check if candidate already exists
            // Using similar logic to opportunity duplicate check:
            // - Check by name + email
            // - Check by LinkedIn URL
            // - Merge results and deduplicate
            
            console.log('🔍 Checking for duplicate candidates...');
            
            // Check 1: By name + email (existing logic)
            const candidatesByName = await callOdoo('hr.candidate', 'search_read', [
              [
                ['partner_name', '=', cleanName],
                ...(cleanEmail ? [['email_from', '=', cleanEmail]] : [])
              ],
              ['id', 'partner_name', 'email_from', 'linkedin_profile']
            ]);
            
            console.log(`Found ${candidatesByName?.length || 0} candidates by name/email`);

            // Check 2: By LinkedIn URL (NEW - similar to opportunity check)
            let candidatesByLinkedIn = [];
            if (linkedinUrl) {
              candidatesByLinkedIn = await callOdoo('hr.candidate', 'search_read', [
                [['linkedin_profile', '=', linkedinUrl]],
                ['id', 'partner_name', 'email_from', 'linkedin_profile']
              ]);
              
              console.log(`Found ${candidatesByLinkedIn?.length || 0} candidates by LinkedIn URL`);
            }

            // Merge results and deduplicate (same logic as opportunity)
            const allExistingCandidates = [
              ...(candidatesByName || []), 
              ...(candidatesByLinkedIn || [])
            ];
            
            const uniqueCandidates = allExistingCandidates.filter((candidate, index, self) =>
              index === self.findIndex(c => c.id === candidate.id)
            );

            if (uniqueCandidates && uniqueCandidates.length > 0) {
              const existing = uniqueCandidates[0];
              
              // Determine how the duplicate was found
              const matchedByLinkedIn = candidatesByLinkedIn.some(c => c.id === existing.id);
              const matchedBy = matchedByLinkedIn ? 'LinkedIn URL' : 'Name/Email';
              
              console.log(`✋ Duplicate candidate found by ${matchedBy}:`, {
                id: existing.id,
                name: existing.partner_name,
                email: existing.email_from,
                linkedin: existing.linkedin_profile
              });

              await exportLogs.insertOne({
                leadName: cleanName,
                leadEmail: cleanEmail,
                linkedinUrl: linkedinUrl,
                crmType: 'odoo',
                crmId: existing.id,
                exportedBy: userEmail,
                exportedAt: new Date(),
                status: 'duplicate',
                profileType: 'candidate',
                message: `Candidate already exists in Odoo (matched by ${matchedBy})`
              });

              return res.json({
                success: false,
                alreadyExists: true,
                message: `Candidate already exists in Odoo (matched by ${matchedBy})`,
                crmId: existing.id,
                crmType: 'odoo',
                candidateName: existing.partner_name,
                matchedBy: matchedBy
              });
            }
            
            console.log('✅ No duplicate candidate found, proceeding to create...');

            // ✅ 3.2 Create contact (partner)
            console.log('Creating contact for candidate...');
            
            const contactData = {
              name: cleanName,
              type: 'contact',
              is_company: false,
              customer_rank: 0
            };

            if (cleanEmail) contactData.email = cleanEmail;

            const phone = (leadData.phone || '').trim();
            if (phone) contactData.phone = phone;

            const contactResult = await callOdoo('res.partner', 'create', [[contactData]]);
            const contactId = Array.isArray(contactResult) ? contactResult[0] : contactResult;
            createdRecords.contact = contactId;
            console.log('Contact created. ID:', contactId);

            // ✅ 3.3 Get extracted skill from request (already extracted by extension)
            // IMPORTANT: Skill extraction is now done in the browser extension (background.js)
            // before the export to CRM button is clicked. This happens ONLY for candidates.
            // The extension calls OpenAI API to extract the main IT skill from the headline,
            // and sends it in the request payload as 'extractedSkill'.
            let mainSkill = extractedSkill || null;
            
            console.log('🔍 Skill extraction debug:');
            console.log('  - extractedSkill from request:', extractedSkill);
            console.log('  - mainSkill value:', mainSkill);
            console.log('  - headline from leadData:', leadData.function || leadData.headline);
            
            if (mainSkill) {
              console.log(`✅ Using skill extracted by extension: ${mainSkill}`);
            } else {
              console.log('⚠️ No skill provided by extension - skill creation will be skipped');
            }

            // ✅ 3.4 Create candidate record
            console.log('Creating candidate...');
            
            const candidateData = {
              partner_name: cleanName,
              partner_id: parseInt(contactId, 10),
              email_from: cleanEmail || 'noemail@domain.com',
              company_id: 1, // Hardcoded to "HUEMOT TECHNOLOGY PRIVATE LIMITED" (ID: 1 in most Odoo instances)
              linkedin_profile: linkedinUrl // LinkedIn profile URL
              // Note: 'name' and 'description' fields removed - auto-generated/managed by Odoo
            };

            // Find salesperson
            if (sourcedBy) {
              const salespersons = await callOdoo('res.users', 'search_read', [
                [['name', 'ilike', sourcedBy]],
                ['id', 'name']
              ]);
              
              if (salespersons && salespersons.length > 0) {
                candidateData.user_id = salespersons[0].id;
              } else {
                candidateData.user_id = userId;
              }
            } else {
              candidateData.user_id = userId;
            }

            const candidateResult = await callOdoo('hr.candidate', 'create', [[candidateData]]);
            const candidateId = Array.isArray(candidateResult) ? candidateResult[0] : candidateResult;
            createdRecords.candidate = candidateId;
            console.log('Candidate created. ID:', candidateId);

            // ✅ 3.5 Create skill record if main skill extracted
            if (mainSkill) {
              console.log('Creating skill:', mainSkill);
              
              try {
                // Find or create skill_type_id for "IT"
                let itSkillTypeId = null;
                const skillTypes = await callOdoo('hr.skill.type', 'search_read', [
                  [['name', '=', 'IT']],
                  ['id', 'name']
                ]);
                
                if (skillTypes && skillTypes.length > 0) {
                  itSkillTypeId = skillTypes[0].id;
                  console.log(`Found existing IT skill type: ${itSkillTypeId}`);
                } else {
                  // Create IT skill type if doesn't exist
                  const skillTypeResult = await callOdoo('hr.skill.type', 'create', [[{ name: 'IT' }]]);
                  itSkillTypeId = Array.isArray(skillTypeResult) ? skillTypeResult[0] : skillTypeResult;
                  console.log(`Created IT skill type: ${itSkillTypeId}`);
                }

                // Find or create the skill itself
                let skillId = null;
                const skills = await callOdoo('hr.skill', 'search_read', [
                  [['name', '=', mainSkill], ['skill_type_id', '=', itSkillTypeId]],
                  ['id', 'name']
                ]);
                
                if (skills && skills.length > 0) {
                  skillId = skills[0].id;
                  console.log(`Found existing skill: ${mainSkill} (ID: ${skillId})`);
                } else {
                  const skillResult = await callOdoo('hr.skill', 'create', [[
                    { name: mainSkill, skill_type_id: itSkillTypeId }
                  ]]);
                  skillId = Array.isArray(skillResult) ? skillResult[0] : skillResult;
                  console.log(`Created skill: ${mainSkill} (ID: ${skillId})`);
                }

                // Find skill level "Expert (100%)" - the actual level name in Odoo
                let skillLevelId = null;
                const skillLevels = await callOdoo('hr.skill.level', 'search_read', [
                  [['name', 'ilike', '100%']],  // Using 'ilike' to match any level containing "100%"
                  ['id', 'name']
                ]);
                
                if (skillLevels && skillLevels.length > 0) {
                  skillLevelId = skillLevels[0].id;
                  console.log(`Found existing skill level: ${skillLevels[0].name} (ID: ${skillLevelId})`);
                } else {
                  console.log('⚠️ No skill level found with "100%" - trying to create "Expert (100%)"');
                  const levelResult = await callOdoo('hr.skill.level', 'create', [[
                    { name: 'Expert (100%)', level_progress: 100 }
                  ]]);
                  skillLevelId = Array.isArray(levelResult) ? levelResult[0] : levelResult;
                  console.log(`Created skill level: Expert (100%) (ID: ${skillLevelId})`);
                }

                // ✅ CHECK DUPLICATE: Check if this candidate-skill combination already exists
                const existingCandidateSkills = await callOdoo('hr.candidate.skill', 'search_read', [
                  [
                    ['candidate_id', '=', candidateId],
                    ['skill_id', '=', skillId]
                  ],
                  ['id', 'skill_id', 'skill_level_id']
                ]);

                if (existingCandidateSkills && existingCandidateSkills.length > 0) {
                  console.log(`⚠️ Skill already linked to candidate, skipping creation`);
                } else {
                  // ✅ Create candidate skill record using hr.candidate.skill model
                  const candidateSkillData = {
                    candidate_id: candidateId,
                    skill_id: skillId,
                    skill_level_id: skillLevelId,
                    skill_type_id: itSkillTypeId
                  };

                  console.log('Creating candidate skill with data:', candidateSkillData);
                  
                  const candidateSkillResult = await callOdoo('hr.candidate.skill', 'create', [[candidateSkillData]]);
                  const candidateSkillId = Array.isArray(candidateSkillResult) ? candidateSkillResult[0] : candidateSkillResult;
                  createdRecords.skill = candidateSkillId;
                  console.log('✅ Candidate skill created. ID:', candidateSkillId);
                }
              } catch (skillError) {
                console.error('❌ Failed to create skill:', skillError.message);
                console.error('Stack:', skillError.stack);
                // Don't fail the entire export if skill creation fails
                // But log it for monitoring
                console.warn('⚠️ Continuing without skill, but candidate was created');
              }
            } else {
              console.log('⚠️ No skill extracted from headline, skipping skill creation');
            }

            // Log successful export
            await exportLogs.insertOne({
              leadName: cleanName,
              leadEmail: cleanEmail,
              linkedinUrl: linkedinUrl,
              crmType: 'odoo',
              crmId: candidateId,
              contactId: contactId,
              exportedBy: userEmail,
              exportedAt: new Date(),
              status: 'success',
              profileType: 'candidate',
              mainSkill: mainSkill || 'Not extracted'
            });

            return res.json({
              success: true,
              message: `Successfully exported candidate to Odoo CRM`,
              crmId: candidateId,
              crmType: 'odoo',
              profileType: 'candidate',
              details: {
                contactCreated: true,
                candidateCreated: true,
                skillExtracted: mainSkill || 'None',
                contactId: contactId
              }
            });

          } else {
            // ========== CLIENT FLOW (EXISTING LOGIC - NO CHANGE) ==========
            
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
              createdRecords.company = companyId;
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
              createdRecords.contact = contactId;
              console.log('Contact created. ID:', contactId);
            }

            // Check for duplicate opportunities
            const existingLeadsByContact = await callOdoo('crm.lead', 'search_read', [
              [
                ['partner_id', '=', contactId],
                ['active', '=', true]
              ],
              ['id', 'name', 'stage_id', 'probability']
            ]);

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

            const allExistingLeads = [...existingLeadsByContact, ...existingLeadsByLinkedIn];
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

              await rollbackCreatedRecords(callOdoo, createdRecords);

              await exportLogs.insertOne({
                leadName: cleanName,
                leadEmail: leadData.email,
                linkedinUrl: linkedinUrl,
                crmType: 'odoo',
                crmId: existingLead.id,
                exportedBy: userEmail,
                exportedAt: new Date(),
                status: 'duplicate',
                profileType: 'client',
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

            // Create opportunity
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
            createdRecords.opportunity = leadId;
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
              profileType: 'client',
              clientType: clientType,
              salespersonId: salespersonId,
              sourceId: linkedinSourceId
            });

            return res.json({
              success: true,
              message: `Successfully exported lead to Odoo CRM as ${clientType} from LinkedIn`,
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

        } catch (creationError) {
          console.error('Error during Odoo record creation:', creationError);
          
          await rollbackCreatedRecords(callOdoo, createdRecords);
          
          throw creationError;
        }

      } catch (error) {
        console.error('Odoo export error:', error);
        
        await exportLogs.insertOne({
          leadName: req.body.leadData?.name,
          linkedinUrl: req.body.linkedinUrl,
          crmType: 'odoo',
          profileType: req.body.profileType,
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

    // Check if already exported endpoint (unchanged)
    app.get('/api/crm/check-export', async (req, res) => {
      try {
        const { url, userEmail, crmConfig } = req.query;

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

        if (!existingExport) {
          return res.json({ alreadyExported: false });
        }

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
          const config = JSON.parse(crmConfig);
          
          if (!config.endpointUrl || !config.username || !config.password || !config.databaseName) {
            throw new Error('Incomplete CRM config');
          }

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

          // Check both crm.lead and hr.candidate
          const modelName = existingExport.profileType === 'candidate' ? 'hr.candidate' : 'crm.lead';
          
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
                  modelName,
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
            return res.json({
              alreadyExported: true,
              exportedAt: existingExport.exportedAt,
              crmId: existingExport.crmId,
              crmType: existingExport.crmType,
              verified: false
            });
          }

          const checkResult = await checkResponse.json();
          const records = checkResult.result || [];

          if (records.length === 0) {
            console.log(`Record ${existingExport.crmId} not found in Odoo (was deleted manually)`);
            
            return res.json({ 
              alreadyExported: false,
              wasDeleted: true,
              mongoDbHasLog: true
            });
          }

          return res.json({
            alreadyExported: true,
            exportedAt: existingExport.exportedAt,
            crmId: existingExport.crmId,
            crmType: existingExport.crmType,
            verified: true
          });

        } catch (odooError) {
          console.warn('Error verifying in Odoo:', odooError.message);
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

    console.log('✅ Odoo CRM export endpoints registered');

    app.listen(3000, () => {
      console.log('🚀 Server running on http://localhost:3000');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
  }
}

startServer();
