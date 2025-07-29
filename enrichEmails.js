const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URL);

async function enrichEmails() {
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");

    const missingEmailLeads = await leads.find({ email: "noemail@domain.com" }).toArray();

    for (const lead of missingEmailLeads) {
      const { name, companyName } = lead;
      if (!name || !companyName) continue;

      const existingLead = await leads.findOne({
        companyName,
        email: { $not: /noemail@domain.com/i }
      });

      if (!existingLead) continue;

      const email = existingLead.email.split(",")[0].trim();
      const emailPattern = extractEmailPattern(email, existingLead.name);
      if (!emailPattern) continue;

      const enrichedEmail = applyEmailPattern(emailPattern, name, email);
      if (!enrichedEmail) continue;

      await leads.updateOne(
        { _id: lead._id },
        { $set: { email: enrichedEmail } }
      );

      console.log(`✅ ${lead.name} → ${enrichedEmail}`);
    }

    console.log("🎯 Done enriching missing emails.");
  } catch (err) {
    console.error("❌ Error enriching emails:", err);
  } finally {
    await client.close();
  }
}

function extractEmailPattern(email, fullName) {
  if (!email || !fullName || fullName.split(" ").length < 2) return null;
  const domain = email.split("@")[1];
  const local = email.split("@")[0];

  const parts = fullName.toLowerCase().split(" ").filter(Boolean);
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];

  if (!firstName || !lastName) return null;

  if (local === `${firstName}.${lastName}`) return "first.last";
  if (local === `${firstName}${lastName}`) return "firstlast";
  if (local === `${firstName[0]}${lastName}`) return "fLast";
  if (local === `${firstName}`) return "first";

  return null;
}

function applyEmailPattern(pattern, fullName, originalEmail) {
  const domain = originalEmail.split("@")[1];
  const parts = fullName.toLowerCase().split(" ").filter(Boolean);
  const firstName = parts[0];
  const lastName = parts[parts.length - 1];

  if (!firstName || !lastName) return null;

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
