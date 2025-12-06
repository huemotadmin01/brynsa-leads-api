// ============================================================================
// verifyEmails.js - Batch Email Verification using FREE methods
// Run via GitHub Actions cron job
// ============================================================================

const { MongoClient } = require("mongodb");
const dns = require("dns").promises;
const net = require("net");

const client = new MongoClient(process.env.MONGO_URL);

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  BATCH_SIZE: 100,                    // Emails per run
  SMTP_TIMEOUT: 5000,                 // 5 seconds
  ENABLE_SMTP_CHECK: true,            // Set false for faster runs
  RETRY_FAILED_AFTER_DAYS: 7,         // Retry failed verifications
  MAX_SMTP_CHECKS_PER_DOMAIN: 3,      // Avoid rate limits per domain
  CONCURRENCY: 5                       // Parallel verifications
};

// Known disposable email domains (sample - expand as needed)
const DISPOSABLE_DOMAINS = new Set([
  "tempmail.com", "throwaway.email", "guerrillamail.com", "10minutemail.com",
  "mailinator.com", "maildrop.cc", "yopmail.com", "fakeinbox.com",
  "sharklasers.com", "getairmail.com", "temp-mail.org", "dispostable.com"
]);

// Domains known to block SMTP verification
const SMTP_BLOCKLIST = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "microsoft.com",
  "apple.com", "icloud.com", "google.com", "amazon.com", "facebook.com"
]);

// ============================================================================
// MAIN VERIFICATION FUNCTION
// ============================================================================

