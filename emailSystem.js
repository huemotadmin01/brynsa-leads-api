// ============================================================================
// emailSystem.js - COMPLETE EMAIL SYSTEM (Single File) + VERIFICATION STATUS
// ============================================================================
// 
// This file contains:
// 1. Instant Email Generation API
// 2. Email Verification (MX/SMTP)
// 3. Confidence Calculation
// 4. All routes
// 5. Verification Status endpoint for extension
// 6. NEW: Placeholder company blocklist to prevent bad pattern learning
//
// INSTALLATION:
// 1. Copy this file to your backend folder
// 2. Add these lines to your index.js (see bottom of this file)
// 3. Deploy
// 4. Run cache rebuild once
//
// ============================================================================

const dns = require("dns").promises;
const net = require("net");

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Verification settings
  SMTP_TIMEOUT: 5000,
  ENABLE_SMTP_CHECK: true,
  MAX_SMTP_CHECKS_PER_DOMAIN: 3,
  
  // Confidence defaults
  DEFAULT_SCRAPED_CONFIDENCE: 0.80,
  DEFAULT_GENERATED_HIGH: 0.90,
  DEFAULT_GENERATED_MEDIUM: 0.75,
  DEFAULT_VERIFIED_SMTP: 0.95,
  DEFAULT_VERIFIED_MX_ONLY: 0.70
};

// Domains that block SMTP verification
const SMTP_BLOCKLIST = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "microsoft.com",
  "apple.com", "icloud.com", "google.com", "amazon.com", "facebook.com"
]);

const PUBLIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
  "icloud.com", "me.com", "aol.com", "protonmail.com", "zoho.com"
]);

// ============================================================================
// PLACEHOLDER COMPANY BLOCKLIST
// These company names should NOT trigger email generation or pattern learning
// ============================================================================
const PLACEHOLDER_COMPANIES = new Set([
  // Confidential/Private
  "confidential",
  "private",
  "undisclosed",
  "not disclosed",
  "withheld",
  "hidden",
  
  // Self-employed variations
  "self-employed",
  "self employed",
  "selfemployed",
  "self",
  
  // Freelance variations
  "freelance",
  "freelancer",
  "freelancing",
  "free lance",
  "free-lance",
  
  // Independent
  "independent",
  "independent consultant",
  "independent contractor",
  "contractor",
  
  // Consultant
  "consultant",
  "consulting",
  
  // Generic placeholders
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "unknown",
  "not available",
  "not applicable",
  "-",
  "--",
  "---",
  ".",
  "..",
  "...",
  
  // Multiple/Various
  "various",
  "multiple",
  "several",
  "different",
  
  // Student/Education
  "student",
  "university",
  "college",
  "school",
  
  // Unemployed/Seeking
  "unemployed",
  "seeking opportunities",
  "looking for opportunities",
  "open to work",
  "available",
  
  // Personal
  "personal",
  "myself",
  "me",
  "my company",
  "own business",
  
  // Test/Demo
  "test",
  "demo",
  "sample",
  "example"
]);

/**
 * Check if a company name is a placeholder that should be blocked
 * @param {string} companyName - The company name to check
 * @returns {boolean} - True if it's a placeholder company
 */
function isPlaceholderCompany(companyName) {
  if (!companyName) return true;
  
  const normalized = String(companyName)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s\-\/]/g, ""); // Keep spaces, hyphens, slashes
  
  // Check exact match
  if (PLACEHOLDER_COMPANIES.has(normalized)) {
    return true;
  }
  
  // Check if normalized (no spaces) version matches
  const noSpaces = normalized.replace(/[\s\-\/]/g, "");
  if (PLACEHOLDER_COMPANIES.has(noSpaces)) {
    return true;
  }
  
  // Check for partial matches (company name starts with placeholder)
  for (const placeholder of PLACEHOLDER_COMPANIES) {
    if (normalized === placeholder || noSpaces === placeholder.replace(/[\s\-\/]/g, "")) {
      return true;
    }
  }
  
  // Check for very short company names (likely invalid)
  if (normalized.length < 2) {
    return true;
  }
  
  return false;
}

