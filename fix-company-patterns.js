// ============================================================================
// fix-company-patterns.js - MongoDB Cleanup Script
// ============================================================================
// 
// This script identifies and fixes incorrect company data in your database:
// 1. Leads with previous employer instead of current company
// 2. Incorrect email patterns derived from wrong company data
// 3. Orphaned/invalid company_patterns entries
//
// RUN: node fix-company-patterns.js
// DRY RUN (no changes): DRY_RUN=true node fix-company-patterns.js
// ============================================================================

const { MongoClient, ObjectId } = require("mongodb");
require('dotenv').config();

const client = new MongoClient(process.env.MONGO_URL);
const DRY_RUN = process.env.DRY_RUN === 'true';

// Known incorrect patterns to look for
const SUSPICIOUS_PATTERNS = [
  // Generic/placeholder companies
  /^(company|unknown|n\/a|na|none|null|undefined|test|demo|sample)$/i,
  // Clearly wrong - previous job indicators
  /^(former|ex-|previously|past|left|resigned)/i,
  // Too short (likely extraction errors)
  /^.{1,2}$/,
  // All numbers
  /^\d+$/,
  // Email-like strings stored as company
  /@/,
  // URL fragments
  /^(http|www\.|\.com|\.in|\.io)/i,
];

// Common patterns that indicate extraction grabbed wrong data
const PREVIOUS_EMPLOYER_INDICATORS = [
  'former', 'ex-', 'previously at', 'left', 'resigned', 
  'past experience', 'worked at', 'was at'
];

