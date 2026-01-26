/**
 * Migration Script: Fix Orphaned Leads by sourcedBy field
 *
 * This script finds orphaned leads with sourcedBy containing firstname lastname
 * and sets their userEmail/visitorEmail based on the pattern firstname.lastname@huemot.com
 *
 * NOTE: Does NOT check if user exists in portal_users - just sets the email fields
 *
 * Run with: MONGODB_URI=$MONGO_URL node scripts/fix-orphaned-by-sourcedby.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

async function fixOrphanedBySourcedBy() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI environment variable not set');
    process.exit(1);
  }

  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db('brynsaleads');
    const leadsCollection = db.collection('leads');

    // Find all orphaned leads with sourcedBy field
    const orphanedLeads = await leadsCollection.find({
      $and: [
        { $or: [{ userId: { $exists: false } }, { userId: null }] },
        { $or: [{ visitorId: { $exists: false } }, { visitorId: null }] },
        { $or: [{ userEmail: { $exists: false } }, { userEmail: null }, { userEmail: '' }] },
        { sourcedBy: { $exists: true, $ne: null, $ne: '' } }
      ]
    }).toArray();

    console.log(`\n📊 Found ${orphanedLeads.length} orphaned leads with sourcedBy field\n`);

    if (orphanedLeads.length === 0) {
      console.log('✅ No orphaned leads with sourcedBy to fix!');
      return;
    }

    let fixed = 0;
    let skipped = 0;
    const skippedNames = [];
    const fixedByUser = {};

    for (const lead of orphanedLeads) {
      const sourcedBy = lead.sourcedBy.trim();

      // Check if sourcedBy has exactly two parts (firstname lastname)
      const nameParts = sourcedBy.split(/\s+/);

      if (nameParts.length !== 2) {
        // Skip names that don't have exactly firstname and lastname
        skipped++;
        if (!skippedNames.includes(sourcedBy)) {
          skippedNames.push(sourcedBy);
        }
        continue;
      }

      const [firstName, lastName] = nameParts;

      // Generate email from name pattern
      const generatedEmail = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@huemot.com`;

      // Update the lead with userEmail and visitorEmail only (no userId/visitorId since user may not exist)
      await leadsCollection.updateOne(
        { _id: lead._id },
        {
          $set: {
            userEmail: generatedEmail,
            visitorEmail: generatedEmail,
            updatedAt: new Date()
          }
        }
      );

      fixed++;
      fixedByUser[generatedEmail] = (fixedByUser[generatedEmail] || 0) + 1;

      // Log progress every 500 leads
      if (fixed % 500 === 0) {
        console.log(`✅ Fixed ${fixed} leads so far...`);
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 Migration Summary:');
    console.log('='.repeat(50));
    console.log(`   Total orphaned with sourcedBy: ${orphanedLeads.length}`);
    console.log(`   Fixed: ${fixed}`);
    console.log(`   Skipped (not firstname lastname): ${skipped}`);

    if (Object.keys(fixedByUser).length > 0) {
      console.log('\n📧 Fixed leads by user email:');
      for (const [email, count] of Object.entries(fixedByUser)) {
        console.log(`   - ${email}: ${count} leads`);
      }
    }

    if (skippedNames.length > 0) {
      console.log('\n⏭️  Skipped sourcedBy values (not firstname lastname format):');
      skippedNames.forEach(name => {
        console.log(`   - "${name}"`);
      });
    }

    console.log('\n✅ Migration complete!');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.close();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run the migration
fixOrphanedBySourcedBy();