// ============================================================================
// SETUP ALL ROUTES
// ============================================================================

function setupEmailSystem(app, db) {
  const patterns = db.collection("company_patterns");
  const leads = db.collection("leads");
  const audits = db.collection("enriched_audit");
  const verifyLogs = db.collection("email_verification_logs");

  // Create indexes
  patterns.createIndex({ companyName: 1 }, { unique: true }).catch(() => {});
  patterns.createIndex({ normalizedName: 1 }).catch(() => {});
  leads.createIndex({ emailVerified: 1, email: 1 }).catch(() => {});

  // ========================================================================
  // POST /api/email/instant - Generate email instantly during scrape
  // ========================================================================
  app.post("/api/email/instant", async (req, res) => {
    try {
      const { name, companyName } = req.body;

      if (!name || !companyName) {
        return res.status(400).json({
          success: false,
          error: "Name and companyName are required"
        });
      }

      // ================================================================
      // BLOCK PLACEHOLDER COMPANIES
      // ================================================================
      if (isPlaceholderCompany(companyName)) {
        console.log(`⏩ Skipping email generation for placeholder company: "${companyName}"`);
        return res.json({
          success: false,
          email: null,
          source: "placeholder_company",
          message: `Company "${companyName}" is a placeholder - cannot generate email`,
          timing: 0
        });
      }
      // ================================================================

      const result = await generateInstantEmail(db, name, companyName);
      return res.json(result);

    } catch (error) {
      console.error("Instant email error:", error);
      return res.status(500).json({ success: false, error: "Internal error" });
    }
  });

  // ========================================================================
  // GET /api/email/pattern/:company - Get pattern for a company
  // ========================================================================
  app.get("/api/email/pattern/:company", async (req, res) => {
    try {
      const companyName = decodeURIComponent(req.params.company);
      
      // Block placeholder companies
      if (isPlaceholderCompany(companyName)) {
        return res.json({ 
          success: false, 
          error: "Placeholder company - no pattern available" 
        });
      }
      
      const pattern = await getCompanyPattern(db, companyName);

      if (pattern) {
        return res.json({
          success: true,
          pattern: pattern.pattern,
          domain: pattern.domain,
          confidence: pattern.confidence,
          frequency: pattern.frequency
        });
      }

      return res.json({ success: false, error: "No pattern found" });

    } catch (error) {
      return res.status(500).json({ success: false, error: "Internal error" });
    }
  });

  // ========================================================================
  // GET /api/email/verification-status - Check if email has been verified
  // NEW: Used by extension to get real-time verification status
  // ========================================================================
  app.get("/api/email/verification-status", async (req, res) => {
    try {
      const { email } = req.query;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: "Email parameter is required"
        });
      }

      const normalizedEmail = email.toLowerCase().trim();

      // Look up the email in leads collection
      const lead = await leads.findOne({
        email: { $regex: new RegExp(`^${normalizedEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
      });

      if (!lead) {
        return res.json({
          success: true,
          found: false,
          verified: undefined, // undefined = not checked yet
          message: "Email not found in database"
        });
      }

      // Return verification status
      return res.json({
        success: true,
        found: true,
        verified: lead.emailVerified,  // true = valid, false = invalid, undefined = not checked
        checkedAt: lead.emailVerifiedAt || null,
        method: lead.emailVerificationMethod || null,
        confidence: lead.emailVerificationConfidence || null,
        reason: lead.emailVerificationReason || null,
        source: lead.emailEnriched ? 'enriched' : 'scraped'
      });

    } catch (error) {
      console.error("Email verification status error:", error);
      return res.status(500).json({ success: false, error: "Internal error" });
    }
  });

  // ========================================================================
  // POST /api/email/rebuild-cache - Rebuild patterns from existing data
  // ========================================================================
  app.post("/api/email/rebuild-cache", async (req, res) => {
    try {
      const { secret } = req.body;
      
      if (secret !== process.env.REBUILD_SECRET) {
        return res.status(401).json({ success: false, error: "Invalid secret" });
      }

      const result = await rebuildPatternCache(db);
      return res.json(result);

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========================================================================
  // GET /api/email/stats - Get system statistics
  // ========================================================================
  app.get("/api/email/stats", async (req, res) => {
    try {
      const totalPatterns = await patterns.countDocuments();
      const totalLeads = await leads.countDocuments();
      const verified = await leads.countDocuments({ emailVerified: true });
      const invalid = await leads.countDocuments({ emailVerified: false });
      const enriched = await leads.countDocuments({ emailEnriched: true });

      return res.json({
        success: true,
        stats: {
          patterns: totalPatterns,
          leads: totalLeads,
          verified,
          invalid,
          enriched,
          unverified: totalLeads - verified - invalid
        }
      });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========================================================================
  // DELETE /api/email/pattern/:company - Delete a bad pattern (admin)
  // ========================================================================
  app.delete("/api/email/pattern/:company", async (req, res) => {
    try {
      const { secret } = req.query;
      
      if (secret !== process.env.REBUILD_SECRET) {
        return res.status(401).json({ success: false, error: "Invalid secret" });
      }
      
      const companyName = decodeURIComponent(req.params.company);
      const result = await patterns.deleteOne({ companyName });
      
      if (result.deletedCount > 0) {
        console.log(`🗑️ Deleted pattern for: ${companyName}`);
        return res.json({ success: true, message: `Pattern deleted for ${companyName}` });
      }
      
      return res.json({ success: false, error: "Pattern not found" });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ========================================================================
  // POST /api/email/cleanup-placeholders - Remove all placeholder patterns
  // ========================================================================
  app.post("/api/email/cleanup-placeholders", async (req, res) => {
    try {
      const { secret } = req.body;
      
      if (secret !== process.env.REBUILD_SECRET) {
        return res.status(401).json({ success: false, error: "Invalid secret" });
      }

      // Find and delete all placeholder company patterns
      const allPatterns = await patterns.find({}).toArray();
      let deleted = 0;
      const deletedCompanies = [];

      for (const pattern of allPatterns) {
        if (isPlaceholderCompany(pattern.companyName)) {
          await patterns.deleteOne({ _id: pattern._id });
          deleted++;
          deletedCompanies.push(pattern.companyName);
          console.log(`🗑️ Deleted placeholder pattern: ${pattern.companyName}`);
        }
      }

      return res.json({
        success: true,
        deleted,
        companies: deletedCompanies,
        message: `Cleaned up ${deleted} placeholder patterns`
      });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log("✅ Email System routes registered:");
  console.log("   POST /api/email/instant");
  console.log("   GET  /api/email/pattern/:company");
  console.log("   GET  /api/email/verification-status");
  console.log("   POST /api/email/rebuild-cache");
  console.log("   GET  /api/email/stats");
  console.log("   DELETE /api/email/pattern/:company (admin)");
  console.log("   POST /api/email/cleanup-placeholders (admin)");
  console.log("   🛡️ Placeholder company blocklist: ENABLED");
}

// ============================================================================
// INSTANT EMAIL GENERATION
// ============================================================================

async function generateInstantEmail(db, name, companyName) {
  const startTime = Date.now();

  // Double-check placeholder (in case called directly, not via API)
  if (isPlaceholderCompany(companyName)) {
    return {
      success: false,
      email: null,
      source: "placeholder_company",
      message: `Company "${companyName}" is a placeholder`,
      timing: Date.now() - startTime
    };
  }

  // 1. Check company_patterns cache
  let pattern = await getCompanyPattern(db, companyName);

  // 2. Check enriched_audit if no cache
  if (!pattern) {
    pattern = await getPatternFromAudit(db, companyName);
  }

  // 3. Find from peer leads
  if (!pattern) {
    pattern = await findPeerPattern(db, companyName);
  }

  if (!pattern) {
    return {
      success: false,
      email: null,
      source: "no_pattern",
      message: `No pattern found for ${companyName}`,
      timing: Date.now() - startTime
    };
  }

  // Generate email
  const email = applyPatternToName(pattern.pattern, name, pattern.domain);

  if (!email) {
    return {
      success: false,
      email: null,
      source: "generation_failed",
      timing: Date.now() - startTime
    };
  }

  return {
    success: true,
    email,
    pattern: pattern.pattern,
    domain: pattern.domain,
    confidence: pattern.confidence,
    source: pattern.source,
    timing: Date.now() - startTime
  };
}

async function getCompanyPattern(db, companyName) {
  // Block placeholder companies from pattern lookup
  if (isPlaceholderCompany(companyName)) {
    return null;
  }

  const patterns = db.collection("company_patterns");
  
  // Try exact match
  let pattern = await patterns.findOne({ companyName });
  if (pattern) return { ...pattern, source: "cache" };

  // Try normalized match
  const normalized = normalizeCompanyName(companyName);
  pattern = await patterns.findOne({ normalizedName: normalized });
  if (pattern) return { ...pattern, source: "cache_normalized" };

  return null;
}

async function getPatternFromAudit(db, companyName) {
  // Block placeholder companies
  if (isPlaceholderCompany(companyName)) {
    return null;
  }

  const audits = db.collection("enriched_audit");

  const result = await audits.aggregate([
    {
      $match: {
        companyName,
        status: { $in: ["approved", "applied"] }
      }
    },
    {
      $group: {
        _id: { pattern: "$pattern", domain: "$domain" },
        count: { $sum: 1 },
        avgConfidence: { $avg: "$confidence" }
      }
    },
    { $sort: { count: -1 } },
    { $limit: 1 }
  ]).toArray();

  if (result.length > 0) {
    return {
      pattern: result[0]._id.pattern,
      domain: result[0]._id.domain,
      confidence: result[0].avgConfidence,
      frequency: result[0].count,
      source: "audit"
    };
  }

  return null;
}

async function findPeerPattern(db, companyName) {
  // ================================================================
  // BLOCK PLACEHOLDER COMPANIES FROM PEER PATTERN LEARNING
  // ================================================================
  if (isPlaceholderCompany(companyName)) {
    console.log(`⏩ Skipping peer pattern discovery for placeholder: "${companyName}"`);
    return null;
  }
  // ================================================================

  const leads = db.collection("leads");

  const peers = await leads.find({
    companyName,
    email: { $exists: true, $ne: null, $ne: "", $ne: "noemail@domain.com" },
    emailEnriched: { $ne: true }
  }).limit(10).toArray();

  if (peers.length === 0) return null;

  const patternCounts = {};

  for (const peer of peers) {
    const extracted = extractPatternFromEmail(peer.email, peer.name);
    if (extracted) {
      const key = `${extracted.pattern}@${extracted.domain}`;
      if (!patternCounts[key]) {
        patternCounts[key] = { ...extracted, count: 0 };
      }
      patternCounts[key].count++;
    }
  }

  const sorted = Object.values(patternCounts).sort((a, b) => b.count - a.count);
  
  if (sorted.length > 0) {
    const best = sorted[0];
    
    // Cache for future (only if not a placeholder company)
    if (!isPlaceholderCompany(companyName)) {
      await cacheCompanyPattern(db, companyName, best);
    }

    return {
      pattern: best.pattern,
      domain: best.domain,
      confidence: best.confidence * (best.count / peers.length),
      frequency: best.count,
      source: "peer_discovery"
    };
  }

  return null;
}

// ============================================================================
// PATTERN EXTRACTION & APPLICATION
// ============================================================================

function extractPatternFromEmail(email, fullName) {
  const emailLower = (email || "").toLowerCase();
  const match = emailLower.match(/^([^@]+)@([^@]+)$/);
  if (!match) return null;

  const [, local, domain] = match;
  
  // Skip public domains
  if (PUBLIC_DOMAINS.has(domain)) return null;

  const nameParts = splitName(fullName);
  if (!nameParts || !nameParts.first || !nameParts.last) return null;

  const { first, last, middle } = nameParts;
  const stripped = local.replace(/[._-]/g, "");

  const patterns = [
    { name: "first.last", template: `${first}.${last}`, confidence: 0.95 },
    { name: "last.first", template: `${last}.${first}`, confidence: 0.95 },
    { name: "first_last", template: `${first}_${last}`, confidence: 0.90 },
    { name: "firstlast", template: `${first}${last}`, confidence: 0.85 },
    { name: "f.last", template: `${first[0]}.${last}`, confidence: 0.80 },
    { name: "flast", template: `${first[0]}${last}`, confidence: 0.70 },
    { name: "first", template: first, confidence: 0.60 }
  ];

  for (const p of patterns) {
    if (local === p.template || stripped === p.template.replace(/[._-]/g, "")) {
      return { pattern: p.name, domain, confidence: p.confidence };
    }
  }

  return null;
}

function applyPatternToName(pattern, fullName, domain) {
  const nameParts = splitName(fullName);
  if (!nameParts || !nameParts.first || !nameParts.last) return null;

  const { first, last } = nameParts;

  const templates = {
    "first.last": `${first}.${last}`,
    "last.first": `${last}.${first}`,
    "first_last": `${first}_${last}`,
    "firstlast": `${first}${last}`,
    "f.last": `${first[0]}.${last}`,
    "flast": `${first[0]}${last}`,
    "first": first
  };

  const local = templates[pattern];
  return local ? `${local}@${domain}` : null;
}

// ============================================================================
// CACHE MANAGEMENT
// ============================================================================

async function cacheCompanyPattern(db, companyName, patternData) {
  // ================================================================
  // BLOCK PLACEHOLDER COMPANIES FROM BEING CACHED
  // ================================================================
  if (isPlaceholderCompany(companyName)) {
    console.log(`⏩ NOT caching pattern for placeholder company: "${companyName}"`);
    return;
  }
  // ================================================================

  const patterns = db.collection("company_patterns");
  
  try {
    await patterns.updateOne(
      { companyName },
      {
        $set: {
          companyName,
          normalizedName: normalizeCompanyName(companyName),
          pattern: patternData.pattern,
          domain: patternData.domain,
          confidence: patternData.confidence,
          frequency: patternData.count || 1,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn("Cache pattern error:", error.message);
  }
}

async function rebuildPatternCache(db) {
  const audits = db.collection("enriched_audit");
  const patterns = db.collection("company_patterns");
  const leads = db.collection("leads");

  console.log("🔄 Rebuilding pattern cache...");

  // First, clean up any existing placeholder patterns
  const allPatterns = await patterns.find({}).toArray();
  let cleanedUp = 0;
  for (const pattern of allPatterns) {
    if (isPlaceholderCompany(pattern.companyName)) {
      await patterns.deleteOne({ _id: pattern._id });
      cleanedUp++;
      console.log(`🗑️ Cleaned up placeholder pattern: ${pattern.companyName}`);
    }
  }
  if (cleanedUp > 0) {
    console.log(`✅ Cleaned up ${cleanedUp} placeholder patterns`);
  }

  // From enriched_audit (skip placeholders)
  const auditPatterns = await audits.aggregate([
    {
      $match: {
        status: { $in: ["approved", "applied"] },
        confidence: { $gte: 0.6 }
      }
    },
    {
      $group: {
        _id: "$companyName",
        pattern: { $first: "$pattern" },
        domain: { $first: "$domain" },
        avgConfidence: { $avg: "$confidence" },
        frequency: { $sum: 1 }
      }
    }
  ]).toArray();

  let cached = 0;

  for (const ap of auditPatterns) {
    // Skip placeholder companies
    if (isPlaceholderCompany(ap._id)) {
      console.log(`⏩ Skipping placeholder from audit: ${ap._id}`);
      continue;
    }

    await patterns.updateOne(
      { companyName: ap._id },
      {
        $set: {
          companyName: ap._id,
          normalizedName: normalizeCompanyName(ap._id),
          pattern: ap.pattern,
          domain: ap.domain,
          confidence: ap.avgConfidence,
          frequency: ap.frequency,
          source: "enriched_audit",
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );
    cached++;
  }

  // From original leads (not enriched, skip placeholders)
  const leadPatterns = await leads.aggregate([
    {
      $match: {
        email: { $exists: true, $ne: null, $ne: "", $ne: "noemail@domain.com" },
        emailEnriched: { $ne: true }
      }
    },
    {
      $group: {
        _id: "$companyName",
        emails: { $push: { name: "$name", email: "$email" } },
        count: { $sum: 1 }
      }
    }
  ]).toArray();

  let fromLeads = 0;

  for (const lp of leadPatterns) {
    // Skip placeholder companies
    if (isPlaceholderCompany(lp._id)) {
      console.log(`⏩ Skipping placeholder from leads: ${lp._id}`);
      continue;
    }

    const existing = await patterns.findOne({ companyName: lp._id });
    if (existing) continue;

    for (const item of lp.emails) {
      const extracted = extractPatternFromEmail(item.email, item.name);
      if (extracted) {
        await patterns.updateOne(
          { companyName: lp._id },
          {
            $set: {
              companyName: lp._id,
              normalizedName: normalizeCompanyName(lp._id),
              pattern: extracted.pattern,
              domain: extracted.domain,
              confidence: extracted.confidence,
              frequency: lp.count,
              source: "original_leads",
              updatedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date() }
          },
          { upsert: true }
        );
        fromLeads++;
        break;
      }
    }
  }

  console.log(`✅ Cache rebuilt: ${cached} from audit, ${fromLeads} from leads`);
  if (cleanedUp > 0) {
    console.log(`🗑️ Cleaned up: ${cleanedUp} placeholder patterns`);
  }

  return {
    success: true,
    fromAudit: cached,
    fromLeads: fromLeads,
    cleanedUp: cleanedUp,
    total: cached + fromLeads
  };
}

// ============================================================================
// EMAIL VERIFICATION (for verifyEmails.js cron)
// ============================================================================

async function verifyEmail(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) {
    return { valid: false, reason: "invalid_format", confidence: 0 };
  }

  // Check MX records
  const mxResult = await checkMXRecords(domain);
  
  if (!mxResult.valid) {
    return { 
      valid: false, 
      reason: mxResult.reason, 
      confidence: 0,
      method: "mx_check"
    };
  }

  // Skip SMTP for blocklisted domains
  if (SMTP_BLOCKLIST.has(domain)) {
    return {
      valid: true,
      reason: "mx_valid_smtp_skipped",
      confidence: CONFIG.DEFAULT_VERIFIED_MX_ONLY,
      method: "mx_only"
    };
  }

  // SMTP check
  if (CONFIG.ENABLE_SMTP_CHECK) {
    const smtpResult = await checkSMTP(email, mxResult.mxHost);
    
    if (smtpResult.valid) {
      return {
        valid: true,
        reason: "smtp_verified",
        confidence: CONFIG.DEFAULT_VERIFIED_SMTP,
        method: "smtp"
      };
    }
    
    if (smtpResult.definitelyInvalid) {
      return {
        valid: false,
        reason: smtpResult.reason,
        confidence: 0,
        method: "smtp"
      };
    }
  }

  // Fallback to MX result
  return {
    valid: true,
    reason: "mx_valid",
    confidence: CONFIG.DEFAULT_VERIFIED_MX_ONLY,
    method: "mx_only"
  };
}

async function checkMXRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);

    if (!records || records.length === 0) {
      return { valid: false, reason: "no_mx_records", mxHost: null };
    }

    records.sort((a, b) => a.priority - b.priority);
    return {
      valid: true,
      reason: "mx_found",
      mxHost: records[0].exchange
    };

  } catch (error) {
    const code = error.code || "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { valid: false, reason: "domain_not_found", mxHost: null };
    }
    return { valid: false, reason: `dns_error_${code}`, mxHost: null };
  }
}

async function checkSMTP(email, mxHost) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let response = "";
    let stage = "connect";

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ valid: false, definitelyInvalid: false, reason: "timeout" });
    }, CONFIG.SMTP_TIMEOUT);

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve({ valid: false, definitelyInvalid: false, reason: "connection_error" });
    });

    socket.on("data", (data) => {
      response += data.toString();
      const code = parseInt(response.substring(0, 3));

      try {
        switch (stage) {
          case "connect":
            if (code === 220) {
              stage = "helo";
              socket.write("HELO verify.local\r\n");
            } else {
              finish(false, false, "connect_rejected");
            }
            break;

          case "helo":
            if (code === 250) {
              stage = "mail";
              socket.write("MAIL FROM:<verify@verify.local>\r\n");
            } else {
              finish(false, false, "helo_rejected");
            }
            break;

          case "mail":
            if (code === 250) {
              stage = "rcpt";
              socket.write(`RCPT TO:<${email}>\r\n`);
            } else {
              finish(false, false, "mail_rejected");
            }
            break;

          case "rcpt":
            if (code === 250 || code === 251) {
              finish(true, false, "accepted");
            } else if (code >= 550 && code <= 554) {
              finish(false, true, `rejected_${code}`);
            } else {
              finish(false, false, `unknown_${code}`);
            }
            break;
        }
      } catch (e) {
        finish(false, false, "parse_error");
      }
    });

    function finish(valid, definitelyInvalid, reason) {
      clearTimeout(timeout);
      socket.write("QUIT\r\n");
      socket.destroy();
      resolve({ valid, definitelyInvalid, reason });
    }

    socket.connect(25, mxHost);
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function normalizeCompanyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(pvt|ltd|llc|inc|corp|limited|private|llp)$/g, "")
    .trim();
}

function normalizeName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function splitName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(normalizeName)
    .filter(p => p.length > 0);

  if (!parts.length) return null;

  return {
    first: parts[0],
    last: parts[parts.length - 1],
    middle: parts.length > 2 ? parts[1] : ""
  };
}

// ============================================================================
// LEARN FROM NEW LEADS (call after saving lead)
// ============================================================================

async function learnFromLead(db, lead) {
  if (!lead.email || lead.email === "noemail@domain.com") return;
  
  // ================================================================
  // BLOCK PLACEHOLDER COMPANIES FROM LEARNING
  // ================================================================
  if (isPlaceholderCompany(lead.companyName)) {
    console.log(`⏩ NOT learning from placeholder company: "${lead.companyName}"`);
    return;
  }
  // ================================================================
  
  const domain = lead.email.split("@")[1]?.toLowerCase();
  if (!domain || PUBLIC_DOMAINS.has(domain)) return;

  const pattern = extractPatternFromEmail(lead.email, lead.name);
  if (pattern && lead.companyName) {
    await cacheCompanyPattern(db, lead.companyName, {
      ...pattern,
      count: 1
    });
    console.log(`📚 Learned: ${lead.companyName} → ${pattern.pattern}@${pattern.domain}`);
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  setupEmailSystem,
  generateInstantEmail,
  verifyEmail,
  learnFromLead,
  rebuildPatternCache,
  extractPatternFromEmail,
  cacheCompanyPattern,
  isPlaceholderCompany,  // Export for use in other modules
  PLACEHOLDER_COMPANIES, // Export the set for reference
  CONFIG
};


// ============================================================================
// ============================================================================
//
//                    HOW TO ADD TO YOUR index.js
//
// ============================================================================
// ============================================================================

/*

// ==================== STEP 1: Add import at top ====================

const { setupEmailSystem, learnFromLead } = require('./emailSystem');


// ==================== STEP 2: After MongoDB connection ====================

// After: const db = client.db("brynsaleads");
// Add:
setupEmailSystem(app, db);


// ==================== STEP 3: In POST /api/leads, after insert ====================

// After: const result = await leads.insertOne(lead);
// Add:
await learnFromLead(db, lead);


// ==================== THAT'S IT! ====================

*/