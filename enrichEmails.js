/*const { MongoClient } = require("mongodb");

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

enrichEmails();*/

// enrich.js (audit-only, simple version)
const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URL);

// generic/local mailbox names we should ignore when learning a pattern
const GENERIC_LOCALS = new Set([
  "info","hr","jobs","job","career","careers","hello","contact","sales","support",
  "help","team","admin","office","enquiries","inquiries","recruiter","talent",
  "hiring","mail","marketing","noreply","no-reply","donotreply","billing",
  "accounts","service","services","newsletter","resume","resumes"
]);

// free/public domains to ignore
const PUBLIC_DOMAINS = new Set([
  "gmail.com","yahoo.com","outlook.com","hotmail.com","proton.me","icloud.com",
  "aol.com","gmx.com","zoho.com","yandex.com"
]);

function pickFirstEmail(raw = "") {
  // handle "email1, email2" / spaces
  const first = String(raw).split(/[,;\s]+/).find(Boolean) || "";
  return first.trim();
}

function parseEmail(e = "") {
  const m = e.toLowerCase().match(/^([^@]+)@([^@]+)$/);
  if (!m) return null;
  return { local: m[1], domain: m[2] };
}

function normNamePart(s = "") {
  return String(s || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function splitFirstLast(fullName = "") {
  const parts = String(fullName || "")
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  const first = normNamePart(parts[0]);
  const last = normNamePart(parts[parts.length - 1]);
  return { first, last };
}

function isGoodPeerEmail(email) {
  const p = parseEmail(email);
  if (!p) return false;
  if (PUBLIC_DOMAINS.has(p.domain)) return false;
  if (GENERIC_LOCALS.has(p.local)) return false;
  // must have letters
  if (!/[a-z]/i.test(p.local)) return false;
  return true;
}

// Try to detect the pattern used by `peerEmail` given `peerName`
function extractEmailPattern(peerEmail, peerFullName) {
  const p = parseEmail(peerEmail);
  if (!p) return null;

  const { first, last } = splitFirstLast(peerFullName);
  if (!first || !last) return null;

  // allow ., _, - as separators; also compare a stripped version
  const local = p.local;
  const stripped = local.replace(/[\.\_\-]/g, "");

  const patterns = [
    ["first.last", `${first}.${last}`],
    ["last.first", `${last}.${first}`],
    ["first_last", `${first}_${last}`],
    ["last_first", `${last}_${first}`],
    ["f.last", `${first[0]}.${last}`],
    ["first.l", `${first}.${last[0]}`],
  ];
  for (const [name, expected] of patterns) {
    if (local === expected) return { pattern: name, domain: p.domain };
  }

  const soft = [
    ["firstlast", `${first}${last}`],
    ["lastfirst", `${last}${first}`],
    ["flast", `${first[0]}${last}`],
    ["firstl", `${first}${last[0]}`],
    ["first", `${first}`],
    ["last", `${last}`],
  ];
  for (const [name, expected] of soft) {
    if (stripped === expected) return { pattern: name, domain: p.domain };
  }

  return null;
}

function applyEmailPattern(pattern, targetFullName, domain) {
  const { first, last } = splitFirstLast(targetFullName);
  if (!first || !last) return null;

  switch (pattern) {
    case "first.last":  return `${first}.${last}@${domain}`;
    case "last.first":  return `${last}.${first}@${domain}`;
    case "first_last":  return `${first}_${last}@${domain}`;
    case "last_first":  return `${last}_${first}@${domain}`;
    case "firstlast":   return `${first}${last}@${domain}`;
    case "lastfirst":   return `${last}${first}@${domain}`;
    case "f.last":      return `${first[0]}.${last}@${domain}`;
    case "first.l":     return `${first}.${last[0]}@${domain}`;
    case "flast":       return `${first[0]}${last}@${domain}`;
    case "firstl":      return `${first}${last[0]}@${domain}`;
    case "first":       return `${first}@${domain}`;
    case "last":        return `${last}@${domain}`;
    default:            return null;
  }
}

async function enrichEmails() {
  const start = Date.now();
  const runId = new Date().toISOString();
  try {
    await client.connect();
    const db = client.db("brynsaleads");
    const leads = db.collection("leads");
    const enrichedCollection = db.collection("enriched_audit");

    // Leads to enrich = ones with the placeholder email
    const missingEmailLeads = await leads
      .find({ email: "noemail@domain.com" })
      .toArray();

    console.log(`▶️  Run ${runId} | candidates: ${missingEmailLeads.length}`);

    for (const lead of missingEmailLeads) {
      const { _id, name, companyName } = lead || {};
      if (!name || !companyName) {
        console.log(`⏩ Skipped: Missing name/company for lead ${_id}`);
        continue;
      }

      // find a peer from same company with a usable email
      const peers = await leads
        .find({
          _id: { $ne: _id },
          companyName: companyName,
          email: { $exists: true, $ne: null, $not: /noemail@domain\.com/i },
        })
        .project({ name: 1, email: 1 })
        .toArray();

      if (!peers.length) {
        console.log(`⏩ Skipped: No other lead with valid email found for ${companyName}.`);
        continue;
      }

      let patternInfo = null;
      let peerUsed = null;

      for (const peer of peers) {
        const candidate = pickFirstEmail(peer.email);
        if (!isGoodPeerEmail(candidate)) continue;

        const info = extractEmailPattern(candidate, peer.name || "");
        if (info) {
          patternInfo = info;
          peerUsed = { name: peer.name || "", email: candidate };
          break;
        }
      }

      if (!patternInfo) {
        console.log(`⏩ Skipped: Could not extract pattern from existing lead email (company: ${companyName}).`);
        continue;
      }

      const enrichedEmail = applyEmailPattern(patternInfo.pattern, name, patternInfo.domain);
      if (!enrichedEmail) {
        console.log(`⏩ Skipped: Failed to build email from pattern for ${name} (${companyName}).`);
        continue;
      }

      // Insert audit record only (no update to lead)
      await enrichedCollection.insertOne({
        runId,
        leadId: _id,
        companyName,
        originalName: name,
        enrichedEmail,
        pattern: patternInfo.pattern,
        domain: patternInfo.domain,
        peer: peerUsed,        // which peer we learned from
        timestamp: new Date(),
      });

      console.log(`AUDIT → ${name} | ${companyName} | ${patternInfo.pattern} → ${enrichedEmail}`);
    }

    console.log(`🎯 Email enrichment audit complete in ${(Date.now() - start)/1000}s.`);
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await client.close();
  }
}

enrichEmails();
