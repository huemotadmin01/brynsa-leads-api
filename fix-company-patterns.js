// ============================================================================
// fix-company-patterns-v2.js - Fix Company Pattern Domain Mismatches
// ============================================================================
// 
// This script fixes the company_patterns collection by:
// 1. Finding patterns where domain doesn't match company name
// 2. Deleting patterns with low confidence OR domain mismatch
// 3. Rebuilding patterns from verified scraped emails only
//
// RUN: node fix-company-patterns-v2.js
// DRY RUN: DRY_RUN=true node fix-company-patterns-v2.js
// ============================================================================

const { MongoClient } = require("mongodb");
require('dotenv').config();

const client = new MongoClient(process.env.MONGO_URL);
const DRY_RUN = process.env.DRY_RUN === 'true';

// Public email domains that should never be in company_patterns
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'aol.com', 'icloud.com', 'mail.com', 'protonmail.com', 'zoho.com',
  'ymail.com', 'msn.com', 'rediffmail.com', 'inbox.com'
]);

// Known company -> domain mappings (add more as needed)
const KNOWN_COMPANY_DOMAINS = {
  'deel': ['deel.com', 'letsdeel.com'],
  'hofy': ['hofy.com', 'hofy.co'],
  'google': ['google.com'],
  'microsoft': ['microsoft.com'],
  'amazon': ['amazon.com'],
  'meta': ['meta.com', 'fb.com', 'facebook.com'],
  'apple': ['apple.com'],
  'netflix': ['netflix.com'],
  'uber': ['uber.com'],
  'airbnb': ['airbnb.com'],
  'stripe': ['stripe.com'],
  'slack': ['slack.com'],
  'zoom': ['zoom.us'],
  'salesforce': ['salesforce.com'],
  'hubspot': ['hubspot.com'],
  'atlassian': ['atlassian.com'],
  'shopify': ['shopify.com'],
  'twitter': ['twitter.com', 'x.com'],
  'linkedin': ['linkedin.com'],
  'adobe': ['adobe.com'],
  'oracle': ['oracle.com'],
  'ibm': ['ibm.com'],
  'intel': ['intel.com'],
  'nvidia': ['nvidia.com'],
  'tesla': ['tesla.com'],
  'spacex': ['spacex.com'],
};