async function verifyEmails() {
  const start = Date.now();
  const runId = new Date().toISOString();

  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const verifyLogs = db.collection("email_verification_logs");

    // Create indexes
    await leads.createIndex({ emailVerified: 1, email: 1 });
    await verifyLogs.createIndex({ email: 1, verifiedAt: -1 });

    // Find emails to verify
    const retryDate = new Date(Date.now() - CONFIG.RETRY_FAILED_AFTER_DAYS * 24 * 60 * 60 * 1000);

    const toVerify = await leads.find({
      email: { $exists: true, $ne: null, $ne: "", $ne: "noemail@domain.com" },
      $or: [
        { emailVerified: { $exists: false } },          // Never verified
        { emailVerified: null },                         // Null value
        {                                                // Failed but ready for retry
          emailVerified: false,
          emailVerifiedAt: { $lt: retryDate }
        }
      ]
    }).limit(CONFIG.BATCH_SIZE).toArray();

    console.log(`🚀 Email verification started | Candidates: ${toVerify.length}`);

    if (toVerify.length === 0) {
      console.log("✨ No emails need verification");
      return;
    }

    // Group by domain for efficient processing
    const byDomain = {};
    for (const lead of toVerify) {
      const domain = lead.email.split("@")[1]?.toLowerCase();
      if (!domain) continue;
      
      if (!byDomain[domain]) {
        byDomain[domain] = [];
      }
      byDomain[domain].push(lead);
    }

    console.log(`📊 Processing ${Object.keys(byDomain).length} unique domains`);

    const results = {
      verified: 0,
      invalid: 0,
      skipped: 0,
      mxFailed: 0,
      smtpFailed: 0
    };

    // Process domains
    for (const [domain, domainLeads] of Object.entries(byDomain)) {
      console.log(`\n🔍 Domain: ${domain} (${domainLeads.length} emails)`);

      // Step 1: Check MX records (FREE - DNS query)
      const mxResult = await checkMXRecords(domain);

      if (!mxResult.valid) {
        console.log(`  ❌ MX check failed: ${mxResult.reason}`);
        
        // Mark all emails for this domain as invalid
        for (const lead of domainLeads) {
          await updateVerificationStatus(leads, lead._id, {
            verified: false,
            reason: mxResult.reason,
            method: "mx_check",
            mxRecords: null
          });
          
          await logVerification(verifyLogs, runId, lead, {
            status: "invalid",
            reason: mxResult.reason,
            method: "mx_check"
          });
          
          results.mxFailed++;
        }
        continue;
      }

      console.log(`  ✓ MX valid: ${mxResult.mxHost}`);

      // Step 2: SMTP verification (if enabled and domain allows)
      let smtpChecksForDomain = 0;

      for (const lead of domainLeads) {
        // Skip SMTP check for blocklisted domains
        if (SMTP_BLOCKLIST.has(domain)) {
          // MX passed, mark as likely valid
          await updateVerificationStatus(leads, lead._id, {
            verified: true,
            reason: "mx_valid_smtp_skipped",
            method: "mx_only",
            mxRecords: mxResult.records,
            confidence: 0.7
          });
          
          await logVerification(verifyLogs, runId, lead, {
            status: "verified",
            reason: "mx_valid_smtp_skipped",
            method: "mx_only",
            confidence: 0.7
          });
          
          results.verified++;
          continue;
        }

        // Rate limit SMTP checks per domain
        if (CONFIG.ENABLE_SMTP_CHECK && smtpChecksForDomain < CONFIG.MAX_SMTP_CHECKS_PER_DOMAIN) {
          const smtpResult = await checkSMTP(lead.email, mxResult.mxHost);
          smtpChecksForDomain++;

          if (smtpResult.valid) {
            await updateVerificationStatus(leads, lead._id, {
              verified: true,
              reason: "smtp_verified",
              method: "smtp",
              mxRecords: mxResult.records,
              smtpResponse: smtpResult.response,
              confidence: 0.95
            });

            await logVerification(verifyLogs, runId, lead, {
              status: "verified",
              reason: "smtp_verified",
              method: "smtp",
              confidence: 0.95
            });

            results.verified++;
            console.log(`    ✓ ${lead.email} - SMTP verified`);

          } else if (smtpResult.definitelyInvalid) {
            await updateVerificationStatus(leads, lead._id, {
              verified: false,
              reason: smtpResult.reason,
              method: "smtp",
              mxRecords: mxResult.records,
              smtpResponse: smtpResult.response
            });

            await logVerification(verifyLogs, runId, lead, {
              status: "invalid",
              reason: smtpResult.reason,
              method: "smtp"
            });

            results.invalid++;
            console.log(`    ✗ ${lead.email} - ${smtpResult.reason}`);

          } else {
            // SMTP inconclusive, use MX result
            await updateVerificationStatus(leads, lead._id, {
              verified: true,
              reason: "mx_valid_smtp_inconclusive",
              method: "mx_fallback",
              mxRecords: mxResult.records,
              smtpResponse: smtpResult.response,
              confidence: 0.6
            });

            await logVerification(verifyLogs, runId, lead, {
              status: "verified",
              reason: "mx_valid_smtp_inconclusive",
              method: "mx_fallback",
              confidence: 0.6
            });

            results.verified++;
            console.log(`    ? ${lead.email} - SMTP inconclusive, MX valid`);
          }

        } else {
          // SMTP disabled or rate limited, use MX result
          await updateVerificationStatus(leads, lead._id, {
            verified: true,
            reason: "mx_valid",
            method: "mx_only",
            mxRecords: mxResult.records,
            confidence: 0.7
          });

          await logVerification(verifyLogs, runId, lead, {
            status: "verified",
            reason: "mx_valid",
            method: "mx_only",
            confidence: 0.7
          });

          results.verified++;
        }
      }
    }

    // Summary
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    
    console.log(`\n🎯 EMAIL VERIFICATION COMPLETE`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Verified: ${results.verified}`);
    console.log(`Invalid: ${results.invalid}`);
    console.log(`MX Failed: ${results.mxFailed}`);
    console.log(`Skipped: ${results.skipped}`);
    console.log(`Duration: ${duration}s`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  } catch (error) {
    console.error("❌ Email verification error:", error);
    throw error;
  } finally {
    await client.close();
    console.log("🔌 Disconnected from MongoDB");
  }
}

// ============================================================================
// MX RECORD CHECK (FREE - DNS Query)
// ============================================================================

async function checkMXRecords(domain) {
  try {
    // Check for disposable domains
    if (DISPOSABLE_DOMAINS.has(domain)) {
      return {
        valid: false,
        reason: "disposable_domain",
        records: null,
        mxHost: null
      };
    }

    // Query MX records
    const records = await dns.resolveMx(domain);

    if (!records || records.length === 0) {
      // Try A record as fallback (some domains use A record for mail)
      try {
        const aRecords = await dns.resolve4(domain);
        if (aRecords && aRecords.length > 0) {
          return {
            valid: true,
            reason: "a_record_fallback",
            records: [{ exchange: domain, priority: 10 }],
            mxHost: domain
          };
        }
      } catch (e) {
        // No A record either
      }

      return {
        valid: false,
        reason: "no_mx_records",
        records: null,
        mxHost: null
      };
    }

    // Sort by priority (lower = higher priority)
    records.sort((a, b) => a.priority - b.priority);
    const mxHost = records[0].exchange;

    return {
      valid: true,
      reason: "mx_found",
      records: records.map(r => ({ exchange: r.exchange, priority: r.priority })),
      mxHost
    };

  } catch (error) {
    const code = error.code || "";

    if (code === "ENOTFOUND" || code === "ENODATA") {
      return {
        valid: false,
        reason: "domain_not_found",
        records: null,
        mxHost: null
      };
    }

    if (code === "ETIMEOUT") {
      return {
        valid: false,
        reason: "dns_timeout",
        records: null,
        mxHost: null
      };
    }

    return {
      valid: false,
      reason: `dns_error_${code}`,
      records: null,
      mxHost: null
    };
  }
}

// ============================================================================
// SMTP CHECK (FREE - Direct connection)
// ============================================================================

async function checkSMTP(email, mxHost) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let response = "";
    let stage = "connect";

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({
        valid: false,
        definitelyInvalid: false,
        reason: "smtp_timeout",
        response
      });
    }, CONFIG.SMTP_TIMEOUT);

    socket.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        valid: false,
        definitelyInvalid: false,
        reason: `smtp_error_${err.code || "unknown"}`,
        response
      });
    });

    socket.on("data", (data) => {
      response += data.toString();
      const lines = response.split("\r\n");
      const lastLine = lines[lines.length - 2] || lines[lines.length - 1];
      const code = parseInt(lastLine.substring(0, 3));

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
              // Email accepted
              finish(true, false, "accepted");
            } else if (code === 550 || code === 551 || code === 552 || code === 553 || code === 554) {
              // Definitely invalid
              finish(false, true, `rejected_${code}`);
            } else if (code === 450 || code === 451 || code === 452) {
              // Temporary failure - inconclusive
              finish(false, false, `temp_failure_${code}`);
            } else {
              finish(false, false, `unknown_${code}`);
            }
            break;
        }
      } catch (e) {
        finish(false, false, "parse_error");
      }
    });

    socket.on("close", () => {
      clearTimeout(timeout);
    });

    function finish(valid, definitelyInvalid, reason) {
      clearTimeout(timeout);
      socket.write("QUIT\r\n");
      socket.destroy();
      resolve({ valid, definitelyInvalid, reason, response });
    }

    // Connect to MX server on port 25
    socket.connect(25, mxHost);
  });
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

async function updateVerificationStatus(leads, leadId, data) {
  await leads.updateOne(
    { _id: leadId },
    {
      $set: {
        emailVerified: data.verified,
        emailVerifiedAt: new Date(),
        emailVerificationMethod: data.method,
        emailVerificationReason: data.reason,
        emailVerificationConfidence: data.confidence || null,
        "verification.mxRecords": data.mxRecords || null,
        "verification.smtpResponse": data.smtpResponse?.substring(0, 500) || null
      }
    }
  );
}

async function logVerification(verifyLogs, runId, lead, data) {
  await verifyLogs.insertOne({
    runId,
    leadId: lead._id,
    email: lead.email,
    companyName: lead.companyName,
    status: data.status,
    reason: data.reason,
    method: data.method,
    confidence: data.confidence || null,
    verifiedAt: new Date()
  });
}

// ============================================================================
// VERIFICATION STATS ENDPOINT (add to your API)
// ============================================================================

function setupVerificationRoutes(app, db) {
  const leads = db.collection("leads");
  const verifyLogs = db.collection("email_verification_logs");

  // GET /api/email/verification-stats
  app.get("/api/email/verification-stats", async (req, res) => {
    try {
      const total = await leads.countDocuments({
        email: { $exists: true, $ne: null, $ne: "", $ne: "noemail@domain.com" }
      });

      const verified = await leads.countDocuments({ emailVerified: true });
      const invalid = await leads.countDocuments({ emailVerified: false });
      const unverified = total - verified - invalid;

      // Recent verification activity
      const recentLogs = await verifyLogs.aggregate([
        { $match: { verifiedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } },
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]).toArray();

      // Verification methods breakdown
      const methods = await leads.aggregate([
        { $match: { emailVerified: { $exists: true } } },
        { $group: { _id: "$emailVerificationMethod", count: { $sum: 1 } } }
      ]).toArray();

      return res.json({
        success: true,
        stats: {
          total,
          verified,
          invalid,
          unverified,
          verificationRate: ((verified / total) * 100).toFixed(1) + "%",
          last24Hours: recentLogs.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {}),
          byMethod: methods.reduce((acc, m) => ({ ...acc, [m._id || "unknown"]: m.count }), {})
        }
      });

    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log("✅ Verification stats routes registered");
}

// ============================================================================
// RUN
// ============================================================================

if (require.main === module) {
  verifyEmails()
    .then(() => {
      console.log("✨ Email verification completed successfully");
      process.exit(0);
    })
    .catch((error) => {
      console.error("💥 Email verification failed:", error);
      process.exit(1);
    });
}

module.exports = { verifyEmails, checkMXRecords, checkSMTP, setupVerificationRoutes };
