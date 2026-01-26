/**
 * Migration Script: Fix Orphaned Leads
 *
 * This script finds all leads with missing userId/visitorId and fixes them
 * by looking up the user based on visitorEmail or userEmail.
 *
 * Run with: node scripts/fix-orphaned-leads.js
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;

async function fixOrphanedLeads() {
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
    const usersCollection = db.collection('portal_users');

    // Find all orphaned leads (missing userId or visitorId)
    const orphanedLeads = await leadsCollection.find({
      $or: [
        { userId: { $exists: false } },
        { userId: null },
        { userId: undefined },
        { visitorId: { $exists: false } },
        { visitorId: null }
      ]
    }).toArray();

    console.log(`\n📊 Found ${orphanedLeads.length} orphaned leads\n`);

    if (orphanedLeads.length === 0) {
      console.log('✅ No orphaned leads to fix!');
      return;
    }

    let fixed = 0;
    let notFixable = 0;
    const notFixableLeads = [];

    for (const lead of orphanedLeads) {
      const email = lead.visitorEmail || lead.userEmail;

      if (!email) {
        console.log(`⚠️  Lead ${lead._id} (${lead.name}) has no email - cannot fix`);
        notFixable++;
        notFixableLeads.push({
          id: lead._id,
          name: lead.name,
          linkedinUrl: lead.linkedinUrl
        });
        continue;
      }

      // Find user by email
      const user = await usersCollection.findOne({ email: email });

      if (!user) {
        console.log(`⚠️  Lead ${lead._id} (${lead.name}) - user ${email} not found`);
        notFixable++;
        notFixableLeads.push({
          id: lead._id,
          name: lead.name,
          email: email,
          linkedinUrl: lead.linkedinUrl
        });
        continue;
      }

      // Update the lead with correct userId/visitorId
      const userId = user._id.toString();
      await leadsCollection.updateOne(
        { _id: lead._id },
        {
          $set: {
            userId: userId,
            visitorId: userId,
            userEmail: email,
            visitorEmail: email,
            updatedAt: new Date()
          }
        }
      );

      console.log(`✅ Fixed lead ${lead._id} (${lead.name}) -> userId: ${userId}`);
      fixed++;
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 Migration Summary:');
    console.log('='.repeat(50));
    console.log(`   Total orphaned leads: ${orphanedLeads.length}`);
    console.log(`   Fixed: ${fixed}`);
    console.log(`   Not fixable: ${notFixable}`);

    if (notFixableLeads.length > 0) {
      console.log('\n⚠️  Leads that could not be fixed:');
      notFixableLeads.forEach(lead => {
        console.log(`   - ${lead.id}: ${lead.name} (${lead.email || 'no email'})`);
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
fixOrphanedLeads();
