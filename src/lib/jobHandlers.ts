import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";
import { enqueue, Job, JobType } from "./jobs";
import { planSearches, textQueryFor } from "./searchPlan";
import { qualifyBusiness } from "./qualify";
import { addressParts, PlacesError, searchPlaces } from "./places";
import {
  normalizeBusinessName,
  normalizeDomain,
  normalizePhone,
  normalizeState,
  normalizeZip,
} from "./normalize";
import { needsEnrichmentQueue } from "./machineStatus";
import { logEvent } from "./events";

type Handler = (job: Job) => Promise<void>;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function getCampaign(id: string) {
  const { data, error } = await supabaseAdmin()
    .from("sourcing_campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(`campaign ${id} not found: ${error.message}`);
  return data;
}

async function bumpCampaign(id: string, deltas: Record<string, number>) {
  const db = supabaseAdmin();
  const { data: current } = await db
    .from("sourcing_campaigns")
    .select(Object.keys(deltas).join(","))
    .eq("id", id)
    .single();
  if (!current) return;
  const patch: Record<string, number> = {};
  for (const [k, v] of Object.entries(deltas)) {
    patch[k] = ((current as unknown as Record<string, number>)[k] ?? 0) + v;
  }
  await db.from("sourcing_campaigns").update(patch).eq("id", id);
}

/** Campaign is still allowed to spend API requests? */
function withinBudget(campaign: {
  api_requests_used: number;
  max_api_requests: number;
  unique_saved: number;
  target_lead_count: number;
  status: string;
}): { ok: boolean; reason?: string } {
  if (campaign.status !== "running") {
    return { ok: false, reason: `campaign is ${campaign.status}` };
  }
  if (campaign.api_requests_used >= campaign.max_api_requests) {
    return { ok: false, reason: "campaign API request cap reached" };
  }
  if (campaign.unique_saved >= campaign.target_lead_count) {
    return { ok: false, reason: "target lead count reached" };
  }
  return { ok: true };
}

async function finishCampaignIfDone(campaignId: string) {
  const db = supabaseAdmin();
  const campaign = await getCampaign(campaignId);
  if (campaign.status !== "running") return;

  const { count: outstanding } = await db
    .from("jobs")
    .select("*", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "running"])
    .in("type", [
      "plan_search_tasks",
      "execute_places_search",
      "continue_places_pagination",
    ]);

  const targetHit = campaign.unique_saved >= campaign.target_lead_count;
  const capHit = campaign.api_requests_used >= campaign.max_api_requests;

  if ((outstanding ?? 0) === 0 || targetHit || capHit) {
    await db
      .from("sourcing_campaigns")
      .update({ status: "completed", finished_at: new Date().toISOString() })
      .eq("id", campaignId);
    await logEvent("campaign.completed", "sourcing_campaign", campaignId, {
      unique_saved: campaign.unique_saved,
      api_requests_used: campaign.api_requests_used,
      reason: targetHit ? "target reached" : capHit ? "cap reached" : "searches exhausted",
    });
  }
}

/* ------------------------------------------------------------------ */
/* 1. plan_search_tasks                                                */
/* ------------------------------------------------------------------ */

const planSearchTasks: Handler = async (job) => {
  const campaignId = String(job.payload.campaign_id);
  const db = supabaseAdmin();
  const campaign = await getCampaign(campaignId);

  const planned = planSearches(campaign);
  if (planned.length === 0) {
    await db
      .from("sourcing_campaigns")
      .update({
        status: "failed",
        last_error: "No search terms or locations configured",
        finished_at: new Date().toISOString(),
      })
      .eq("id", campaignId);
    return;
  }

  // Page 1 rows for every combination. The unique index makes this idempotent.
  const rows = planned.map((p) => ({
    campaign_id: campaignId,
    search_term: p.search_term,
    location: p.location,
    page_number: 1,
  }));
  await db.from("search_tasks").upsert(rows, {
    onConflict: "campaign_id,search_term,location,page_number",
    ignoreDuplicates: true,
  });

  const { data: tasks } = await db
    .from("search_tasks")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "pending");

  for (const t of tasks || []) {
    await enqueue({
      type: "execute_places_search",
      payload: { task_id: t.id, campaign_id: campaignId },
      idempotencyKey: `execute_places_search:${t.id}`,
      campaignId,
    });
  }

  await db
    .from("sourcing_campaigns")
    .update({ searches_planned: planned.length })
    .eq("id", campaignId);

  await logEvent("campaign.planned", "sourcing_campaign", campaignId, {
    combinations: planned.length,
  });
};

