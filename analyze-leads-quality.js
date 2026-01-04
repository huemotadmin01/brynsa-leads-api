// ============================================================================
// analyze-leads-quality.js - Dry Run Data Quality Analysis
// ============================================================================
// 
// This script ANALYZES your leads data and shows what would be cleaned up.
// It does NOT delete anything - just reports on data quality issues.
//
// RUN: node analyze-leads-quality.js
// 
// After reviewing the output, you can run the actual cleanup script.
// ============================================================================

const { MongoClient } = require('mongodb');
require('dotenv').config();

const client = new MongoClient(process.env.MONGO_URL);

// ============================================================================
// VALIDATION RULES (same as your validation.js)
// ============================================================================

// Placeholder company names that indicate bad data
const PLACEHOLDER_COMPANIES = new Set([
  // Confidential/Private
  "confidential", "private", "undisclosed", "not disclosed", "withheld", "hidden",
  
  // Self-employed variations
  "self-employed", "self employed", "selfemployed", "self",
  
  // Freelance variations
  "freelance", "freelancer", "freelancing", "free lance", "free-lance",
  
  // Independent
  "independent", "independent consultant", "independent contractor", "contractor",
  
  // Consultant
  "consultant", "consulting",
  
  // Generic placeholders
  "n/a", "na", "none", "null", "undefined", "unknown", "not available", 
  "not applicable", "-", "--", "---", ".", "..", "...",
  
  // Multiple/Various
  "various", "multiple", "several", "different",
  
  // Student/Education (may want to keep these - configurable)
  // "student", "university", "college", "school",
  
  // Unemployed/Seeking
  "unemployed", "seeking opportunities", "looking for opportunities", 
  "open to work", "available",
  
  // Personal
  "personal", "myself", "me", "my company", "own business",
  
  // Test/Demo
  "test", "demo", "sample", "example", "dummy", "fake"
]);

// Invalid name patterns
const INVALID_NAME_PATTERNS = [
  /^test$/i,
  /^demo$/i,
  /^sample$/i,
  /^dummy$/i,
  /^fake$/i,
  /^n\/a$/i,
  /^na$/i,
  /^none$/i,
  /^null$/i,
  /^undefined$/i,
  /^unknown$/i,
  /^xxx+$/i,
  /^aaa+$/i,
  /^asdf/i,
  /^qwerty/i,
  /^user\d*$/i,
  /^test\d*$/i,
  /^name$/i,
  /^your name$/i,
  /^first\s*last$/i,
  /^linkedin\s*(user|member)$/i,
];

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

function isBlankOrEmpty(value) {
  if (!value) return true;
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return trimmed.length === 0;
}

function hasDigits(name) {
  if (!name || typeof name !== 'string') return false;
  return /\d/.test(name);
}

function isPlaceholderCompany(companyName) {
  if (!companyName || typeof companyName !== 'string') return false;
  
  const normalized = companyName.toLowerCase().trim()
    .replace(/[^a-z0-9\s\-\/]/g, "");
  
  if (PLACEHOLDER_COMPANIES.has(normalized)) return true;
  
  const noSpaces = normalized.replace(/[\s\-\/]/g, "");
  if (PLACEHOLDER_COMPANIES.has(noSpaces)) return true;
  
  // Check for very short company names
  if (normalized.length < 2) return true;
  
  return false;
}