async function analyzeAndFix() {
  const start = Date.now();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  MONGODB COMPANY DATA CLEANUP ${DRY_RUN ? '(DRY RUN - NO CHANGES)' : ''}`);
  console.log(`${'='.repeat(70)}\n`);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const patterns = db.collection("company_patterns");
    const audit = db.collection("enriched_audit");

    const stats = {
      totalLeads: 0,
      suspiciousCompanies: [],
      fixedLeads: 0,
      deletedPatterns: 0,
      deletedAudits: 0,
      emailsCleared: 0
    };

    // ========================================================================
    // PHASE 1: Analyze Current State
    // ========================================================================
    console.log('📊 PHASE 1: Analyzing current database state...\n');

    stats.totalLeads = await leads.countDocuments();
    const totalPatterns = await patterns.countDocuments();
    const totalAudits = await audit.countDocuments();

    console.log(`   Total leads: ${stats.totalLeads}`);
    console.log(`   Total company patterns: ${totalPatterns}`);
    console.log(`   Total enrichment audits: ${totalAudits}`);

    // ========================================================================
    // PHASE 2: Find Suspicious Company Names
    // ========================================================================
    console.log('\n📊 PHASE 2: Finding suspicious company names...\n');

    // Get distinct company names
    const companyNames = await leads.distinct('companyName');
    console.log(`   Found ${companyNames.length} unique company names\n`);

    const suspiciousCompanies = new Set();

    for (const company of companyNames) {
      if (!company) {
        suspiciousCompanies.add('[NULL/EMPTY]');
        continue;
      }

      // Check against suspicious patterns
      for (const pattern of SUSPICIOUS_PATTERNS) {
        if (pattern.test(company)) {
          suspiciousCompanies.add(company);
          break;
        }
      }

      // Check for previous employer indicators
      const lowerCompany = company.toLowerCase();
      for (const indicator of PREVIOUS_EMPLOYER_INDICATORS) {
        if (lowerCompany.includes(indicator)) {
          suspiciousCompanies.add(company);
          break;
        }
      }
    }

    stats.suspiciousCompanies = Array.from(suspiciousCompanies);
    console.log(`   Found ${stats.suspiciousCompanies.length} suspicious company names:`);
    stats.suspiciousCompanies.slice(0, 20).forEach(c => console.log(`      - "${c}"`));
    if (stats.suspiciousCompanies.length > 20) {
      console.log(`      ... and ${stats.suspiciousCompanies.length - 20} more`);
    }

    // ========================================================================
    // PHASE 3: Find Email-Company Mismatches
    // ========================================================================
    console.log('\n📊 PHASE 3: Finding email-company mismatches...\n');

    // Find leads where email domain doesn't match company
    const emailMismatchPipeline = [
      {
        $match: {
          email: { $exists: true, $ne: null, $ne: '', $ne: 'noemail@domain.com' },
          companyName: { $exists: true, $ne: null, $ne: '' },
          emailEnriched: true // Only check enriched emails
        }
      },
      {
        $project: {
          name: 1,
          email: 1,
          companyName: 1,
          linkedinUrl: 1,
          emailDomain: { $arrayElemAt: [{ $split: ['$email', '@'] }, 1] }
        }
      },
      {
        $limit: 1000
      }
    ];

    const emailMismatches = await leads.aggregate(emailMismatchPipeline).toArray();
    
    const suspiciousMismatches = [];
    for (const lead of emailMismatches) {
      if (!lead.emailDomain || !lead.companyName) continue;
      
      // Extract company name parts for comparison
      const companyLower = lead.companyName.toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/(pvt|ltd|llc|inc|corp|limited|private|llp|technologies|technology|tech|solutions|consulting|services|india|global)/g, '');
      
      const domainLower = lead.emailDomain.toLowerCase()
        .replace(/\.(com|in|io|co|net|org|edu)$/g, '')
        .replace(/[^a-z0-9]/g, '');

      // Check if domain has any overlap with company name
      const hasOverlap = companyLower.includes(domainLower) || 
                         domainLower.includes(companyLower) ||
                         (companyLower.length > 3 && domainLower.includes(companyLower.substring(0, 4)));

      if (!hasOverlap && companyLower.length > 3 && domainLower.length > 3) {
        suspiciousMismatches.push({
          _id: lead._id,
          name: lead.name,
          company: lead.companyName,
          email: lead.email,
          domain: lead.emailDomain
        });
      }
    }

    console.log(`   Found ${suspiciousMismatches.length} potential email-company mismatches:`);
    suspiciousMismatches.slice(0, 10).forEach(m => {
      console.log(`      - ${m.name}: ${m.company} ↔ ${m.email}`);
    });
    if (suspiciousMismatches.length > 10) {
      console.log(`      ... and ${suspiciousMismatches.length - 10} more`);
    }

    // ========================================================================
    // PHASE 4: Find Invalid Patterns
    // ========================================================================
    console.log('\n📊 PHASE 4: Finding invalid company patterns...\n');

    const invalidPatterns = await patterns.find({
      $or: [
        { companyName: { $in: stats.suspiciousCompanies } },
        { domain: { $in: ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'] } },
        { confidence: { $lt: 0.5 } },
        { frequency: { $lt: 2 } }
      ]
    }).toArray();

    console.log(`   Found ${invalidPatterns.length} invalid/low-confidence patterns:`);
    invalidPatterns.slice(0, 10).forEach(p => {
      console.log(`      - ${p.companyName}: ${p.pattern}@${p.domain} (conf: ${p.confidence?.toFixed(2) || '?'})`);
    });

    // ========================================================================
    // PHASE 5: Apply Fixes (if not dry run)
    // ========================================================================
    console.log(`\n📊 PHASE 5: ${DRY_RUN ? 'Would apply' : 'Applying'} fixes...\n`);

    if (!DRY_RUN) {
      // 5a. Delete invalid patterns
      if (invalidPatterns.length > 0) {
        const patternIds = invalidPatterns.map(p => p._id);
        const deletePatterns = await patterns.deleteMany({ _id: { $in: patternIds } });
        stats.deletedPatterns = deletePatterns.deletedCount;
        console.log(`   ✅ Deleted ${stats.deletedPatterns} invalid patterns`);
      }

      // 5b. Clear enriched emails that are likely wrong (from mismatches)
      if (suspiciousMismatches.length > 0) {
        const mismatchIds = suspiciousMismatches.map(m => m._id);
        const clearEmails = await leads.updateMany(
          { _id: { $in: mismatchIds } },
          { 
            $set: { 
              email: 'noemail@domain.com',
              emailEnriched: false,
              emailCleared: true,
              emailClearedReason: 'company_mismatch',
              emailClearedAt: new Date()
            }
          }
        );
        stats.emailsCleared = clearEmails.modifiedCount;
        console.log(`   ✅ Cleared ${stats.emailsCleared} mismatched enriched emails`);
      }

      // 5c. Delete audit records for suspicious companies
      if (stats.suspiciousCompanies.length > 0) {
        const deleteAudits = await audit.deleteMany({
          companyName: { $in: stats.suspiciousCompanies }
        });
        stats.deletedAudits = deleteAudits.deletedCount;
        console.log(`   ✅ Deleted ${stats.deletedAudits} audit records for suspicious companies`);
      }

      // 5d. Mark leads with suspicious companies for review
      const markForReview = await leads.updateMany(
        { 
          companyName: { $in: stats.suspiciousCompanies },
          needsReview: { $ne: true }
        },
        {
          $set: {
            needsReview: true,
            reviewReason: 'suspicious_company',
            reviewFlaggedAt: new Date()
          }
        }
      );
      stats.fixedLeads = markForReview.modifiedCount;
      console.log(`   ✅ Marked ${stats.fixedLeads} leads for manual review`);
    } else {
      console.log('   ⏸️  DRY RUN - No changes made');
      console.log(`   Would delete ${invalidPatterns.length} patterns`);
      console.log(`   Would clear ${suspiciousMismatches.length} mismatched emails`);
      console.log(`   Would mark ${stats.suspiciousCompanies.length} leads for review`);
    }

    // ========================================================================
    // PHASE 6: Generate Report
    // ========================================================================
    console.log(`\n${'='.repeat(70)}`);
    console.log('  CLEANUP SUMMARY');
    console.log(`${'='.repeat(70)}`);
    console.log(`\n   Total leads analyzed: ${stats.totalLeads}`);
    console.log(`   Suspicious companies found: ${stats.suspiciousCompanies.length}`);
    console.log(`   Email-company mismatches: ${suspiciousMismatches.length}`);
    console.log(`   Invalid patterns: ${invalidPatterns.length}`);
    
    if (!DRY_RUN) {
      console.log(`\n   CHANGES MADE:`);
      console.log(`   - Patterns deleted: ${stats.deletedPatterns}`);
      console.log(`   - Emails cleared: ${stats.emailsCleared}`);
      console.log(`   - Audit records deleted: ${stats.deletedAudits}`);
      console.log(`   - Leads marked for review: ${stats.fixedLeads}`);
    }

    console.log(`\n   Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`);
    console.log(`${'='.repeat(70)}\n`);

    // Return stats for programmatic use
    return stats;

  } catch (error) {
    console.error('❌ Cleanup error:', error);
    throw error;
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB\n');
  }
}

// ============================================================================
// Additional Utility Functions
// ============================================================================

async function listSuspiciousLeads(limit = 50) {
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");

    const suspiciousLeads = await leads.find({
      $or: [
        { companyName: { $exists: false } },
        { companyName: null },
        { companyName: '' },
        { needsReview: true }
      ]
    }).limit(limit).toArray();

    console.log(`\nLeads needing review (${suspiciousLeads.length}):\n`);
    suspiciousLeads.forEach(lead => {
      console.log(`  ${lead.name} | ${lead.companyName || '[NO COMPANY]'} | ${lead.email || '[NO EMAIL]'}`);
      if (lead.linkedinUrl) console.log(`    LinkedIn: ${lead.linkedinUrl}`);
    });

  } finally {
    await client.close();
  }
}

async function rebuildPatternsFromVerifiedEmails() {
  console.log('\n🔄 Rebuilding patterns from verified emails only...\n');
  
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const patterns = db.collection("company_patterns");

    // Clear existing patterns
    await patterns.deleteMany({});
    console.log('   Cleared existing patterns');

    // Find leads with verified, non-enriched emails
    const verifiedLeads = await leads.aggregate([
      {
        $match: {
          email: { $exists: true, $ne: null, $ne: '', $ne: 'noemail@domain.com' },
          companyName: { $exists: true, $ne: null, $ne: '' },
          emailEnriched: { $ne: true },
          emailVerified: { $ne: false }
        }
      },
      {
        $group: {
          _id: '$companyName',
          leads: { $push: { name: '$name', email: '$email' } },
          count: { $sum: 1 }
        }
      },
      {
        $match: { count: { $gte: 2 } } // Only companies with 2+ verified emails
      }
    ]).toArray();

    console.log(`   Found ${verifiedLeads.length} companies with verified emails`);

    let patternsCreated = 0;
    for (const company of verifiedLeads) {
      const patternInfo = extractMostCommonPattern(company.leads);
      if (patternInfo) {
        await patterns.updateOne(
          { companyName: company._id },
          {
            $set: {
              companyName: company._id,
              normalizedName: normalizeCompanyName(company._id),
              pattern: patternInfo.pattern,
              domain: patternInfo.domain,
              confidence: patternInfo.confidence,
              frequency: company.count,
              source: 'verified_rebuild',
              updatedAt: new Date()
            },
            $setOnInsert: { createdAt: new Date() }
          },
          { upsert: true }
        );
        patternsCreated++;
      }
    }

    console.log(`   ✅ Created ${patternsCreated} verified patterns`);

  } finally {
    await client.close();
  }
}

// Helper functions
function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(pvt|ltd|llc|inc|corp|limited|private|llp)$/g, '')
    .trim();
}

function extractMostCommonPattern(leads) {
  const patternCounts = {};

  for (const lead of leads) {
    const pattern = extractPatternFromEmail(lead.email, lead.name);
    if (pattern) {
      const key = `${pattern.pattern}@${pattern.domain}`;
      if (!patternCounts[key]) {
        patternCounts[key] = { ...pattern, count: 0 };
      }
      patternCounts[key].count++;
    }
  }

  const sorted = Object.values(patternCounts).sort((a, b) => b.count - a.count);
  return sorted.length > 0 ? sorted[0] : null;
}

function extractPatternFromEmail(email, fullName) {
  if (!email || !fullName) return null;
  
  const match = email.toLowerCase().match(/^([^@]+)@([^@]+)$/);
  if (!match) return null;

  const [, local, domain] = match;
  const nameParts = splitName(fullName);
  if (!nameParts) return null;

  const { first, last } = nameParts;
  const stripped = local.replace(/[._-]/g, '');

  const patterns = [
    { name: 'first.last', template: `${first}.${last}`, confidence: 0.95 },
    { name: 'last.first', template: `${last}.${first}`, confidence: 0.95 },
    { name: 'first_last', template: `${first}_${last}`, confidence: 0.90 },
    { name: 'firstlast', template: `${first}${last}`, confidence: 0.85 },
    { name: 'f.last', template: `${first[0]}.${last}`, confidence: 0.80 },
    { name: 'flast', template: `${first[0]}${last}`, confidence: 0.70 }
  ];

  for (const p of patterns) {
    if (local === p.template || stripped === p.template.replace(/[._-]/g, '')) {
      return { pattern: p.name, domain, confidence: p.confidence };
    }
  }

  return null;
}

function splitName(fullName) {
  const parts = String(fullName || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

// ============================================================================
// RUN
// ============================================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--list')) {
    listSuspiciousLeads(parseInt(args[args.indexOf('--list') + 1]) || 50);
  } else if (args.includes('--rebuild')) {
    rebuildPatternsFromVerifiedEmails();
  } else {
    analyzeAndFix()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  }
}

module.exports = { analyzeAndFix, listSuspiciousLeads, rebuildPatternsFromVerifiedEmails };