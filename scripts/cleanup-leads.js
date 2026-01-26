/**
 * Cleanup Script: Remove orphaned, invalid, and duplicate leads
 *
 * This script performs three cleanup operations:
 * 1. Delete leads with no ownership data (no userId, visitorId, userEmail, visitorEmail)
 * 2. Delete leads without linkedinUrl
 * 3. Remove duplicate leads (same linkedinUrl + userEmail, keeping the oldest)
 *
 * Uses HARD DELETE (removes documents completely)
 *
 * Run with: MONGODB_URI=$MONGO_URL node scripts/cleanup-leads.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

async function cleanupLeads() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI environment variable not set');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB\n');

    const db = client.db('brynsaleads');
    const leadsCollection = db.collection('leads');

    let totalDeleted = 0;

    // ===== 1. Delete orphaned leads (no ownership data) =====
    console.log('🔍 Step 1: Finding orphaned leads (no ownership data)...');

    const orphanedResult = await leadsCollection.deleteMany({
      $and: [
        { $or: [{ userId: { $exists: false } }, { userId: null }] },
        { $or: [{ visitorId: { $exists: false } }, { visitorId: null }] },
        { $or: [{ userEmail: { $exists: false } }, { userEmail: null }, { userEmail: '' }] },
        { $or: [{ visitorEmail: { $exists: false } }, { visitorEmail: null }, { visitorEmail: '' }] }
      ],
      deleted: { $ne: true }
    });

    console.log(`   ✅ Deleted ${orphanedResult.deletedCount} orphaned leads\n`);
    totalDeleted += orphanedResult.deletedCount;

    // ===== 2. Delete leads without linkedinUrl =====
    console.log('🔍 Step 2: Finding leads without linkedinUrl...');

    const noLinkedinResult = await leadsCollection.deleteMany({
      $or: [
        { linkedinUrl: { $exists: false } },
        { linkedinUrl: null },
        { linkedinUrl: '' }
      ],
      deleted: { $ne: true }
    });

    console.log(`   ✅ Deleted ${noLinkedinResult.deletedCount} leads without linkedinUrl\n`);
    totalDeleted += noLinkedinResult.deletedCount;

    // ===== 3. Remove duplicate leads (same linkedinUrl + userEmail) =====
    console.log('🔍 Step 3: Finding duplicate leads (same linkedinUrl + userEmail)...');

    const duplicates = await leadsCollection.aggregate([
      {
        $match: {
          linkedinUrl: { $exists: true, $ne: null, $ne: '' },
          userEmail: { $exists: true, $ne: null, $ne: '' },
          deleted: { $ne: true }
        }
      },
      {
        $group: {
          _id: { linkedinUrl: '$linkedinUrl', userEmail: '$userEmail' },
          count: { $sum: 1 },
          ids: { $push: '$_id' },
          dates: { $push: '$createdAt' }
        }
      },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();

    let duplicatesDeleted = 0;

    for (const group of duplicates) {
      // Sort by createdAt to keep the oldest, delete the rest
      const idsWithDates = group.ids.map((id, i) => ({
        id,
        date: group.dates[i] || new Date(0)
      }));

      idsWithDates.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Keep the first (oldest), delete the rest
      const idsToDelete = idsWithDates.slice(1).map(item => item.id);

      if (idsToDelete.length > 0) {
        await leadsCollection.deleteMany({ _id: { $in: idsToDelete } });
        duplicatesDeleted += idsToDelete.length;
      }
    }

    console.log(`   ✅ Deleted ${duplicatesDeleted} duplicate leads (kept oldest copy)\n`);
    totalDeleted += duplicatesDeleted;

    // ===== Summary =====
    console.log('='.repeat(50));
    console.log('📊 Cleanup Summary:');
    console.log('='.repeat(50));
    console.log(`   Orphaned leads deleted: ${orphanedResult.deletedCount}`);
    console.log(`   Leads without linkedinUrl deleted: ${noLinkedinResult.deletedCount}`);
    console.log(`   Duplicate leads deleted: ${duplicatesDeleted}`);
    console.log(`   ─────────────────────────────`);
    console.log(`   Total deleted: ${totalDeleted}`);

    // Final count
    const remainingCount = await leadsCollection.countDocuments({ deleted: { $ne: true } });
    console.log(`\n📈 Remaining active leads: ${remainingCount}`);

    console.log('\n✅ Cleanup complete!');

  } catch (error) {
    console.error('❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run the cleanup
cleanupLeads();