function isInvalidName(name) {
  if (!name || typeof name !== 'string') return false;
  
  const trimmed = name.trim();
  
  // Too short
  if (trimmed.length < 2) return true;
  
  // Matches invalid patterns
  for (const pattern of INVALID_NAME_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  
  return false;
}

function categorizeIssue(lead) {
  const issues = [];
  
  // Check name
  if (isBlankOrEmpty(lead.name)) {
    issues.push('blank_name');
  } else if (isInvalidName(lead.name)) {
    issues.push('invalid_name');
  } else if (hasDigits(lead.name)) {
    issues.push('name_with_digits');
  }
  
  // Check company name (check both fields)
  const companyName = lead.companyName || lead.company;
  if (isBlankOrEmpty(companyName)) {
    issues.push('blank_company');
  } else if (isPlaceholderCompany(companyName)) {
    issues.push('placeholder_company');
  }
  
  return issues;
}

// ============================================================================
// MAIN ANALYSIS FUNCTION
// ============================================================================

async function analyzeLeadsQuality() {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  LEADS DATA QUALITY ANALYSIS (DRY RUN)`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`${'='.repeat(70)}\n`);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db('brynsaleads');
    const leads = db.collection('leads');

    const totalLeads = await leads.countDocuments();
    console.log(`📊 Total leads in database: ${totalLeads.toLocaleString()}\n`);

    // ========================================================================
    // CATEGORY COUNTERS
    // ========================================================================
    const issues = {
      blank_name: { count: 0, samples: [] },
      invalid_name: { count: 0, samples: [] },
      name_with_digits: { count: 0, samples: [] },
      blank_company: { count: 0, samples: [] },
      placeholder_company: { count: 0, samples: [] },
    };

    const multipleIssues = { count: 0, samples: [] };
    const cleanRecords = { count: 0 };
    const uniqueBadLeadIds = new Set();

    // ========================================================================
    // SCAN ALL LEADS
    // ========================================================================
    console.log('🔍 Scanning all leads...\n');
    
    const cursor = leads.find({});
    let processed = 0;

    while (await cursor.hasNext()) {
      const lead = await cursor.next();
      processed++;

      // Progress indicator
      if (processed % 5000 === 0) {
        console.log(`   Processed ${processed.toLocaleString()} / ${totalLeads.toLocaleString()}...`);
      }

      const leadIssues = categorizeIssue(lead);

      if (leadIssues.length === 0) {
        cleanRecords.count++;
      } else {
        uniqueBadLeadIds.add(lead._id.toString());

        if (leadIssues.length > 1) {
          multipleIssues.count++;
          if (multipleIssues.samples.length < 5) {
            multipleIssues.samples.push({
              _id: lead._id,
              name: lead.name,
              companyName: lead.companyName || lead.company,
              email: lead.email,
              issues: leadIssues
            });
          }
        }

        for (const issue of leadIssues) {
          issues[issue].count++;
          if (issues[issue].samples.length < 5) {
            issues[issue].samples.push({
              _id: lead._id,
              name: lead.name,
              companyName: lead.companyName || lead.company,
              email: lead.email,
              linkedinUrl: lead.linkedinUrl
            });
          }
        }
      }
    }

    // ========================================================================
    // REPORT RESULTS
    // ========================================================================
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  ANALYSIS RESULTS`);
    console.log(`${'='.repeat(70)}\n`);

    console.log(`📊 SUMMARY`);
    console.log(`${'─'.repeat(50)}`);
    console.log(`   Total leads scanned:     ${totalLeads.toLocaleString()}`);
    console.log(`   ✅ Clean records:        ${cleanRecords.count.toLocaleString()} (${(cleanRecords.count / totalLeads * 100).toFixed(1)}%)`);
    console.log(`   ❌ Records with issues:  ${uniqueBadLeadIds.size.toLocaleString()} (${(uniqueBadLeadIds.size / totalLeads * 100).toFixed(1)}%)`);
    console.log(`   ⚠️  Multiple issues:     ${multipleIssues.count.toLocaleString()}`);
    console.log();

    // ========================================================================
    // DETAILED BREAKDOWN BY ISSUE TYPE
    // ========================================================================
    console.log(`📋 ISSUES BREAKDOWN`);
    console.log(`${'─'.repeat(50)}`);
    
    const issueLabels = {
      blank_name: '❌ Blank/Empty Names',
      invalid_name: '❌ Invalid Names (test, demo, etc.)',
      name_with_digits: '⚠️  Names with Digits',
      blank_company: '❌ Blank/Empty Company Names',
      placeholder_company: '⚠️  Placeholder Companies'
    };

    for (const [key, label] of Object.entries(issueLabels)) {
      const data = issues[key];
      const pct = (data.count / totalLeads * 100).toFixed(2);
      console.log(`\n   ${label}`);
      console.log(`   Count: ${data.count.toLocaleString()} (${pct}%)`);
      
      if (data.samples.length > 0) {
        console.log(`   Samples:`);
        for (const sample of data.samples.slice(0, 3)) {
          console.log(`      - Name: "${sample.name || '(empty)'}" | Company: "${sample.companyName || '(empty)'}" | Email: ${sample.email || 'none'}`);
        }
      }
    }

    // ========================================================================
    // RECORDS WITH MULTIPLE ISSUES
    // ========================================================================
    if (multipleIssues.count > 0) {
      console.log(`\n\n📋 RECORDS WITH MULTIPLE ISSUES`);
      console.log(`${'─'.repeat(50)}`);
      console.log(`   Count: ${multipleIssues.count.toLocaleString()}`);
      console.log(`   Samples:`);
      for (const sample of multipleIssues.samples) {
        console.log(`      - Name: "${sample.name || '(empty)'}" | Company: "${sample.companyName || '(empty)'}"`);
        console.log(`        Issues: ${sample.issues.join(', ')}`);
      }
    }

    // ========================================================================
    // RECOMMENDATIONS
    // ========================================================================
    console.log(`\n\n${'='.repeat(70)}`);
    console.log(`  RECOMMENDATIONS`);
    console.log(`${'='.repeat(70)}\n`);

    // Categorize severity
    const criticalIssues = issues.blank_name.count + issues.invalid_name.count + issues.blank_company.count;
    const warningIssues = issues.name_with_digits.count + issues.placeholder_company.count;

    console.log(`🔴 CRITICAL (should delete):`);
    console.log(`   - Blank names: ${issues.blank_name.count.toLocaleString()}`);
    console.log(`   - Invalid names: ${issues.invalid_name.count.toLocaleString()}`);
    console.log(`   - Blank company: ${issues.blank_company.count.toLocaleString()}`);
    console.log(`   Subtotal: ${criticalIssues.toLocaleString()} records\n`);

    console.log(`🟡 WARNING (review before deleting):`);
    console.log(`   - Names with digits: ${issues.name_with_digits.count.toLocaleString()}`);
    console.log(`   - Placeholder companies: ${issues.placeholder_company.count.toLocaleString()}`);
    console.log(`   Subtotal: ${warningIssues.toLocaleString()} records\n`);

    console.log(`📝 SUGGESTED ACTIONS:`);
    console.log(`   1. Run cleanup script with --critical-only to delete ${criticalIssues.toLocaleString()} records`);
    console.log(`   2. Review "names with digits" - some may be valid (e.g., "John Smith III")`);
    console.log(`   3. Review "placeholder companies" - decide if you want to keep freelancers/consultants`);
    console.log(`   4. Run full cleanup after review to delete remaining ${uniqueBadLeadIds.size.toLocaleString()} records\n`);

    // ========================================================================
    // EXPORT BAD IDS FOR CLEANUP
    // ========================================================================
    console.log(`\n${'='.repeat(70)}`);
    console.log(`  NEXT STEPS`);
    console.log(`${'='.repeat(70)}\n`);

    console.log(`To proceed with cleanup, run:`);
    console.log(`   node cleanup-leads.js --dry-run        # Preview what will be deleted`);
    console.log(`   node cleanup-leads.js --critical-only  # Delete only critical issues`);
    console.log(`   node cleanup-leads.js --all            # Delete all bad records`);
    console.log(`   node cleanup-leads.js --backup         # Backup bad records before deleting\n`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`⏱️  Analysis completed in ${duration}s\n`);

    // Return stats for programmatic use
    return {
      total: totalLeads,
      clean: cleanRecords.count,
      bad: uniqueBadLeadIds.size,
      issues: {
        blank_name: issues.blank_name.count,
        invalid_name: issues.invalid_name.count,
        name_with_digits: issues.name_with_digits.count,
        blank_company: issues.blank_company.count,
        placeholder_company: issues.placeholder_company.count
      },
      critical: criticalIssues,
      warnings: warningIssues
    };

  } catch (error) {
    console.error('❌ Analysis error:', error);
    throw error;
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB\n');
  }
}

// ============================================================================
// RUN
// ============================================================================

if (require.main === module) {
  analyzeLeadsQuality()
    .then((stats) => {
      console.log('✨ Analysis complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Analysis failed:', error);
      process.exit(1);
    });
}

module.exports = { analyzeLeadsQuality, categorizeIssue, isPlaceholderCompany, hasDigits, isInvalidName };