/* ------------------------------------------------------------------ */
/* 2. execute_places_search  (+ continue_places_pagination)            */
/* ------------------------------------------------------------------ */

const executePlacesSearch: Handler = async (job) => {
  const taskId = String(job.payload.task_id);
  const campaignId = String(job.payload.campaign_id);
  const db = supabaseAdmin();

  const { data: task } = await db
    .from("search_tasks")
    .select("*")
    .eq("id", taskId)
    .single();
  if (!task) throw new Error(`search_task ${taskId} not found`);
  if (task.status === "done") return; // already processed

  const campaign = await getCampaign(campaignId);
  const budget = withinBudget(campaign);
  if (!budget.ok) {
    await db
      .from("search_tasks")
      .update({ status: "skipped", last_error: budget.reason })
      .eq("id", taskId);
    await finishCampaignIfDone(campaignId);
    return;
  }

  await db.from("search_tasks").update({ status: "running" }).eq("id", taskId);

  let page;
  try {
    page = await searchPlaces({
      textQuery: textQueryFor({
        search_term: task.search_term,
        location: task.location,
      }),
      pageToken: task.page_token,
      latitude: campaign.latitude,
      longitude: campaign.longitude,
      radiusM: campaign.radius_m,
    });
  } catch (e) {
    const err = e instanceof PlacesError ? e : new Error(String(e));
    await db
      .from("search_tasks")
      .update({
        status: "pending",
        retry_count: (task.retry_count ?? 0) + 1,
        last_error: err.message.slice(0, 300),
      })
      .eq("id", taskId);
    // Non-retryable (bad key, bad request) → surface immediately.
    if (e instanceof PlacesError && !e.retryable) {
      await db
        .from("search_tasks")
        .update({ status: "failed" })
        .eq("id", taskId);
    }
    throw err;
  }

  // One API request consumed regardless of result count.
  await bumpCampaign(campaignId, {
    api_requests_used: 1,
    businesses_returned: page.places.length,
  });

  let saved = 0;
  let duplicates = 0;

  for (const place of page.places) {
    const name = place.displayName?.text?.trim();
    if (!name) continue;

    const phone = place.nationalPhoneNumber || null;
    const website = place.websiteUri || null;
    const normPhone = normalizePhone(phone);
    const normDomain = normalizeDomain(website);
    const normName = normalizeBusinessName(name);
    const parts = addressParts(place);
    const city = parts.city;
    const state = normalizeState(parts.state) || parts.state;

    // ---- Deduplication: strong keys first, then secondary ----
    let existingId: string | null = null;
    let dupReason: string | null = null;

    const { data: byPlace } = await db
      .from("leads")
      .select("id")
      .eq("place_id", place.id)
      .maybeSingle();
    if (byPlace) {
      existingId = byPlace.id;
      dupReason = `same place_id ${place.id}`;
    }

    if (!existingId && normPhone) {
      const { data: hit } = await db
        .from("leads")
        .select("id")
        .eq("normalized_phone", normPhone)
        .limit(1)
        .maybeSingle();
      if (hit) {
        existingId = hit.id;
        dupReason = `same phone ${normPhone}`;
      }
    }
    if (!existingId && normDomain) {
      const { data: hit } = await db
        .from("leads")
        .select("id")
        .eq("domain", normDomain)
        .limit(1)
        .maybeSingle();
      if (hit) {
        existingId = hit.id;
        dupReason = `same domain ${normDomain}`;
      }
    }
    // Secondary: normalized name + city, then normalized name + address.
    if (!existingId && normName && city) {
      const { data: hit } = await db
        .from("leads")
        .select("id")
        .eq("normalized_name", normName)
        .eq("city", city)
        .limit(1)
        .maybeSingle();
      if (hit) {
        existingId = hit.id;
        dupReason = `same name+city (${normName}, ${city})`;
      }
    }
    if (!existingId && normName && place.formattedAddress) {
      const { data: hit } = await db
        .from("leads")
        .select("id")
        .eq("normalized_name", normName)
        .eq("address", place.formattedAddress)
        .limit(1)
        .maybeSingle();
      if (hit) {
        existingId = hit.id;
        dupReason = `same name+address (${normName})`;
      }
    }

    if (existingId) {
      // Never create a second business. Preserve the search provenance and
      // link it to this campaign if it wasn't already.
      await db.from("source_records").insert({
        lead_id: existingId,
        filename: `places:${task.search_term} @ ${task.location} p${task.page_number}`,
        raw_data: place as unknown as Record<string, unknown>,
        duplicate_of_existing: true,
        duplicate_reason: dupReason,
      });
      await db
        .from("leads")
        .update({ sourcing_campaign_id: campaignId })
        .eq("id", existingId)
        .is("sourcing_campaign_id", null);
      duplicates++;
      continue;
    }

    // ---- Save immediately at machine_status='discovered' ----
    const { data: lead, error: insErr } = await db
      .from("leads")
      .insert({
        business_name: name,
        normalized_name: normName,
        phone,
        normalized_phone: normPhone,
        website,
        domain: normDomain,
        address: place.formattedAddress || null,
        city,
        state,
        zip: normalizeZip(parts.zip),
        industry: campaign.industry || place.primaryType || null,
        rating: place.rating ?? null,
        review_count: place.userRatingCount ?? null,
        place_id: place.id,
        business_status: place.businessStatus || null,
        place_types: place.types || null,
        latitude: place.location?.latitude ?? null,
        longitude: place.location?.longitude ?? null,
        source: "google_places",
        sourcing_campaign_id: campaignId,
        machine_status: "discovered",
      })
      .select("id")
      .single();

    if (insErr) {
      // Unique place_id race with a concurrent worker: treat as duplicate.
      if (insErr.code === "23505") {
        duplicates++;
        continue;
      }
      throw new Error(`lead insert failed: ${insErr.message}`);
    }

    await db.from("source_records").insert({
      lead_id: lead.id,
      filename: `places:${task.search_term} @ ${task.location} p${task.page_number}`,
      raw_data: place as unknown as Record<string, unknown>,
    });
    await logEvent("lead.created", "lead", lead.id, {
      business_name: name,
      source: "google_places",
      campaign_id: campaignId,
    });

    // Hand off to the async chain. Search job does NOT wait for these.
    await enqueue({
      type: "normalize_lead",
      payload: { lead_id: lead.id, campaign_id: campaignId },
      idempotencyKey: `normalize_lead:${lead.id}`,
      campaignId,
      priority: 50,
    });
    saved++;
  }

  await db
    .from("search_tasks")
    .update({
      status: "done",
      records_returned: page.places.length,
      unique_added: saved,
      executed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", taskId);

  await bumpCampaign(campaignId, {
    searches_completed: 1,
    unique_saved: saved,
    duplicates_skipped: duplicates,
  });

  // Continuation job for the next Places page.
  if (page.nextPageToken) {
    const refreshed = await getCampaign(campaignId);
    if (withinBudget(refreshed).ok) {
      const nextPage = (task.page_number ?? 1) + 1;
      const { data: nextTask } = await db
        .from("search_tasks")
        .upsert(
          {
            campaign_id: campaignId,
            search_term: task.search_term,
            location: task.location,
            page_number: nextPage,
            page_token: page.nextPageToken,
          },
          {
            onConflict: "campaign_id,search_term,location,page_number",
            ignoreDuplicates: true,
          }
        )
        .select("id")
        .maybeSingle();

      if (nextTask) {
        await bumpCampaign(campaignId, { searches_planned: 1 });
        await enqueue({
          type: "continue_places_pagination",
          payload: { task_id: nextTask.id, campaign_id: campaignId },
          idempotencyKey: `continue_places_pagination:${nextTask.id}`,
          campaignId,
          // Places page tokens need a moment to become valid.
          runAfter: new Date(Date.now() + 3000),
        });
      }
    }
  }

  await finishCampaignIfDone(campaignId);
};

/* ------------------------------------------------------------------ */
/* 3. normalize_lead                                                   */
/* ------------------------------------------------------------------ */

const normalizeLead: Handler = async (job) => {
  const leadId = String(job.payload.lead_id);
  const campaignId = job.payload.campaign_id
    ? String(job.payload.campaign_id)
    : null;
  const db = supabaseAdmin();

  const { data: lead } = await db
    .from("leads")
    .select("id, business_name, phone, website, state, zip, machine_status")
    .eq("id", leadId)
    .single();
  if (!lead) return;

  await db
    .from("leads")
    .update({
      normalized_name: normalizeBusinessName(lead.business_name),
      normalized_phone: normalizePhone(lead.phone),
      domain: normalizeDomain(lead.website),
      state: normalizeState(lead.state) || lead.state,
      zip: normalizeZip(lead.zip),
      machine_status: "normalized",
    })
    .eq("id", leadId);

  await enqueue({
    type: "qualify_lead",
    payload: { lead_id: leadId, campaign_id: campaignId },
    idempotencyKey: `qualify_lead:${leadId}`,
    campaignId,
    priority: 50,
  });
};

/* ------------------------------------------------------------------ */
/* 4. qualify_lead                                                     */
/* ------------------------------------------------------------------ */

const qualifyLead: Handler = async (job) => {
  const leadId = String(job.payload.lead_id);
  const campaignId = job.payload.campaign_id
    ? String(job.payload.campaign_id)
    : null;
  const db = supabaseAdmin();

  const { data: lead } = await db
    .from("leads")
    .select(
      "id, business_name, phone, normalized_phone, website, rating, review_count, business_status, do_not_call, archived_at, machine_status"
    )
    .eq("id", leadId)
    .single();
  if (!lead) return;

  const rules = campaignId
    ? await getCampaign(campaignId)
    : {
        min_rating: null,
        min_review_count: null,
        max_review_count: null,
        require_website: false,
        exclude_franchises: true,
      };

  const result = qualifyBusiness(lead, {
    min_rating: rules.min_rating,
    min_review_count: rules.min_review_count,
    max_review_count: rules.max_review_count,
    require_website: rules.require_website,
    exclude_franchises: rules.exclude_franchises,
  });

  if (!result.passed) {
    await db
      .from("leads")
      .update({
        machine_status: "enrichment_failed",
        qualification_failure_reason: result.reason,
      })
      .eq("id", leadId);
    if (campaignId) await bumpCampaign(campaignId, { qualification_failures: 1 });
    await logEvent("lead.qualification_failed", "lead", leadId, {
      reason: result.reason,
    });
    return;
  }

  await db
    .from("leads")
    .update({ qualification_failure_reason: null })
    .eq("id", leadId);

  await enqueue({
    type: "queue_enrichment",
    payload: { lead_id: leadId, campaign_id: campaignId },
    idempotencyKey: `queue_enrichment:${leadId}`,
    campaignId,
    priority: 50,
  });
};

/* ------------------------------------------------------------------ */
/* 5. queue_enrichment                                                 */
/* ------------------------------------------------------------------ */

const queueEnrichment: Handler = async (job) => {
  const leadId = String(job.payload.lead_id);
  const campaignId = job.payload.campaign_id
    ? String(job.payload.campaign_id)
    : null;
  const db = supabaseAdmin();

  const { data: lead } = await db
    .from("leads")
    .select("id, machine_status")
    .eq("id", leadId)
    .single();
  if (!lead) return;

  // Guard: never re-queue enrichment for a lead that already has it.
  if (!needsEnrichmentQueue(lead.machine_status)) return;

  const created = await enqueue({
    type: "enrich_lead",
    payload: { lead_id: leadId, campaign_id: campaignId },
    idempotencyKey: `enrich_lead:${leadId}`,
    campaignId,
    priority: 200,
  });

  await db
    .from("leads")
    .update({ machine_status: "enrichment_queued" })
    .eq("id", leadId);

  if (created && campaignId) {
    await bumpCampaign(campaignId, { enrichment_queued: 1 });
  }
};

/* ------------------------------------------------------------------ */
/* 6. enrich_lead — Milestone 3. Queued now, not processed yet.        */
/* ------------------------------------------------------------------ */

const enrichLead: Handler = async () => {
  // Intentionally a no-op until Milestone 3. Returning without touching the
  // lead leaves it at 'enrichment_queued' and marks this job done, so the
  // queue does not fill with retrying jobs.
  return;
};

/* ------------------------------------------------------------------ */

export const HANDLERS: Record<JobType, Handler> = {
  plan_search_tasks: planSearchTasks,
  execute_places_search: executePlacesSearch,
  continue_places_pagination: executePlacesSearch, // same logic, resumes via page_token
  normalize_lead: normalizeLead,
  qualify_lead: qualifyLead,
  queue_enrichment: queueEnrichment,
  enrich_lead: enrichLead,
};
