// Config-driven multi-combination lead sourcing with dedup + coverage tracking.
// Usage: node scripts/refill-campaign.mjs [path/to/config.json]
// Default config: scripts/campaign-config.json (copy campaign-config.example.json)
//
// Runs keyword × location combinations, skipping combos already searched
// recently, until targetNewLeads new leads are added or combos run out.

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { db, logEvent } from "./lib.mjs";
import { upsertLeads } from "./scrape-leads.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] || resolve(here, "campaign-config.json");

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  console.error(`Could not read config at ${configPath}.`);
  console.error("Copy scripts/campaign-config.example.json to scripts/campaign-config.json and edit it.");
  process.exit(1);
}

const client = db();
const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error("Missing GOOGLE_PLACES_API_KEY in .env.local");
  process.exit(1);
}

const COVERAGE_COOLDOWN_DAYS = 14;

async function searchPlaces(query, pageSize) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount",
    },
    body: JSON.stringify({ textQuery: query, pageSize }),
  });
  if (!res.ok) {
    console.error("Places API error:", res.status, await res.text());
    return null;
  }
  return (await res.json()).places || [];
}

async function main() {
  let { data: campaign } = await client
    .from("campaigns")
    .select("*")
    .eq("name", config.campaign)
    .single();
  if (!campaign) {
    const { data: created, error } = await client
      .from("campaigns")
      .insert({ name: config.campaign, config })
      .select()
      .single();
    if (error) {
      console.error("campaign create failed:", error.message);
      process.exit(1);
    }
    campaign = created;
    await logEvent(client, "campaign.created", "campaign", campaign.id, {
      name: config.campaign,
    });
    console.log(`Created campaign "${config.campaign}"`);
  }

  const { data: coverage } = await client
    .from("search_coverage")
    .select("*")
    .eq("campaign_id", campaign.id);
  const covered = new Map(
    (coverage || []).map((c) => [`${c.keyword}|${c.location}`, c])
  );

  const cutoff = Date.now() - COVERAGE_COOLDOWN_DAYS * 24 * 3600 * 1000;
  const combos = [];
  for (const keyword of config.keywords) {
    for (const location of config.locations) {
      const prev = covered.get(`${keyword}|${location}`);
      if (prev && new Date(prev.last_run_at).getTime() > cutoff) continue;
      combos.push({ keyword, location });
    }
  }

  console.log(
    `${combos.length} uncovered combos (cooldown ${COVERAGE_COOLDOWN_DAYS}d), target ${config.targetNewLeads} new leads.`
  );

  let totalNew = 0;
  for (const { keyword, location } of combos) {
    if (totalNew >= config.targetNewLeads) break;
    const query = `${keyword} in ${location}`;
    console.log(`\nSearching: ${query}`);
    const places = await searchPlaces(query, Math.min(config.perComboLimit || 20, 20));
    if (places === null) break;
    const added = await upsertLeads(client, campaign.id, places);
    totalNew += added;
    console.log(`  → ${places.length} results, ${added} new (total new: ${totalNew})`);

    await client.from("search_coverage").upsert(
      {
        campaign_id: campaign.id,
        keyword,
        location,
        results_found: places.length,
        new_leads: added,
        last_run_at: new Date().toISOString(),
      },
      { onConflict: "campaign_id,keyword,location" }
    );
  }

  await logEvent(client, "campaign.refilled", "campaign", campaign.id, {
    new_leads: totalNew,
    combos_run: combos.length,
  });
  console.log(`\nDone. ${totalNew} new leads added to "${config.campaign}".`);
}

main();
