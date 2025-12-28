/**
 * Brynsa LinkedIn Outreach Assistant - Backend API
 * 
 * SECURITY UPDATE: All credentials now server-side only
 * 
 * Environment Variables Required:
 * - MONGO_URL: MongoDB connection string
 * - OPENAI_API_KEY: OpenAI API key (NEVER expose to client)
 * - ODOO_ENDPOINT: Odoo CRM endpoint URL
 * - ODOO_USERNAME: Odoo username
 * - ODOO_PASSWORD: Odoo password
 * - ODOO_DATABASE: Odoo database name
 * - EXPORT_SECRET: Secret key for /api/leads/export endpoint
 * - REBUILD_SECRET: Secret key for /api/email/rebuild-cache endpoint
 * - PORT: Server port (default: 3000)
 */
const { setupAuthRoutes } = require('./src/auth');
const { setupEmailSystem, learnFromLead } = require('./emailSystem');
const { setupVerificationRoutes } = require('./verifyEmails');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { MongoClient } = require('mongodb');
const { setupListsRoutes } = require('./src/lists');
const { setupPortalLeadsRoutes } = require('./src/portal-leads');

const app = express();

// SECURITY: CORS whitelist - only allow requests from trusted origins
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'https://huemotadmin01.github.io',  // Portal
      'https://www.linkedin.com',          // Content scripts run on LinkedIn
      'https://linkedin.com',              // Content scripts (non-www)
      'http://localhost:5173',             // Local development
      'http://localhost:3000'              // Local development
    ];
    
    // Allow requests with no origin (like mobile apps, curl, or extensions)
    if (!origin) return callback(null, true);
    
    // Allow chrome-extension:// origins
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    console.warn('⚠️ CORS blocked request from:', origin);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true
};
app.use(cors(corsOptions));

// SECURITY: Limit request body size to prevent memory exhaustion
app.use(express.json({ limit: '10mb' }));

// SECURITY: Add security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // Allow extension to load resources
  contentSecurityPolicy: false  // Disable CSP for API (not serving HTML)
}));

// ============================================================================
// ENVIRONMENT VALIDATION
// ============================================================================
const requiredEnvVars = ['MONGO_URL', 'OPENAI_API_KEY', 'EXPORT_SECRET', 'JWT_SECRET'];
const optionalEnvVars = ['REBUILD_SECRET', 'ODOO_ENDPOINT', 'ODOO_USERNAME', 'ODOO_PASSWORD', 'ODOO_DATABASE', 'RESEND_API_KEY', 'GOOGLE_CLIENT_ID'];