async function fixCompanyPatterns() {
  const start = Date.now();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  COMPANY PATTERNS CLEANUP v2.0 ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(70)}\n`);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db("brynsaleads");
    const patterns = db.collection("company_patterns");
    const leads = db.collection("leads");

    const stats = {
      totalPatterns: 0,
      publicDomainPatterns: 0,
      domainMismatchPatterns: 0,
      lowConfidencePatterns: 0,
      deletedPatterns: 0,
      rebuiltPatterns: 0
    };

    // ========================================================================
    // PHASE 1: Analyze All Patterns
    // ========================================================================
    console.log('📊 PHASE 1: Analyzing all company patterns...\n');

    const allPatterns = await patterns.find({}).toArray();
    stats.totalPatterns = allPatterns.length;
    console.log(`   Total patterns: ${stats.totalPatterns}\n`);

    const patternsToDelete = [];
    const suspiciousPatterns = [];

    for (const pattern of allPatterns) {
      const companyName = pattern.companyName || '';
      const domain = pattern.domain || '';
      const confidence = pattern.confidence || 0;
      const normalizedCompany = normalizeForComparison(companyName);
      const normalizedDomain = domain.replace(/\.(com|co|io|in|net|org|ai|tech)$/i, '').toLowerCase();

      let deleteReason = null;

      // Check 1: Public email domain
      if (PUBLIC_DOMAINS.has(domain.toLowerCase())) {
        deleteReason = 'public_domain';
        stats.publicDomainPatterns++;
      }

      // Check 2: Known company with wrong domain
      if (!deleteReason) {
        const knownDomains = KNOWN_COMPANY_DOMAINS[normalizedCompany];
        if (knownDomains && !knownDomains.includes(domain.toLowerCase())) {
          deleteReason = `known_mismatch (expected: ${knownDomains.join(' or ')})`;
          stats.domainMismatchPatterns++;
        }
      }

      // Check 3: Domain doesn't contain any part of company name (and vice versa)
      if (!deleteReason && normalizedCompany.length >= 3 && normalizedDomain.length >= 3) {
        const hasOverlap = 
          normalizedCompany.includes(normalizedDomain) ||
          normalizedDomain.includes(normalizedCompany) ||
          normalizedDomain.includes(normalizedCompany.substring(0, Math.min(4, normalizedCompany.length))) ||
          normalizedCompany.includes(normalizedDomain.substring(0, Math.min(4, normalizedDomain.length)));

        if (!hasOverlap) {
          // Also check if domain is completely unrelated
          const similarity = calculateSimilarity(normalizedCompany, normalizedDomain);
          if (similarity < 0.3) {
            deleteReason = `domain_mismatch (${normalizedCompany} ↔ ${normalizedDomain}, similarity: ${(similarity * 100).toFixed(0)}%)`;
            stats.domainMismatchPatterns++;
          }
        }
      }

      // Check 4: Low confidence (below 0.7)
      if (!deleteReason && confidence < 0.7) {
        deleteReason = `low_confidence (${confidence.toFixed(2)})`;
        stats.lowConfidencePatterns++;
      }

      if (deleteReason) {
        patternsToDelete.push({
          _id: pattern._id,
          companyName: pattern.companyName,
          domain: pattern.domain,
          confidence: pattern.confidence,
          reason: deleteReason
        });
      } else {
        // Check for suspicious but not auto-delete
        if (confidence < 0.8) {
          suspiciousPatterns.push({
            companyName: pattern.companyName,
            domain: pattern.domain,
            confidence: pattern.confidence
          });
        }
      }
    }

    // ========================================================================
    // PHASE 2: Show Patterns to Delete
    // ========================================================================
    console.log('📊 PHASE 2: Patterns to delete...\n');
    console.log(`   Found ${patternsToDelete.length} patterns to delete:\n`);

    patternsToDelete.forEach((p, i) => {
      if (i < 30) {
        console.log(`   ${i + 1}. ${p.companyName} → ${p.domain}`);
        console.log(`      Reason: ${p.reason}`);
      }
    });
    if (patternsToDelete.length > 30) {
      console.log(`   ... and ${patternsToDelete.length - 30} more\n`);
    }

    // ========================================================================
    // PHASE 3: Delete Invalid Patterns
    // ========================================================================
    console.log('\n📊 PHASE 3: Deleting invalid patterns...\n');

    if (!DRY_RUN && patternsToDelete.length > 0) {
      const idsToDelete = patternsToDelete.map(p => p._id);
      const deleteResult = await patterns.deleteMany({ _id: { $in: idsToDelete } });
      stats.deletedPatterns = deleteResult.deletedCount;
      console.log(`   ✅ Deleted ${stats.deletedPatterns} invalid patterns`);
    } else if (DRY_RUN) {
      console.log(`   ⏸️  DRY RUN - Would delete ${patternsToDelete.length} patterns`);
    }

    // ========================================================================
    // PHASE 4: Rebuild Patterns from Scraped (Non-Enriched) Emails
    // ========================================================================
    console.log('\n📊 PHASE 4: Rebuilding patterns from scraped emails...\n');

    // Get companies that were deleted and need rebuilding
    const deletedCompanies = patternsToDelete.map(p => p.companyName);

    // Find leads with scraped emails (not enriched) for these companies
    const scrapedEmailLeads = await leads.aggregate([
      {
        $match: {
          companyName: { $in: deletedCompanies },
          email: { 
            $exists: true, 
            $ne: null, 
            $ne: '', 
            $ne: 'noemail@domain.com',
            $not: { $regex: /@(gmail|yahoo|hotmail|outlook|live|aol|icloud)\.com$/i }
          },
          // Only use emails that were scraped directly, not enriched
          $or: [
            { emailEnriched: { $ne: true } },
            { emailSource: 'scraped' }
          ]
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
        $match: { count: { $gte: 2 } } // Only rebuild if 2+ verified emails exist
      }
    ]).toArray();

    console.log(`   Found ${scrapedEmailLeads.length} companies with scraped emails to rebuild`);

    if (!DRY_RUN) {
      for (const company of scrapedEmailLeads) {
        const patternInfo = extractMostCommonPattern(company.leads);
        if (patternInfo && !PUBLIC_DOMAINS.has(patternInfo.domain)) {
          await patterns.updateOne(
            { companyName: company._id },
            {
              $set: {
                companyName: company._id,
                normalizedName: normalizeForComparison(company._id),
                pattern: patternInfo.pattern,
                domain: patternInfo.domain,
                confidence: patternInfo.confidence,
                frequency: company.count,
                source: 'scraped_rebuild_v2',
                updatedAt: new Date()
              },
              $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
          );
          stats.rebuiltPatterns++;
          console.log(`   ✅ Rebuilt: ${company._id} → ${patternInfo.pattern}@${patternInfo.domain}`);
        }
      }
    } else {
      console.log(`   ⏸️  DRY RUN - Would rebuild ${scrapedEmailLeads.length} patterns`);
    }

    // ========================================================================
    // PHASE 5: Summary
    // ========================================================================
    console.log(`\n${'='.repeat(70)}`);
    console.log('  CLEANUP SUMMARY');
    console.log(`${'='.repeat(70)}`);
    console.log(`\n   Total patterns analyzed: ${stats.totalPatterns}`);
    console.log(`   Public domain patterns: ${stats.publicDomainPatterns}`);
    console.log(`   Domain mismatch patterns: ${stats.domainMismatchPatterns}`);
    console.log(`   Low confidence patterns: ${stats.lowConfidencePatterns}`);
    console.log(`   ---`);
    console.log(`   Patterns deleted: ${DRY_RUN ? `(would be) ${patternsToDelete.length}` : stats.deletedPatterns}`);
    console.log(`   Patterns rebuilt: ${DRY_RUN ? `(would be) ${scrapedEmailLeads.length}` : stats.rebuiltPatterns}`);
    console.log(`\n   Duration: ${((Date.now() - start) / 1000).toFixed(1)}s`);

    // Show remaining suspicious patterns
    if (suspiciousPatterns.length > 0) {
      console.log(`\n   ⚠️  ${suspiciousPatterns.length} suspicious patterns remaining (review manually):`);
      suspiciousPatterns.slice(0, 10).forEach(p => {
        console.log(`      - ${p.companyName} → ${p.domain} (conf: ${p.confidence?.toFixed(2)})`);
      });
    }

    console.log(`\n${'='.repeat(70)}\n`);

    return stats;

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB\n');
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function normalizeForComparison(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(pvt|ltd|llc|inc|corp|limited|private|llp|technologies|technology|tech|solutions|consulting|services|india|global|software|systems|group|co)$/g, '')
    .trim();
}

function calculateSimilarity(str1, str2) {
  // Simple Jaccard-like similarity
  const set1 = new Set(str1.split(''));
  const set2 = new Set(str2.split(''));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return intersection.size / union.size;
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
    { name: 'flast', template: `${first[0]}${last}`, confidence: 0.75 },
    { name: 'first', template: first, confidence: 0.60 },
    { name: 'last', template: last, confidence: 0.55 }
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
  fixCompanyPatterns()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { fixCompanyPatterns };