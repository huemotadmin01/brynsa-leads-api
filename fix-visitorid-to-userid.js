// ============================================================================
// fix-visitorid-to-userid.js - Fix leads with visitorId but no userId
// ============================================================================
// 
// This script:
// 1. Finds leads that have visitorId but no userId
// 2. Copies visitorId to userId field
// 3. Optionally removes duplicate leads
//
// RUN: node fix-visitorid-to-userid.js
// DRY RUN: DRY_RUN=true node fix-visitorid-to-userid.js
// ============================================================================

const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const client = new MongoClient(process.env.MONGO_URL);
const DRY_RUN = process.env.DRY_RUN === 'true';

async function fixVisitorIdToUserId() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  FIX visitorId → userId MIGRATION ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db('brynsaleads');
    const leads = db.collection('leads');

    // ========================================================================
    // PHASE 1: Analyze Current State
    // ========================================================================
    console.log('📊 PHASE 1: Analyzing current state...\n');

    const totalLeads = await leads.countDocuments();
    const leadsWithUserId = await leads.countDocuments({ userId: { $exists: true, $ne: null } });
    const leadsWithVisitorId = await leads.countDocuments({ visitorId: { $exists: true, $ne: null } });
    const leadsWithOnlyVisitorId = await leads.countDocuments({
      visitorId: { $exists: true, $ne: null },
      $or: [
        { userId: { $exists: false } },
        { userId: null }
      ]
    });

    console.log(`   Total leads: ${totalLeads}`);
    console.log(`   Leads with userId: ${leadsWithUserId}`);
    console.log(`   Leads with visitorId: ${leadsWithVisitorId}`);
    console.log(`   Leads with ONLY visitorId (need fix): ${leadsWithOnlyVisitorId}`);

    if (leadsWithOnlyVisitorId === 0) {
      console.log('\n✨ All leads already have userId! Nothing to fix.');
      return;
    }

    // ========================================================================
    // PHASE 2: Fix leads - copy visitorId to userId
    // ========================================================================
    console.log('\n📊 PHASE 2: Copying visitorId to userId...\n');

    const leadsToFix = await leads.find({
      visitorId: { $exists: true, $ne: null },
      $or: [
        { userId: { $exists: false } },
        { userId: null }
      ]
    }).toArray();

    let fixed = 0;
    for (const lead of leadsToFix) {
      if (!DRY_RUN) {
        await leads.updateOne(
          { _id: lead._id },
          {
            $set: {
              userId: lead.visitorId,
              userEmail: lead.visitorEmail || null,
              fixedAt: new Date()
            }
          }
        );
      }
      fixed++;
      console.log(`   ✅ Fixed: ${lead.name} (${lead.linkedinUrl?.split('/in/')[1]?.split('/')[0] || 'unknown'})`);
    }

    console.log(`\n   Fixed ${fixed} leads`);

    // ========================================================================
    // PHASE 3: Find and report duplicates
    // ========================================================================
    console.log('\n📊 PHASE 3: Finding duplicate leads...\n');

    const duplicates = await leads.aggregate([
      {
        $match: {
          linkedinUrl: { $exists: true, $ne: null, $ne: '' }
        }
      },
      {
        $group: {
          _id: { 
            linkedinUrl: '$linkedinUrl',
            userId: { $ifNull: ['$userId', '$visitorId'] }
          },
          count: { $sum: 1 },
          ids: { $push: '$_id' },
          names: { $push: '$name' },
          createdDates: { $push: '$createdAt' }
        }
      },
      {
        $match: { count: { $gt: 1 } }
      },
      {
        $sort: { count: -1 }
      }
    ]).toArray();

    console.log(`   Found ${duplicates.length} duplicate lead groups\n`);

    let duplicatesRemoved = 0;
    
    for (const dup of duplicates) {
      console.log(`   Duplicate: ${dup.names[0]} (${dup.count} copies)`);
      console.log(`   LinkedIn: ${dup._id.linkedinUrl}`);
      console.log(`   IDs: ${dup.ids.map(id => id.toString()).join(', ')}`);
      
      // Keep the oldest one (first created), delete the rest
      const sortedIds = dup.ids
        .map((id, i) => ({ id, date: dup.createdDates[i] }))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      
      const keepId = sortedIds[0].id;
      const deleteIds = sortedIds.slice(1).map(item => item.id);

      console.log(`   Keeping: ${keepId} (created ${sortedIds[0].date})`);
      console.log(`   Deleting: ${deleteIds.length} duplicates`);

      if (!DRY_RUN && deleteIds.length > 0) {
        const result = await leads.deleteMany({ _id: { $in: deleteIds } });
        duplicatesRemoved += result.deletedCount;
      } else if (DRY_RUN) {
        duplicatesRemoved += deleteIds.length;
      }
      
      console.log('');
    }

    // ========================================================================
    // Summary
    // ========================================================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('  MIGRATION SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`\n   Leads fixed (visitorId → userId): ${fixed}`);
    console.log(`   Duplicate groups found: ${duplicates.length}`);
    console.log(`   Duplicates removed: ${duplicatesRemoved}`);

    console.log(`\n${DRY_RUN ? '   ⏸️  DRY RUN - No changes made' : '   ✅ Migration complete!'}`);
    console.log(`${'='.repeat(60)}\n`);

  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB\n');
  }
}

// Run
fixVisitorIdToUserId()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));