console.log('🔒 Environment Check:');
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ CRITICAL: Missing required env var: ${envVar}`);
  } else {
    console.log(`✅ ${envVar}: configured`);
  }
}
for (const envVar of optionalEnvVars) {
  console.log(`${process.env[envVar] ? '✅' : '⚠️'} ${envVar}: ${process.env[envVar] ? 'configured' : 'not set'}`);
}

const mongoUrl = process.env.MONGO_URL;
console.log('🔗 Mongo URL:', mongoUrl ? '***configured***' : '❌ MISSING');

const client = new MongoClient(mongoUrl);

// ============================================================================
// SECURITY UTILITIES
// ============================================================================

function sanitizeString(str, maxLength = 500) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/['"\\]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim()
    .substring(0, maxLength);
}

function sanitizeForOdoo(str) {
  if (!str) return '';
  return String(str)
    .replace(/<[^>]*>/g, '')
    .replace(/['"\\]/g, '')
    .trim()
    .substring(0, 200);
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(e || '');
}

// ============================================================================
// RATE LIMITING
// ============================================================================

const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;

function checkRateLimit(userEmail, action = 'default') {
  const key = `${userEmail}:${action}`;
  const now = Date.now();
  
  if (!rateLimits.has(key)) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }
  
  const limit = rateLimits.get(key);
  
  if (now > limit.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }
  
  if (limit.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((limit.resetAt - now) / 1000) };
  }
  
  limit.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - limit.count };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimits.entries()) {
    if (now > value.resetAt) rateLimits.delete(key);
  }
}, 5 * 60 * 1000);

// ============================================================================
// SECURE ODOO CONFIGURATION
// ============================================================================

function getOdooConfig() {
  return {
    endpointUrl: process.env.ODOO_ENDPOINT,
    username: process.env.ODOO_USERNAME,
    password: process.env.ODOO_PASSWORD,
    databaseName: process.env.ODOO_DATABASE
  };
}

function validateOdooConfig() {
  const config = getOdooConfig();
  return !!(config.endpointUrl && config.username && config.password && config.databaseName);
}

// ============================================================================
// MAIN SERVER
// ============================================================================

async function startServer() {
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('brynsaleads');
    setupEmailSystem(app, db);
    setupVerificationRoutes(app, db);
    setupAuthRoutes(app, db);
    setupListsRoutes(app, db);
setupPortalLeadsRoutes(app, db);
    const leads = db.collection('leads');
    const exportLogs = db.collection('export_logs');

    await exportLogs.createIndex({ linkedinUrl: 1, exportedBy: 1 });
    await exportLogs.createIndex({ leadId: 1, crmType: 1 });

    // ========================================================================
    // NEW: OPENAI PROXY ENDPOINTS
    // ========================================================================

    app.post('/api/openai/generate', async (req, res) => {
      try {
        const { prompt, maxTokens, userEmail } = req.body;

        if (!prompt) {
          return res.status(400).json({ success: false, error: 'Prompt is required' });
        }

        if (!process.env.OPENAI_API_KEY) {
          return res.status(500).json({ success: false, error: 'AI service not configured' });
        }

        if (userEmail) {
          const rateCheck = checkRateLimit(userEmail, 'openai');
          if (!rateCheck.allowed) {
            return res.status(429).json({ 
              success: false, 
              error: 'Rate limit exceeded',
              retryAfter: rateCheck.retryAfter
            });
          }
        }

        console.log(`🤖 OpenAI request from ${userEmail || 'unknown'}`);

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens || 300,
            temperature: 0.7
          })
        });

        const data = await response.json();

        if (data.error) {
          return res.status(500).json({ success: false, error: data.error.message });
        }

        res.json({ success: true, content: data.choices?.[0]?.message?.content });

      } catch (error) {
        console.error('❌ OpenAI proxy error:', error);
        res.status(500).json({ success: false, error: 'AI service temporarily unavailable' });
      }
    });

    app.post('/api/openai/extract-skill', async (req, res) => {
      try {
        const { headline, userEmail } = req.body;

        if (!headline) {
          return res.status(400).json({ success: false, skill: null });
        }

        if (!process.env.OPENAI_API_KEY) {
          return res.status(500).json({ success: false, skill: null });
        }

        if (userEmail) {
          const rateCheck = checkRateLimit(userEmail, 'skill-extract');
          if (!rateCheck.allowed) {
            return res.status(429).json({ success: false, skill: null, retryAfter: rateCheck.retryAfter });
          }
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: 'Extract the single most important professional skill from the job title. For IT roles, return technical skill. For non-IT, return functional area. Return ONLY the skill name (1-3 words). If unclear, return "None".'
              },
              { role: 'user', content: `Extract skill from: "${headline}"` }
            ],
            temperature: 0.3,
            max_tokens: 30
          })
        });

        const data = await response.json();
        const skill = data.choices?.[0]?.message?.content?.trim();
        const cleanSkill = skill && skill.toLowerCase() !== 'none' && skill.length < 50 
          ? skill.replace(/['"]/g, '').trim() : null;

        console.log(`✅ Extracted skill: ${cleanSkill || 'None'}`);
        res.json({ success: true, skill: cleanSkill });

      } catch (error) {
        console.error('❌ Skill extraction error:', error);
        res.status(500).json({ success: false, skill: null });
      }
    });

    console.log('✅ OpenAI proxy endpoints registered');

    // ========================================================================
    // EXISTING ENDPOINTS
    // ========================================================================
    
    app.get('/api/leads/lookup', async (req, res) => {
      try {
        const { linkedinUrl, email } = req.query;
        
        if (!linkedinUrl && !email) {
          return res.status(400).json({ exists: false, error: 'linkedinUrl or email required' });
        }

        let found = null;

        if (linkedinUrl) {
          const normalizedUrl = linkedinUrl.replace(/\/$/, '').toLowerCase();
          const profileId = normalizedUrl.split('/in/')[1]?.split('/')[0]?.split('?')[0];
          
          found = await leads.findOne({
            $or: [
              { linkedinUrl: linkedinUrl },
              { linkedinUrl: linkedinUrl.replace(/\/$/, '') },
              { linkedinUrl: linkedinUrl + '/' },
              { linkedinUrl: { $regex: new RegExp(`/in/${profileId}/?$`, 'i') } }
            ]
          });
        }

        if (!found && email) {
          found = await leads.findOne({
            email: { $regex: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
          });
        }

        if (!found) return res.json({ exists: false });

        const validEmail = isValidEmail(found.email) && found.email.toLowerCase() !== 'noemail@domain.com'
          ? found.email : null;

        return res.json({ 
          exists: true, 
          email: validEmail,
          lead: {
            name: found.name,
            email: found.email,
            companyName: found.companyName,
            linkedinUrl: found.linkedinUrl,
            emailVerified: found.emailVerified,
            emailVerifiedAt: found.emailVerifiedAt,
            emailVerificationMethod: found.emailVerificationMethod,
            emailVerificationConfidence: found.emailVerificationConfidence,
            emailVerificationReason: found.emailVerificationReason
          }
        });
      } catch (err) {
        console.error('❌ Lookup failed:', err.message);
        res.status(500).json({ exists: false, error: 'server_error' });
      }
    });

    app.get('/api/leads/export', async (req, res) => {
      try {
        const { format = 'csv', secret } = req.query;
        
        // SECURITY: Use environment variable for export secret
        if (secret !== process.env.EXPORT_SECRET) {
          return res.status(401).json({ error: 'Invalid secret key' });
        }
        
        const leadsData = await leads.find({
          email: { $exists: true, $ne: null, $ne: "", $nin: ["noemail@domain.com", "No email found"] }
        }, {
          projection: { _id: 0, name: 1, email: 1, companyName: 1, sourcedBy: 1, linkedinUrl: 1, location: 1, headline: 1, currentTitle: 1 }
        }).toArray();
        
        if (format === 'json') {
          return res.json({ success: true, count: leadsData.length, data: leadsData });
        }
        
        const headers = ['Name', 'Email', 'Company', 'SourcedBy', 'LinkedInURL', 'Location', 'Headline', 'Title'];
        const csvRows = [headers.join(',')];
        
        for (const lead of leadsData) {
          csvRows.push([
            `"${(lead.name || '').replace(/"/g, '""')}"`,
            `"${(lead.email || '').replace(/"/g, '""')}"`,
            `"${(lead.companyName || '').replace(/"/g, '""')}"`,
            `"${(lead.sourcedBy || '').replace(/"/g, '""')}"`,
            `"${(lead.linkedinUrl || '').replace(/"/g, '""')}"`,
            `"${(lead.location || '').replace(/"/g, '""')}"`,
            `"${(lead.headline || '').replace(/"/g, '""')}"`,
            `"${(lead.currentTitle || '').replace(/"/g, '""')}"`
          ].join(','));
        }
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=leads_export_${new Date().toISOString().split('T')[0]}.csv`);
        return res.send(csvRows.join('\n'));
      } catch (err) {
        res.status(500).json({ error: 'Export failed', message: err.message });
      }
    });

    app.put('/api/leads/upsert-email', async (req, res) => {
      try {
        const { linkedinUrl, email } = req.body || {};
        if (!linkedinUrl || !isValidEmail(email)) {
          return res.status(400).json({ updated: false, error: 'linkedinUrl and valid email required' });
        }

        const result = await leads.updateOne(
          { linkedinUrl, $or: [{ email: { $exists: false } }, { email: null }, { email: '' }, { email: 'noemail@domain.com' }] },
          { $set: { email } }
        );

        return res.json({ updated: result.modifiedCount > 0 });
      } catch (err) {
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
        await learnFromLead(db, lead);
        res.status(200).json({ success: true, message: 'Lead saved to MongoDB!' });
      } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to save lead.' });
      }
    });

    // ========================================================================
    // ODOO CRM EXPORT - SECURE VERSION
    // ========================================================================

    async function rollbackCreatedRecords(callOdoo, createdRecords) {
      const rollbackResults = [];
      try {
        if (createdRecords.opportunity || createdRecords.candidate) {
          const entityType = createdRecords.opportunity ? 'opportunity' : 'candidate';
          const entityId = createdRecords.opportunity || createdRecords.candidate;
          const modelName = createdRecords.opportunity ? 'crm.lead' : 'hr.candidate';
          try {
            await callOdoo(modelName, 'unlink', [[entityId]]);
            rollbackResults.push({ type: entityType, id: entityId, status: 'deleted' });
          } catch (err) {
            rollbackResults.push({ type: entityType, id: entityId, status: 'failed' });
          }
        }
        if (createdRecords.contact) {
          try {
            await callOdoo('res.partner', 'unlink', [[createdRecords.contact]]);
            rollbackResults.push({ type: 'contact', id: createdRecords.contact, status: 'deleted' });
          } catch (err) {
            rollbackResults.push({ type: 'contact', id: createdRecords.contact, status: 'failed' });
          }
        }
        if (createdRecords.company) {
          try {
            await callOdoo('res.partner', 'unlink', [[createdRecords.company]]);
            rollbackResults.push({ type: 'company', id: createdRecords.company, status: 'deleted' });
          } catch (err) {
            rollbackResults.push({ type: 'company', id: createdRecords.company, status: 'failed' });
          }
        }
        if (createdRecords.skill) {
          try {
            await callOdoo('hr.candidate.skill', 'unlink', [[createdRecords.skill]]);
            rollbackResults.push({ type: 'skill', id: createdRecords.skill, status: 'deleted' });
          } catch (err) {
            rollbackResults.push({ type: 'skill', id: createdRecords.skill, status: 'failed' });
          }
        }
      } catch (err) {
        console.error('❌ Rollback process error:', err.message);
      }
      return rollbackResults;
    }

    // SECURE ODOO EXPORT - No client credentials
    app.post('/api/crm/export-odoo', async (req, res) => {
      try {
        // SECURITY: Do NOT accept crmConfig from client
        const { leadData, userEmail, linkedinUrl, profileType, extractedSkill } = req.body;

        const crmConfig = getOdooConfig();

        if (!validateOdooConfig()) {
          return res.status(500).json({ success: false, error: 'CRM configuration missing on server' });
        }

        if (!leadData || !leadData.name) {
          return res.status(400).json({ error: 'Lead data with name is required' });
        }

        if (!profileType || !['client', 'candidate'].includes(profileType.toLowerCase())) {
          return res.status(400).json({ error: 'Valid profileType required' });
        }

        const cleanName = sanitizeForOdoo(leadData.name);
        if (cleanName.length < 2) {
          return res.status(400).json({ error: 'Invalid name' });
        }

        let cleanCompany = sanitizeForOdoo(leadData.companyName || leadData.company || '');
        if (!cleanCompany && leadData.comment) {
          const match = leadData.comment.match(/Company:\s*(.+)/);
          if (match) cleanCompany = sanitizeForOdoo(match[1].split('\n')[0]);
        }

        let sourcedBy = sanitizeForOdoo(leadData.sourcedBy || '');
        if (!sourcedBy && leadData.comment) {
          const match = leadData.comment.match(/Sourced by:\s*(.+)/);
          if (match) sourcedBy = sanitizeForOdoo(match[1].split('\n')[0]);
        }

        if (!cleanCompany || cleanCompany.length < 2) {
          return res.status(400).json({ error: 'Invalid company name' });
        }

        const isCandidate = profileType.toLowerCase() === 'candidate';
        console.log(`Odoo export (${isCandidate ? 'candidate' : 'client'}):`, { lead: cleanName, company: cleanCompany });

        // Authenticate
        const authResponse = await fetch(`${crmConfig.endpointUrl}/web/session/authenticate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: "2.0",
            params: { db: crmConfig.databaseName, login: crmConfig.username, password: crmConfig.password }
          })
        });

        const setCookieHeader = authResponse.headers.get('set-cookie');
        let cookies = setCookieHeader ? setCookieHeader.split(',').map(c => c.trim().split(';')[0]).join('; ') : '';

        const authResult = await authResponse.json();
        if (!authResult.result?.uid) throw new Error('Invalid Odoo credentials');

        const userId = authResult.result.uid;
        if (!cookies && authResult.result.session_id) cookies = `session_id=${authResult.result.session_id}`;

        const odooUrl = `${crmConfig.endpointUrl}/jsonrpc`;

        async function callOdoo(model, method, args) {
          const response = await fetch(odooUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': cookies },
            body: JSON.stringify({
              jsonrpc: "2.0", method: "call",
              params: { service: "object", method: "execute_kw", args: [crmConfig.databaseName, userId, crmConfig.password, model, method, args] },
              id: Date.now()
            })
          });
          const result = await response.json();
          if (result.error) throw new Error(result.error.data?.message || result.error.message || 'Odoo API error');
          return result.result;
        }

        const createdRecords = { company: null, contact: null, opportunity: null, candidate: null, skill: null };

        try {
          if (isCandidate) {
            const cleanEmail = isValidEmail(leadData.email) && leadData.email !== 'No email found' ? sanitizeForOdoo(leadData.email) : null;

            // Duplicate check
            const candidatesByName = await callOdoo('hr.candidate', 'search_read', [
              [['partner_name', '=', cleanName], ...(cleanEmail ? [['email_from', '=', cleanEmail]] : [])],
              ['id', 'partner_name', 'email_from', 'linkedin_profile']
            ]);

            let candidatesByLinkedIn = [];
            if (linkedinUrl) {
              candidatesByLinkedIn = await callOdoo('hr.candidate', 'search_read', [
                [['linkedin_profile', '=', linkedinUrl]], ['id', 'partner_name', 'email_from', 'linkedin_profile']
              ]);
            }

            const allCandidates = [...(candidatesByName || []), ...(candidatesByLinkedIn || [])];
            const uniqueCandidates = allCandidates.filter((c, i, self) => i === self.findIndex(x => x.id === c.id));

            if (uniqueCandidates.length > 0) {
              const existing = uniqueCandidates[0];
              const matchedBy = candidatesByLinkedIn.some(c => c.id === existing.id) ? 'LinkedIn URL' : 'Name/Email';
              
              await exportLogs.insertOne({
                leadName: cleanName, leadEmail: cleanEmail, linkedinUrl, crmType: 'odoo', crmId: existing.id,
                exportedBy: userEmail, exportedAt: new Date(), status: 'duplicate', profileType: 'candidate'
              });

              return res.json({ success: false, alreadyExists: true, message: `Candidate exists (${matchedBy})`, crmId: existing.id });
            }

            // Create contact
            const contactData = { name: cleanName, type: 'contact', is_company: false, customer_rank: 0 };
            if (cleanEmail) contactData.email = cleanEmail;
            if (leadData.phone) contactData.phone = sanitizeForOdoo(leadData.phone);

            const contactResult = await callOdoo('res.partner', 'create', [[contactData]]);
            const contactId = Array.isArray(contactResult) ? contactResult[0] : contactResult;
            createdRecords.contact = contactId;

            // Create candidate
            const candidateData = {
              partner_name: cleanName,
              partner_id: parseInt(contactId, 10),
              email_from: cleanEmail || 'noemail@domain.com',
              company_id: 1,
              linkedin_profile: linkedinUrl
            };

            if (sourcedBy) {
              const salespersons = await callOdoo('res.users', 'search_read', [[['name', 'ilike', sourcedBy]], ['id']]);
              candidateData.user_id = salespersons?.[0]?.id || userId;
            } else {
              candidateData.user_id = userId;
            }

            const candidateResult = await callOdoo('hr.candidate', 'create', [[candidateData]]);
            const candidateId = Array.isArray(candidateResult) ? candidateResult[0] : candidateResult;
            createdRecords.candidate = candidateId;

            // Create skill if provided
            const mainSkill = extractedSkill ? sanitizeForOdoo(extractedSkill) : null;
            if (mainSkill) {
              try {
                let itSkillTypeId;
                const skillTypes = await callOdoo('hr.skill.type', 'search_read', [[['name', '=', 'IT']], ['id']]);
                if (skillTypes?.length > 0) {
                  itSkillTypeId = skillTypes[0].id;
                } else {
                  const typeResult = await callOdoo('hr.skill.type', 'create', [[{ name: 'IT' }]]);
                  itSkillTypeId = Array.isArray(typeResult) ? typeResult[0] : typeResult;
                }

                let skillId;
                const skills = await callOdoo('hr.skill', 'search_read', [[['name', 'ilike', mainSkill], ['skill_type_id', '=', itSkillTypeId]], ['id']]);
                if (skills?.length > 0) {
                  skillId = skills[0].id;
                } else {
                  const skillResult = await callOdoo('hr.skill', 'create', [[{ name: mainSkill, skill_type_id: itSkillTypeId }]]);
                  skillId = Array.isArray(skillResult) ? skillResult[0] : skillResult;
                }

                let skillLevelId;
                const levels = await callOdoo('hr.skill.level', 'search_read', [[['name', '=', 'Expert'], ['skill_type_id', '=', itSkillTypeId]], ['id']]);
                if (levels?.length > 0) {
                  skillLevelId = levels[0].id;
                } else {
                  const levelResult = await callOdoo('hr.skill.level', 'create', [[{ name: 'Expert', level_progress: 100, skill_type_id: itSkillTypeId }]]);
                  skillLevelId = Array.isArray(levelResult) ? levelResult[0] : levelResult;
                }

                const existingSkills = await callOdoo('hr.candidate.skill', 'search_read', [[['candidate_id', '=', candidateId], ['skill_id', '=', skillId]], ['id']]);
                if (!existingSkills?.length) {
                  const skillLinkResult = await callOdoo('hr.candidate.skill', 'create', [[{
                    candidate_id: candidateId, skill_id: skillId, skill_level_id: skillLevelId, skill_type_id: itSkillTypeId
                  }]]);
                  createdRecords.skill = Array.isArray(skillLinkResult) ? skillLinkResult[0] : skillLinkResult;
                }
              } catch (skillErr) {
                console.warn('Skill creation failed:', skillErr.message);
              }
            }

            await exportLogs.insertOne({
              leadName: cleanName, leadEmail: cleanEmail, linkedinUrl, crmType: 'odoo', crmId: candidateId,
              contactId, exportedBy: userEmail, exportedAt: new Date(), status: 'success', profileType: 'candidate', mainSkill: mainSkill || 'None'
            });

            return res.json({
              success: true, message: 'Candidate exported to Odoo', crmId: candidateId, crmType: 'odoo', profileType: 'candidate',
              details: { contactCreated: true, candidateCreated: true, skillExtracted: mainSkill || 'None', contactId }
            });

          } else {
            // CLIENT FLOW
            let linkedinSourceId;
            const sources = await callOdoo('utm.source', 'search_read', [[['name', '=', 'LinkedIn']], ['id']]);
            if (sources?.length > 0) {
              linkedinSourceId = sources[0].id;
            } else {
              linkedinSourceId = await callOdoo('utm.source', 'create', [[{ name: 'LinkedIn' }]]);
            }

            let salespersonId = userId;
            if (sourcedBy) {
              const salespersons = await callOdoo('res.users', 'search_read', [[['name', 'ilike', sourcedBy]], ['id']]);
              if (salespersons?.length > 0) salespersonId = salespersons[0].id;
            }

            // Check/create company
            const existingCompanies = await callOdoo('res.partner', 'search_read', [
              [['name', '=', cleanCompany], ['is_company', '=', true]], ['id']
            ]);

            let companyId, isExistingCompany, clientType;
            if (existingCompanies?.length > 0) {
              companyId = existingCompanies[0].id;
              isExistingCompany = true;
              clientType = 'Existing Client';
            } else {
              const companyResult = await callOdoo('res.partner', 'create', [[{
                name: cleanCompany, is_company: true, customer_rank: 1, user_id: salespersonId
              }]]);
              companyId = Array.isArray(companyResult) ? companyResult[0] : companyResult;
              isExistingCompany = false;
              clientType = 'New Prospect';
              createdRecords.company = companyId;
            }

            // Check/create contact
            const existingContacts = await callOdoo('res.partner', 'search_read', [
              [['name', '=', cleanName], ['parent_id', '=', companyId]], ['id']
            ]);

            let contactId, contactAlreadyExists;
            if (existingContacts?.length > 0) {
              contactId = existingContacts[0].id;
              contactAlreadyExists = true;
            } else {
              const contactData = {
                name: cleanName, parent_id: parseInt(companyId, 10), type: 'contact', is_company: false, customer_rank: 1
              };

              const email = sanitizeForOdoo(leadData.email || '');
              contactData.email = (email && isValidEmail(email) && email !== 'No email found') ? email : 'noemail@domain.com';
              if (leadData.phone) contactData.phone = sanitizeForOdoo(leadData.phone);
              if (leadData.function) contactData.function = sanitizeForOdoo(leadData.function);
              if (leadData.street) contactData.street = sanitizeForOdoo(leadData.street);
              if (leadData.comment) contactData.comment = sanitizeString(leadData.comment, 1000);

              const contactResult = await callOdoo('res.partner', 'create', [[contactData]]);
              contactId = Array.isArray(contactResult) ? contactResult[0] : contactResult;
              contactAlreadyExists = false;
              createdRecords.contact = contactId;
            }

            // Check for duplicate opportunities
            const existingLeadsByContact = await callOdoo('crm.lead', 'search_read', [
              [['partner_id', '=', contactId], ['active', '=', true]], ['id', 'name', 'stage_id']
            ]);

            let existingLeadsByLinkedIn = [];
            if (linkedinUrl) {
              existingLeadsByLinkedIn = await callOdoo('crm.lead', 'search_read', [
                [['website', '=', linkedinUrl], ['active', '=', true]], ['id', 'name', 'stage_id']
              ]);
            }

            const allLeads = [...existingLeadsByContact, ...existingLeadsByLinkedIn];
            const uniqueLeads = allLeads.filter((l, i, self) => i === self.findIndex(x => x.id === l.id));

            if (uniqueLeads.length > 0) {
              const existingLead = uniqueLeads[0];
              await rollbackCreatedRecords(callOdoo, createdRecords);

              await exportLogs.insertOne({
                leadName: cleanName, linkedinUrl, crmType: 'odoo', crmId: existingLead.id,
                exportedBy: userEmail, exportedAt: new Date(), status: 'duplicate', profileType: 'client'
              });

              return res.json({
                success: false, alreadyExists: true, message: `Opportunity exists (ID: ${existingLead.id})`,
                crmId: existingLead.id, opportunityName: existingLead.name, stage: existingLead.stage_id?.[1]
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

            const emailFrom = sanitizeForOdoo(leadData.email || '');
            leadCreateData.email_from = (emailFrom && isValidEmail(emailFrom) && emailFrom !== 'No email found') ? emailFrom : 'noemail@domain.com';
            if (leadData.phone) leadCreateData.phone = sanitizeForOdoo(leadData.phone);
            if (leadData.function) leadCreateData.function = sanitizeForOdoo(leadData.function);
            if (leadData.street) leadCreateData.street = sanitizeForOdoo(leadData.street);
            if (linkedinUrl) leadCreateData.website = linkedinUrl;

            const leadResult = await callOdoo('crm.lead', 'create', [[leadCreateData]]);
            const leadId = Array.isArray(leadResult) ? leadResult[0] : leadResult;
            createdRecords.opportunity = leadId;

            await exportLogs.insertOne({
              leadName: cleanName, linkedinUrl, crmType: 'odoo', crmId: leadId, companyId, contactId,
              exportedBy: userEmail, exportedAt: new Date(), status: 'success', profileType: 'client', clientType
            });

            return res.json({
              success: true, message: `Lead exported as ${clientType}`, crmId: leadId, crmType: 'odoo', profileType: 'client',
              details: { companyCreated: !isExistingCompany, contactCreated: !contactAlreadyExists, leadCreated: true, clientType, companyId, contactId }
            });
          }

        } catch (creationError) {
          await rollbackCreatedRecords(callOdoo, createdRecords);
          throw creationError;
        }

      } catch (error) {
        console.error('Odoo export error:', error);
        await exportLogs.insertOne({
          leadName: req.body.leadData?.name, linkedinUrl: req.body.linkedinUrl, crmType: 'odoo',
          profileType: req.body.profileType, exportedBy: req.body.userEmail, exportedAt: new Date(),
          status: 'failed', errorMessage: error.message
        }).catch(() => {});

        res.status(500).json({ success: false, error: error.message || 'Export failed' });
      }
    });

    // CHECK EXPORT (SECURE)
    app.get('/api/crm/check-export', async (req, res) => {
      try {
        const { url, userEmail } = req.query;

        if (!url || !userEmail) {
          return res.status(400).json({ error: 'URL and userEmail required', alreadyExported: false });
        }

        const existingExport = await exportLogs.findOne({
          linkedinUrl: url, exportedBy: userEmail, status: 'success', crmType: 'odoo'
        });

        if (!existingExport) return res.json({ alreadyExported: false });

        const crmConfig = getOdooConfig();
        if (!validateOdooConfig()) {
          return res.json({ alreadyExported: true, exportedAt: existingExport.exportedAt, crmId: existingExport.crmId, verified: false });
        }

        try {
          const authResponse = await fetch(`${crmConfig.endpointUrl}/web/session/authenticate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: "2.0",
              params: { db: crmConfig.databaseName, login: crmConfig.username, password: crmConfig.password }
            })
          });

          const setCookieHeader = authResponse.headers.get('set-cookie');
          let cookies = setCookieHeader ? setCookieHeader.split(',').map(c => c.trim().split(';')[0]).join('; ') : '';

          const authResult = await authResponse.json();
          if (!authResult.result?.uid) throw new Error('Auth failed');

          const userId = authResult.result.uid;
          if (!cookies && authResult.result.session_id) cookies = `session_id=${authResult.result.session_id}`;

          const modelName = existingExport.profileType === 'candidate' ? 'hr.candidate' : 'crm.lead';
          
          const checkResponse = await fetch(`${crmConfig.endpointUrl}/jsonrpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': cookies },
            body: JSON.stringify({
              jsonrpc: "2.0", method: "call",
              params: {
                service: "object", method: "execute_kw",
                args: [crmConfig.databaseName, userId, crmConfig.password, modelName, 'search_read', [[['id', '=', existingExport.crmId]]], ['id', 'name', 'active']]
              },
              id: Date.now()
            })
          });

          const checkResult = await checkResponse.json();
          const records = checkResult.result || [];

          if (records.length === 0) {
            return res.json({ alreadyExported: false, wasDeleted: true, mongoDbHasLog: true });
          }

          return res.json({ alreadyExported: true, exportedAt: existingExport.exportedAt, crmId: existingExport.crmId, verified: true });

        } catch (odooError) {
          return res.json({ alreadyExported: true, exportedAt: existingExport.exportedAt, crmId: existingExport.crmId, verified: false });
        }

      } catch (error) {
        res.status(200).json({ alreadyExported: false, error: error.message });
      }
    });

    console.log('✅ Odoo CRM endpoints registered (SECURE MODE)');

    // HEALTH CHECK
    app.get('/health', (req, res) => {
      res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: '2.0.0-secure',
        features: {
          openaiProxy: !!process.env.OPENAI_API_KEY,
          odooIntegration: validateOdooConfig(),
          emailEnrichment: true
        }
      });
    });

    // START SERVER
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log('');
      console.log('📋 Environment Check:');
      console.log(`   MONGO_URL: ${mongoUrl ? '✅' : '❌'}`);
      console.log(`   OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
      console.log(`   ODOO_ENDPOINT: ${process.env.ODOO_ENDPOINT ? '✅' : '❌'}`);
      console.log(`   ODOO_USERNAME: ${process.env.ODOO_USERNAME ? '✅' : '❌'}`);
      console.log(`   ODOO_PASSWORD: ${process.env.ODOO_PASSWORD ? '✅' : '❌'}`);
      console.log(`   ODOO_DATABASE: ${process.env.ODOO_DATABASE ? '✅' : '❌'}`);
      console.log('');
      console.log('🔐 Security: All credentials are server-side only');
    });

  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  }
}

startServer();