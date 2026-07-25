// Decision-maker enrichment via SignalHire.
// Usage: node scripts/enrich-leads.mjs <campaign-name> [max-leads]
// Example: node scripts/enrich-leads.mjs "Metro Detroit Roofing" 5
//
// Cost note: SignalHire charges per revealed contact. This script is
// manual-run only and stops at max-leads (default 5) per run.
//
// NOTE: SignalHire's API is callback-oriented; this script uses the
// request-then-poll pattern. If SignalHire changes endpoints, check
// https://www.signalhire.com/api docs and adjust SEARCH_URL/REQUEST_URL.

import { db, logEvent } from "./lib.mjs";

const [campaignName, maxArg] = process.argv.slice(2);
if (!campaignName) {
  console.error("Usage: node scripts/enrich-leads.mjs <campaign-name> [max-leads]");
  process.exit(1);
}
const maxLeads = Number(maxArg) || 5;

const client = db();
const apiKey = process.env.SIGNALHIRE_API_KEY;
if (!apiKey) {
  console.error("Missing SIGNALHIRE_API_KEY in .env.local");
  process.exit(1);
}

const BASE = "https://www.signalhire.com/api/v1";
const DM_TITLES = ["Owner", "President", "CEO", "Founder", "General Manager"];

async function searchCandidates(companyName) {
  const res = await fetch(`${BASE}/candidate/searchByQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({
      currentEmployer: companyName,
      title: DM_TITLES,
      size: 3,
    }),
  });
  if (!res.ok) {
    console.error("  searchByQuery error:", res.status, await res.text());
    return [];
  }
  const json = await res.json();
  return json.candidates || json.profiles || [];
}

async function revealCandidate(uid) {
  const res = await fetch(`${BASE}/candidate/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ items: [uid], withoutContacts: false }),
  });
  if (!res.ok) {
    console.error("  reveal error:", res.status, await res.text());
    return null;
  }
  const json = await res.json();
  const requestId = json.requestId || json.request_id;
  if (!requestId) return json;

  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${BASE}/candidate/request/${requestId}`, {
      headers: { apikey: apiKey },
    });
    if (!poll.ok) continue;
    const data = await poll.json();
    const item = Array.isArray(data) ? data[0] : data;
    if (item && (item.status === "success" || item.candidate)) return item;
    if (item && item.status === "failed") return null;
  }
  console.error("  reveal timed out");
  return null;
}

function extractContact(result) {
  const c = result.candidate || result;
  const contacts = c.contacts || [];
  const phone = contacts.find((x) => x.type === "phone")?.value || null;
  const email = contacts.find((x) => x.type === "email")?.value || null;
  const title =
    c.experience?.find((e) => e.current)?.position || c.title || null;
  return { name: c.fullName || c.name || null, title, phone, email };
}

async function main() {
  const { data: campaign } = await client
    .from("campaigns")
    .select("id, name")
    .eq("name", campaignName)
    .single();
  if (!campaign) {
    console.error(`Campaign "${campaignName}" not found`);
    process.exit(1);
  }

  const { data: leads } = await client
    .from("leads")
    .select("*")
    .eq("campaign_id", campaign.id)
    .eq("enrichment_status", "none")
    .order("created_at")
    .limit(maxLeads);

  if (!leads || leads.length === 0) {
    console.log("No unenriched leads.");
    return;
  }
  console.log(`Enriching ${leads.length} leads (max ${maxLeads})…`);

  for (const lead of leads) {
    console.log(`\n${lead.business_name}`);
    await client.from("leads").update({ enrichment_status: "pending" }).eq("id", lead.id);

    const candidates = await searchCandidates(lead.business_name);
    if (candidates.length === 0) {
      console.log("  no decision maker found");
      await client.from("leads").update({ enrichment_status: "not_found" }).eq("id", lead.id);
      await logEvent(client, "lead.enrichment_failed", "lead", lead.id, {
        business_name: lead.business_name,
        reason: "no candidates",
      });
      continue;
    }

    const uid = candidates[0].uid || candidates[0].id;
    const revealed = uid ? await revealCandidate(uid) : candidates[0];
    if (!revealed) {
      await client.from("leads").update({ enrichment_status: "not_found" }).eq("id", lead.id);
      await logEvent(client, "lead.enrichment_failed", "lead", lead.id, {
        business_name: lead.business_name,
        reason: "reveal failed",
      });
      continue;
    }

    const contact = extractContact(revealed);
    const before = {
      dm_name: lead.dm_name,
      dm_title: lead.dm_title,
      dm_phone: lead.dm_phone,
      dm_email: lead.dm_email,
    };
    const after = {
      dm_name: contact.name,
      dm_title: contact.title,
      dm_phone: contact.phone,
      dm_email: contact.email,
    };

    await client
      .from("leads")
      .update({ ...after, enrichment_status: "enriched" })
      .eq("id", lead.id);
    await logEvent(client, "lead.enriched", "lead", lead.id, {
      business_name: lead.business_name,
      before,
      after,
      source: "signalhire",
    });
    console.log(`  ✓ ${contact.name || "?"} (${contact.title || "?"}) ${contact.phone || ""} ${contact.email || ""}`);
  }
  console.log("\nDone.");
}

main();
