const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URL);

async function enrichEmailsUpdate() {
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");

    // Find leads with missing emails
    const missingEmailLeads = await leads.find({ email: "noemail@domain.com" }).toArray();

    for (const lead of missingEmailLeads) {
      const { name, companyName } = lead;
      if (!name || !companyName) continue;

      // Find another lead at the same company with a valid email
      const existingLead = await leads.findOne({
        companyName: companyName,
        email: { $not: /noemail@domain.com/i }
      });

      if (!existingLead) continue;

      const email = existingLead.email.split(",")[0].trim(); // First email only
      const pattern = extractEmailPattern(email, existingLead.name);
      if (!pattern) continue;

      const enrichedEmail = applyEmailPattern(pattern, name, email);
      if (!enrichedEmail) continue;

      // Update directly in the leads collection
      await leads.updateOne(
        { _id: lead._id },
        { $set: { email: enrichedEmail } }
      );

      console.log(`✅ Updated ${lead.name} -> ${enrichedEmail}`);
    }

    console.log("🎯 Email enrichment update complete.");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await client.close();
  }
}

function extractEmailPattern(email, fullName) {
  const domain = email.split("@")[1];
  const local = email.split("@")[0];

  const [firstName, lastName] = fullName.toLowerCase().split(" ");

  if (local === `${firstName}.${lastName}`) return "first.last";
  if (local === `${firstName}${lastName}`) return "firstlast";
  if (local === `${firstName[0]}${lastName}`) return "fLast";
  if (local === `${firstName}`) return "first";

  return null;
}

function applyEmailPattern(pattern, fullName, originalEmail) {
  const domain = originalEmail.split("@")[1];
  const [firstName, lastName] = fullName.toLowerCase().split(" ");

  switch (pattern) {
    case "first.last":
      return `${firstName}.${lastName}@${domain}`;
    case "firstlast":
      return `${firstName}${lastName}@${domain}`;
    case "fLast":
      return `${firstName[0]}${lastName}@${domain}`;
    case "first":
      return `${firstName}@${domain}`;
    default:
      return null;
  }
}

enrichEmailsUpdate();