// ============================================================================
// enrichEmails.js - Production-Ready Email Enrichment
// Complete replacement for your existing enrichEmails.js file
// ============================================================================

const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URL);

// Enhanced validation sets
const GENERIC_LOCALS = new Set([
  "info", "hr", "jobs", "job", "career", "careers", "hello", "contact", 
  "sales", "support", "help", "team", "admin", "office", "enquiries", 
  "inquiries", "recruiter", "talent", "hiring", "mail", "marketing", 
  "noreply", "no-reply", "donotreply", "webmaster", "postmaster"
]);

const PUBLIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "aol.com", "gmx.com", "yandex.com", "mail.ru",
  "qq.com", "163.com", "protonmail.com", "zoho.com"
]);

function parseEmail(e = "") {
  const m = e.toLowerCase().match(/^([^@]+)@([^@]+)$/);
  if (!m) return null;
  return { local: m[1], domain: m[2] };
}

function normName(s = "") {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function splitName(fullName = "") {
  const parts = String(fullName || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(normName)
    .filter(p => p.length > 0);
    
  if (!parts.length) return null;
  
  return {
    first: parts[0],
    last: parts[parts.length - 1],
    middle: parts.length > 2 ? parts[1] : ""
  };
}

// Strict validation for peer emails - only use ORIGINAL, non-enriched emails
function isValidPeerEmail(email, lead) {
  const parsed = parseEmail(email);
  if (!parsed) return false;
  
  // Must not be public domain
  if (PUBLIC_DOMAINS.has(parsed.domain)) return false;
  
  // Must not be generic local
  if (GENERIC_LOCALS.has(parsed.local)) return false;
  
  // Must not be placeholder
  if (email.includes("noemail") || email.includes("example")) return false;
  
  // Must have letters
  if (!/[a-z]/i.test(parsed.local)) return false;
  
  // Check for suspicious patterns
  if (/^(test|demo|sample|dummy|fake|temp)/i.test(parsed.local)) return false;
  
  // CRITICAL: Only use emails that were NOT enriched themselves
  if (lead.emailEnriched === true) return false;
  
  // If email verification exists, only use verified emails
  if (lead.emailVerified === false) return false;
  
  return true;
}

// Extract pattern with validation
function extractEmailPattern(peerEmail, peerFullName, peerLead) {
  // Validate peer email first
  if (!isValidPeerEmail(peerEmail, peerLead)) return null;
  
  const parsed = parseEmail(peerEmail);
  if (!parsed) return null;

  const nameParts = splitName(peerFullName);
  if (!nameParts) return null;

  const { first, last, middle } = nameParts;
  if (!first || !last) return null;

  const local = parsed.local;
  const stripped = local.replace(/[\.\_\-]/g, "");
  
  const patterns = [
    { name: "first.last", template: `${first}.${last}`, confidence: 0.95 },
    { name: "last.first", template: `${last}.${first}`, confidence: 0.95 },
    { name: "first_last", template: `${first}_${last}`, confidence: 0.90 },
    { name: "firstlast", template: `${first}${last}`, confidence: 0.85 },
    { name: "f.last", template: `${first[0]}.${last}`, confidence: 0.80 },
    { name: "flast", template: `${first[0]}${last}`, confidence: 0.70 },
    ...(middle ? [
      { name: "first.middle.last", template: `${first}.${middle}.${last}`, confidence: 0.90 }
    ] : [])
  ];

  for (const pattern of patterns) {
    if (local === pattern.template || stripped === pattern.template.replace(/[\.\_\-]/g, "")) {
      return { 
        pattern: pattern.name, 
        domain: parsed.domain, 
        confidence: pattern.confidence,
        peerEmail,
        peerName: peerFullName,
        peerWasEnriched: peerLead.emailEnriched || false,
        peerWasVerified: peerLead.emailVerified || null
      };
    }
  }

  return null;
}

// Company-level pattern analysis (batch processing)
async function analyzeCompanyPatterns(leads, companyName) {
  // Get all leads from company with VALID, NON-ENRICHED emails
  const companyLeads = await leads.find({
    companyName: companyName,
    email: { $exists: true, $ne: null, $ne: "", $ne: "noemail@domain.com" },
    emailEnriched: { $ne: true }, // CRITICAL: Only use original emails
    $or: [
      { emailVerified: true },      // Prefer verified
      { emailVerified: { $exists: false } } // Or unverified if no verification done
    ]
  }).limit(50).toArray();
  
  if (companyLeads.length === 0) return null;
  
  const patternCounts = {};
  const patternDetails = {};
  
  for (const lead of companyLeads) {
    const patternInfo = extractEmailPattern(lead.email, lead.name, lead);
    
    if (patternInfo) {
      const key = `${patternInfo.pattern}@${patternInfo.domain}`;
      
      if (!patternCounts[key]) {
        patternCounts[key] = 0;
        patternDetails[key] = {
          pattern: patternInfo.pattern,
          domain: patternInfo.domain,
          examples: [],
          avgConfidence: 0,
          totalConfidence: 0,
          verified: 0,
          enriched: 0
        };
      }
      
      patternCounts[key]++;
      patternDetails[key].totalConfidence += patternInfo.confidence;
      patternDetails[key].examples.push({
        name: lead.name,
        email: lead.email
      });
      
      if (lead.emailVerified === true) patternDetails[key].verified++;
      if (lead.emailEnriched === true) patternDetails[key].enriched++;
    }
  }
  
  // Find most reliable pattern
  let bestPattern = null;
  let bestScore = 0;
  
  for (const [key, details] of Object.entries(patternDetails)) {
    const frequency = patternCounts[key];
    const avgConfidence = details.totalConfidence / frequency;
    
    // Calculate quality score
    const verifiedBonus = details.verified / frequency; // 0-1
    const enrichedPenalty = details.enriched / frequency; // 0-1 (penalize enriched sources)
    const frequencyScore = Math.min(frequency / companyLeads.length, 1);
    
    const score = (avgConfidence * 0.5) + 
                  (frequencyScore * 0.3) + 
                  (verifiedBonus * 0.15) - 
                  (enrichedPenalty * 0.25); // Penalize if source was enriched
    
    if (score > bestScore && score > 0.6) {
      bestScore = score;
      bestPattern = {
        ...details,
        frequency,
        avgConfidence,
        score,
        verifiedRatio: verifiedBonus,
        enrichedRatio: enrichedPenalty
      };
    }
  }
  
  return bestPattern;
}

// Check if enrichment already exists
async function enrichmentExists(audits, leadId, email) {
  const existing = await audits.findOne({
    leadId: leadId,
    enrichedEmail: email,
    status: { $in: ['approved', 'applied', 'pending_review'] }
  });
  
  return existing !== null;
}

// Apply pattern to generate email
function applyPattern(pattern, targetName, domain) {
  const nameParts = splitName(targetName);
  if (!nameParts) return null;
  
  const { first, last, middle } = nameParts;
  if (!first || !last) return null;

  const templates = {
    "first.last": `${first}.${last}`,
    "last.first": `${last}.${first}`,
    "first_last": `${first}_${last}`,
    "firstlast": `${first}${last}`,
    "f.last": `${first[0]}.${last}`,
    "flast": `${first[0]}${last}`,
    "first.middle.last": middle ? `${first}.${middle}.${last}` : null
  };

  const template = templates[pattern];
  return template ? `${template}@${domain}` : null;
}

// Main enrichment function
async function enrichEmails() {
  const start = Date.now();
  const runId = new Date().toISOString();
  
  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');
    
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const audits = db.collection("enriched_audit");

    // Create indexes for performance
    await audits.createIndex({ leadId: 1, enrichedEmail: 1 });
    await leads.createIndex({ companyName: 1, emailEnriched: 1 });

    // Get leads needing enrichment
    const missingEmailLeads = await leads.find({
      $or: [
        { email: "noemail@domain.com" },
        { email: { $exists: false } },
        { email: "" },
        { email: null }
      ]
    }).toArray();

    console.log(`🚀 Email enrichment started | Candidates: ${missingEmailLeads.length}`);
    
    // Group by company for batch processing
    const companiesMap = {};
    for (const lead of missingEmailLeads) {
      if (!lead.companyName) continue;
      
      if (!companiesMap[lead.companyName]) {
        companiesMap[lead.companyName] = [];
      }
      companiesMap[lead.companyName].push(lead);
    }
    
    console.log(`📊 Found ${Object.keys(companiesMap).length} unique companies`);
    
    let enriched = 0;
    let skipped = 0;
    let duplicates = 0;

    // Process by company (batch optimization)
    for (const [companyName, companyLeads] of Object.entries(companiesMap)) {
      // Analyze company pattern once for all leads
      const companyPattern = await analyzeCompanyPatterns(leads, companyName);
      
      if (!companyPattern) {
        skipped += companyLeads.length;
        console.log(`⏩ No valid pattern for ${companyName} (${companyLeads.length} leads skipped)`);
        continue;
      }
      
      console.log(`\n🏢 ${companyName} | Pattern: ${companyPattern.pattern} | Score: ${companyPattern.score.toFixed(2)} | Verified: ${(companyPattern.verifiedRatio * 100).toFixed(0)}% | Enriched Sources: ${(companyPattern.enrichedRatio * 100).toFixed(0)}%`);
      
      // Apply to all leads in company
      for (const lead of companyLeads) {
        const enrichedEmail = applyPattern(companyPattern.pattern, lead.name, companyPattern.domain);
        
        if (!enrichedEmail) {
          skipped++;
          continue;
        }
        
        // Check for duplicates
        if (await enrichmentExists(audits, lead._id, enrichedEmail)) {
          duplicates++;
          console.log(`⏩ Duplicate: ${lead.name} | ${enrichedEmail}`);
          continue;
        }
        
        // Store enrichment with enhanced metadata
        await audits.insertOne({
          runId,
          leadId: lead._id,
          companyName,
          originalName: lead.name,
          enrichedEmail,
          pattern: companyPattern.pattern,
          domain: companyPattern.domain,
          confidence: companyPattern.avgConfidence,
          score: companyPattern.score,
          frequency: companyPattern.frequency,
          verifiedSourceRatio: companyPattern.verifiedRatio,
          enrichedSourceRatio: companyPattern.enrichedRatio,
          exampleSources: companyPattern.examples.slice(0, 3), // Keep 3 examples
          timestamp: new Date(),
          status: companyPattern.score >= 0.8 ? 'approved' : 'pending_review'
        });

        enriched++;
        console.log(`✨ ${lead.name} → ${enrichedEmail} (score: ${companyPattern.score.toFixed(2)})`);
      }
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    
    console.log(`\n🎯 EMAIL ENRICHMENT COMPLETE`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Enriched: ${enriched} | Skipped: ${skipped} | Duplicates: ${duplicates}`);
    console.log(`Duration: ${duration}s | Speed: ${(missingEmailLeads.length / (duration / 60)).toFixed(0)} leads/min`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
  } catch (err) {
    console.error("❌ Email enrichment error:", err);
    throw err;
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB');
  }
}

if (require.main === module) {
  enrichEmails()
    .then(() => {
      console.log('✨ Email enrichment completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Email enrichment failed:', error);
      process.exit(1);
    });
}

module.exports = { enrichEmails };
