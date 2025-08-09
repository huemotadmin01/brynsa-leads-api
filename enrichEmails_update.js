const { MongoClient, ObjectId } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URL);

async function enrichEmailsUpdate() {
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const audits = db.collection("enriched_audit");

    const cursor = audits.find({
      enrichedEmail: { $exists: true, $ne: "" }
    });

    let total = 0;
    let updated = 0;
    let skipped = 0;

    while (await cursor.hasNext()) {
      const a = await cursor.next();
      total++;

      // Build a simple filter: prefer leadId; otherwise fall back to name + companyName
      let filter = null;

      if (a.leadId) {
        const id = toObjectId(a.leadId);
        if (id) filter = { _id: id };
      }

      if (!filter && a.originalName && a.companyName) {
        filter = { name: a.originalName, companyName: a.companyName };
      }

      if (!filter) {
        skipped++;
        console.log("⏩ Skipped (no usable matcher in audit):", a);
        continue;
      }

      // Only update if email is still missing/placeholder
      const res = await leads.updateOne(
        {
          ...filter,
          $or: [
            { email: "noemail@domain.com" },
            { email: { $exists: false } },
            { email: "" }
          ]
        },
        {
          $set: {
            email: a.enrichedEmail
          }
        }
      );

      if (res.matchedCount && res.modifiedCount) {
        updated++;
        const idMsg = filter._id ? filter._id.toString() : `${a.originalName} | ${a.companyName}`;
        console.log(`✅ Updated ${idMsg} -> ${a.enrichedEmail}`);
      } else {
        skipped++;
        // Not matched or already had a non-placeholder email
        // (keeping log noise low)
      }
    }

    console.log(`🎯 Done. Audits: ${total}, Updated: ${updated}, Skipped: ${skipped}`);
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await client.close();
  }
}

function toObjectId(val) {
  try {
    if (!val) return null;
    if (val instanceof ObjectId) return val;
    // accept 24-hex strings
    if (typeof val === "string" && /^[a-fA-F0-9]{24}$/.test(val)) {
      return new ObjectId(val);
    }
    return null;
  } catch {
    return null;
  }
}

enrichEmailsUpdate();
