// ============================================================================
// migrate-add-userid.js - Add userId to Existing Leads
// ============================================================================
// 
// This script adds userId to existing leads that don't have it,
// enabling proper multi-user data isolation.
//
// RUN: node migrate-add-userid.js
// DRY RUN: DRY_RUN=true node migrate-add-userid.js
// ============================================================================

const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const client = new MongoClient(process.env.MONGO_URL);
const DRY_RUN = process.env.DRY_RUN === 'true';

async function migrate() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ADD userId TO EXISTING LEADS ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(60)}\n`);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db('brynsaleads');
    const leads = db.collection('leads');
    const users = db.collection('portal_users');
    const lists = db.collection('portal_lists');

    // ========================================================================
    // PHASE 1: Analyze Current State
    // ========================================================================
    console.log('📊 PHASE 1: Analyzing current state...\n');

    const totalLeads = await leads.countDocuments();
    const leadsWithUserId = await leads.countDocuments({ userId: { $exists: true, $ne: null } });
    const leadsWithoutUserId = totalLeads - leadsWithUserId;
    const totalUsers = await users.countDocuments();

    console.log(`   Total leads: ${totalLeads}`);
    console.log(`   Leads with userId: ${leadsWithUserId}`);
    console.log(`   Leads WITHOUT userId: ${leadsWithoutUserId}`);
    console.log(`   Total portal users: ${totalUsers}`);

    if (leadsWithoutUserId === 0) {
      console.log('\n✨ All leads already have userId! Nothing to migrate.');
      return;
    }

    // ========================================================================
    // PHASE 2: Find Leads to Migrate
    // ========================================================================
    console.log('\n📊 PHASE 2: Finding leads to migrate...\n');

    // Group leads by potential user identifiers
    const leadsToMigrate = await leads.find({
      userId: { $exists: false },
      $or: [
        { visitorEmail: { $exists: true, $ne: null } },
        { visitorId: { $exists: true, $ne: null } },
        { sourcedBy: { $exists: true, $ne: null } }
      ]
    }).toArray();

    console.log(`   Found ${leadsToMigrate.length} leads with potential user identifiers`);

    // Group by identifier
    const byVisitorEmail = {};
    const byVisitorId = {};
    const bySourcedBy = {};

    for (const lead of leadsToMigrate) {
      if (lead.visitorEmail) {
        if (!byVisitorEmail[lead.visitorEmail]) byVisitorEmail[lead.visitorEmail] = [];
        byVisitorEmail[lead.visitorEmail].push(lead._id);
      }
      if (lead.visitorId) {
        if (!byVisitorId[lead.visitorId]) byVisitorId[lead.visitorId] = [];
        byVisitorId[lead.visitorId].push(lead._id);
      }
      if (lead.sourcedBy) {
        if (!bySourcedBy[lead.sourcedBy]) bySourcedBy[lead.sourcedBy] = [];
        bySourcedBy[lead.sourcedBy].push(lead._id);
      }
    }

    console.log(`   Unique visitorEmails: ${Object.keys(byVisitorEmail).length}`);
    console.log(`   Unique visitorIds: ${Object.keys(byVisitorId).length}`);
    console.log(`   Unique sourcedBy: ${Object.keys(bySourcedBy).length}`);

    // ========================================================================
    // PHASE 3: Match with Users and Migrate
    // ========================================================================
    console.log('\n📊 PHASE 3: Matching with users and migrating...\n');

    const stats = {
      migrated: 0,
      matchedByEmail: 0,
      matchedByVisitorId: 0,
      matchedBySourcedBy: 0,
      noMatch: 0,
      orphaned: []
    };

    // Match by visitorEmail (most reliable)
    for (const [email, leadIds] of Object.entries(byVisitorEmail)) {
      const user = await users.findOne({ email: email.toLowerCase() });
      
      if (user) {
        if (!DRY_RUN) {
          await leads.updateMany(
            { _id: { $in: leadIds } },
            { 
              $set: { 
                userId: user._id.toString(),
                userEmail: user.email,
                migratedAt: new Date()
              } 
            }
          );
        }
        stats.migrated += leadIds.length;
        stats.matchedByEmail += leadIds.length;
        console.log(`   ✅ Matched ${leadIds.length} leads to user ${email}`);
      } else {
        stats.orphaned.push({ email, count: leadIds.length });
      }
    }

    // Match by visitorId (might be user._id string)
    for (const [visitorId, leadIds] of Object.entries(byVisitorId)) {
      // Skip if already matched by email
      const sampleLead = await leads.findOne({ _id: leadIds[0] });
      if (sampleLead?.userId) continue;

      let user = null;

      // Try as ObjectId
      try {
        user = await users.findOne({ _id: new ObjectId(visitorId) });
      } catch (e) {
        // Not a valid ObjectId, try as email
        user = await users.findOne({ email: visitorId.toLowerCase() });
      }

      if (user) {
        if (!DRY_RUN) {
          await leads.updateMany(
            { _id: { $in: leadIds }, userId: { $exists: false } },
            {
              $set: {
                userId: user._id.toString(),
                userEmail: user.email,
                migratedAt: new Date()
              }
            }
          );
        }
        stats.migrated += leadIds.length;
        stats.matchedByVisitorId += leadIds.length;
        console.log(`   ✅ Matched ${leadIds.length} leads by visitorId to ${user.email}`);
      }
    }

    // Match by sourcedBy (name-based, less reliable)
    for (const [sourcedBy, leadIds] of Object.entries(bySourcedBy)) {
      // Skip if already matched
      const sampleLead = await leads.findOne({ _id: leadIds[0] });
      if (sampleLead?.userId) continue;

      // Try to find user by name (case-insensitive)
      const user = await users.findOne({ 
        name: { $regex: new RegExp(`^${escapeRegex(sourcedBy)}$`, 'i') }
      });

      if (user) {
        if (!DRY_RUN) {
          await leads.updateMany(
            { _id: { $in: leadIds }, userId: { $exists: false } },
            {
              $set: {
                userId: user._id.toString(),
                userEmail: user.email,
                migratedAt: new Date()
              }
            }
          );
        }
        stats.migrated += leadIds.length;
        stats.matchedBySourcedBy += leadIds.length;
        console.log(`   ✅ Matched ${leadIds.length} leads by sourcedBy "${sourcedBy}" to ${user.email}`);
      }
    }

    // Count orphaned (no match found)
    const stillOrphaned = await leads.countDocuments({ userId: { $exists: false } });
    stats.noMatch = stillOrphaned;

    // ========================================================================
    // PHASE 4: Handle Orphaned Leads
    // ========================================================================
    console.log('\n📊 PHASE 4: Handling orphaned leads...\n');

    if (stillOrphaned > 0) {
      console.log(`   ⚠️  ${stillOrphaned} leads could not be matched to any user`);
      console.log('   Options:');
      console.log('   1. Create a "legacy" user to own these leads');
      console.log('   2. Delete orphaned leads');
      console.log('   3. Keep them as-is (won\'t appear in portal)');

      // Option: Create system user for orphaned leads
      // Uncomment to enable:
      /*
      if (!DRY_RUN) {
        const systemUser = await users.findOne({ email: 'system@brynsa.local' });
        let systemUserId;
        
        if (!systemUser) {
          const result = await users.insertOne({
            email: 'system@brynsa.local',
            name: 'Legacy System',
            plan: 'free',
            createdAt: new Date(),
            isSystemUser: true
          });
          systemUserId = result.insertedId.toString();
        } else {
          systemUserId = systemUser._id.toString();
        }

        await leads.updateMany(
          { userId: { $exists: false } },
          { 
            $set: { 
              userId: systemUserId,
              userEmail: 'system@brynsa.local',
              isLegacyLead: true,
              migratedAt: new Date()
            }
          }
        );
        console.log(`   ✅ Assigned ${stillOrphaned} orphaned leads to system user`);
      }
      */
    }

    // ========================================================================
    // PHASE 5: Migrate Lists
    // ========================================================================
    console.log('\n📊 PHASE 5: Ensuring lists have userId...\n');

    const listsWithoutUserId = await lists.countDocuments({ userId: { $exists: false } });
    console.log(`   Lists without userId: ${listsWithoutUserId}`);

    if (listsWithoutUserId > 0 && !DRY_RUN) {
      // Lists are newer, they should all have userId
      // If not, we need to delete them (they're orphaned)
      const deleted = await lists.deleteMany({ userId: { $exists: false } });
      console.log(`   ✅ Deleted ${deleted.deletedCount} orphaned lists`);
    }

    // ========================================================================
    // Summary
    // ========================================================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('  MIGRATION SUMMARY');
    console.log(`${'='.repeat(60)}`);
    console.log(`\n   Total leads migrated: ${stats.migrated}`);
    console.log(`   - Matched by email: ${stats.matchedByEmail}`);
    console.log(`   - Matched by visitorId: ${stats.matchedByVisitorId}`);
    console.log(`   - Matched by sourcedBy: ${stats.matchedBySourcedBy}`);
    console.log(`   - Orphaned (no match): ${stats.noMatch}`);

    if (stats.orphaned.length > 0 && stats.orphaned.length <= 10) {
      console.log('\n   Orphaned emails (no user found):');
      stats.orphaned.forEach(o => console.log(`   - ${o.email}: ${o.count} leads`));
    }

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

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Run
migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));