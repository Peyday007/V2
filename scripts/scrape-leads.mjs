// One-off Google Places scrape into a campaign.
// Usage: node scripts/scrape-leads.mjs <campaign-name> "<keyword>" "<location>" [limit]
// Example: node scripts/scrape-leads.mjs "Metro Detroit Roofing" "roofing contractor" "Troy, MI" 20

import { db, logEvent, domainOf, normPhone } from "./lib.mjs";

const [campaignName, keyword, location, limitArg] = process.argv.slice(2);
if (!campaignName || !keyword || !location) {
  console.error(
    'Usage: node scripts/scrape-leads.mjs <campaign-name> "<keyword>" "<location>" [limit]'
  );
  process.exit(1);
}
const limit = Math.min(Number(limitArg) || 20, 20);

const client = db();
const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error("Missing GOOGLE_PLACES_API_KEY in .env.local");
  process.exit(1);
}

async function searchPlaces(query) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({ textQuery: query, pageSize: limit }),
  });
  if (!res.ok) {
    console.error("Places API error:", res.status, await res.text());
    process.exit(1);
  }
  const json = await res.json();
  return json.places || [];
}

export async function upsertLeads(client, campaignId, places, source = "google_places") {
  const { data: existing } = await client
    .from("leads")
    .select("place_id, phone, domain");
  const knownPlaceIds = new Set((existing || []).map((l) => l.place_id).filter(Boolean));
  const knownPhones = new Set((existing || []).map((l) => normPhone(l.phone)).filter(Boolean));
  const knownDomains = new Set((existing || []).map((l) => l.domain).filter(Boolean));

  let added = 0;
  for (const p of places) {
    const phone = p.nationalPhoneNumber || null;
    const domain = domainOf(p.websiteUri);
    if (knownPlaceIds.has(p.id)) continue;
    if (phone && knownPhones.has(normPhone(phone))) continue;
    if (domain && knownDomains.has(domain)) continue;

    const addressParts = (p.formattedAddress || "").split(",").map((s) => s.trim());
    const state = addressParts.length >= 2 ? (addressParts[addressParts.length - 2].match(/^([A-Z]{2})\b/) || [])[1] || null : null;
    const city = addressParts.length >= 3 ? addressParts[addressParts.length - 3] : null;

    const { data: lead, error } = await client
      .from("leads")
      .insert({
        campaign_id: campaignId,
        business_name: p.displayName?.text || "Unknown",
        phone,
        website: p.websiteUri || null,
        domain,
        address: p.formattedAddress || null,
        city,
        state,
        place_id: p.id,
        rating: p.rating ?? null,
        review_count: p.userRatingCount ?? null,
        source,
      })
      .select()
      .single();
    if (error) {
      console.error("insert failed:", p.displayName?.text, error.message);
      continue;
    }
    await logEvent(client, "lead.created", "lead", lead.id, {
      business_name: lead.business_name,
      source,
      campaign_id: campaignId,
    });
    knownPlaceIds.add(p.id);
    if (phone) knownPhones.add(normPhone(phone));
    if (domain) knownDomains.add(domain);
    added++;
    console.log(`  + ${lead.business_name} (${phone || "no phone"})`);
  }
  return added;
}

async function main() {
  let { data: campaign } = await client
    .from("campaigns")
    .select("*")
    .eq("name", campaignName)
    .single();
  if (!campaign) {
    const { data: created, error } = await client
      .from("campaigns")
      .insert({ name: campaignName })
      .select()
      .single();
    if (error) {
      console.error("campaign create failed:", error.message);
      process.exit(1);
    }
    campaign = created;
    await logEvent(client, "campaign.created", "campaign", campaign.id, {
      name: campaignName,
    });
    console.log(`Created campaign "${campaignName}"`);
  }

  const query = `${keyword} in ${location}`;
  console.log(`Searching: ${query}`);
  const places = await searchPlaces(query);
  console.log(`Found ${places.length} results, deduping…`);
  const added = await upsertLeads(client, campaign.id, places);
  console.log(`Done. ${added} new leads added to "${campaignName}".`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) main();
