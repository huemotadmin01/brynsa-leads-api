const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URL);

async function enrichEmails() {
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const enrichedCollection = db.collection("enriched_audit");

    // Find leads with missing emails
    const missingEmailLeads = await leads.find({ email: "noemail@domain.com" }).toArray();

    for (const lead of missingEmailLeads) {
      const { name, companyName } = lead;
      if (!name || !companyName) continue;

      // Find another lead from same company with a valid email
      const existingLead = await leads.findOne({
        companyName: companyName,
        email: { $not: /noemail@domain.com/i }
      });

      if (!existingLead) continue;

      const email = existingLead.email.split(",")[0].trim(); // first email
      const emailPattern = extractEmailPattern(email, existingLead.name);
      if (!emailPattern) continue;

      const enrichedEmail = applyEmailPattern(emailPattern, name, email);
      if (!enrichedEmail) continue;

      // Insert audit record
      await enrichedCollection.insertOne({
        leadId: lead._id,
        companyName: companyName,
        originalName: lead.name,
        enrichedEmail: enrichedEmail,
        pattern: emailPattern,
        timestamp: new Date()
      });

      console.log(`AUDIT → ${lead.name} | ${companyName} | ${emailPattern} → ${enrichedEmail}`);
    }

    console.log("🎯 Email enrichment audit complete.");
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await client.close();
  }
}

// Extract pattern like "first.last" or "firstlast"
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

enrichEmails();