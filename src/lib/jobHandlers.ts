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
import { findIndustry, roleBasedAsk } from "./industries";
import { SOURCES, STOP_CONFIDENCE } from "./sources";
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
/* 6. enrich_lead — baseline pass                                       */
/*                                                                      */
/* Waterfall Step 1 (internal database) + Success Level C (role-based   */
/* ask). No crawling, registries, or search APIs yet — those are the    */
/* rest of Milestone 3. The point of this pass is that a lead with a    */
/* working main line and a known role to ask for is CALLABLE, which is  */
/* exactly what Success Level C means. Later steps upgrade C -> A/B.    */
/* ------------------------------------------------------------------ */

const enrichLead: Handler = async (job) => {
  const leadId = String(job.payload.lead_id);
  const db = supabaseAdmin();
  const startedAt = Date.now();

  const { data: lead } = await db
    .from("leads")
    .select(
      "id, business_name, industry, normalized_phone, domain, website, city, machine_status, archived_at"
    )
    .eq("id", leadId)
    .single();
  if (!lead || lead.archived_at) return;
  if (["assigned_to_packet", "contacted", "archived"].includes(lead.machine_status)) {
    return;
  }

  await db.from("leads").update({ machine_status: "enriching" }).eq("id", leadId);

  const stepsAttempted: string[] = ["internal_db"];
  let successLevel: "A" | "B" | "C" = "C";
  let finalStatus = "role_only_found";
  let confidence = 0.4;

  // --- Step 1: internal database. Reuse anything the team already knows. ---
  const { data: existingContacts } = await db
    .from("contacts")
    .select("id, full_name, title, role_category, direct_phone, extension, confidence")
    .eq("lead_id", leadId)
    .eq("active", true)
    .order("confidence", { ascending: false });

  const { data: discoveries } = await db
    .from("call_discoveries")
    .select("owner_name, title, best_callback_time, transfer_instructions, extension")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false })
    .limit(1);

  // Sibling leads: the same company found under another record can carry a
  // decision-maker we already paid for or discovered on a call.
  let siblingContact: { full_name: string | null; title: string | null } | null = null;
  if (lead.domain || lead.normalized_phone) {
    const orFilter = [
      lead.domain ? `domain.eq.${lead.domain}` : null,
      lead.normalized_phone ? `normalized_phone.eq.${lead.normalized_phone}` : null,
    ]
      .filter(Boolean)
      .join(",");
    const { data: siblings } = await db
      .from("leads")
      .select("id")
      .or(orFilter)
      .neq("id", leadId)
      .limit(5);
    if (siblings && siblings.length > 0) {
      stepsAttempted.push("internal_db_siblings");
      const { data: sc } = await db
        .from("contacts")
        .select("full_name, title")
        .in("lead_id", siblings.map((s) => s.id))
        .eq("active", true)
        .not("full_name", "is", null)
        .limit(1);
      if (sc && sc.length > 0) siblingContact = sc[0];
    }
  }

  const named =
    existingContacts?.find((c) => c.full_name) ||
    (discoveries?.[0]?.owner_name
      ? {
          full_name: discoveries[0].owner_name,
          title: discoveries[0].title,
          extension: discoveries[0].extension,
          direct_phone: null,
        }
      : null) ||
    siblingContact;

  // --- Steps 2+: pluggable public sources, cheapest first, stop when
  // confident. Adding a registry or directory means adding one adapter. ---
  let websiteFinding: {
    name: string;
    title: string;
    url: string;
    supportingText: string;
    confidence: number;
  } | null = null;

  if (!named) {
    const ctx = {
      leadId,
      businessName: lead.business_name,
      website: lead.website,
      domain: lead.domain,
      city: lead.city,
      state: null as string | null,
      industry: lead.industry,
    };

    for (const source of SOURCES) {
      if (!source.isAvailable()) continue;
      stepsAttempted.push(source.key);

      let result;
      try {
        result = await source.run(ctx);
      } catch (e) {
        console.error(`[enrich] source ${source.key} threw:`, e);
        continue;
      }

      if (result.skipped) {
        await db.from("enrichment_evidence").insert({
          lead_id: leadId,
          source_type: source.key,
          source_url: null,
          field: "role",
          value: null,
          supporting_text: `Skipped: ${result.skipped}`,
          extraction_method: "deterministic",
          confidence: 0,
        });
        continue;
      }

      let best: (typeof result.findings)[number] | null = null;
      for (const f of result.findings) {
        // Record every claim, including weaker and contradictory ones.
        await db.from("enrichment_evidence").insert({
          lead_id: leadId,
          source_type: source.key,
          source_url: f.sourceUrl,
          field: "owner_name",
          value: f.name,
          supporting_text: `${f.title} — "${f.supportingText}"`,
          extraction_method: f.method,
          confidence: f.confidence,
          is_conflicting: !!best && best.name.toLowerCase() !== f.name.toLowerCase(),
        });
        if (!best || f.confidence > best.confidence) best = f;
      }

      if (best && (!websiteFinding || best.confidence > websiteFinding.confidence)) {
        websiteFinding = {
          name: best.name,
          title: best.title,
          url: best.sourceUrl || "",
          supportingText: best.supportingText,
          confidence: best.confidence,
        };
      }

      if (websiteFinding && websiteFinding.confidence >= STOP_CONFIDENCE) break;
    }
  }

  let recommendedAsk: string;

  if (websiteFinding) {
    successLevel = websiteFinding.confidence >= 0.8 ? "A" : "B";
    finalStatus = "decision_maker_found";
    confidence = websiteFinding.confidence;
    recommendedAsk = `Call the main line and ask for ${websiteFinding.name}, the ${websiteFinding.title.toLowerCase()}.`;

    await db.from("contacts").insert({
      lead_id: leadId,
      full_name: websiteFinding.name,
      title: websiteFinding.title,
      role_category: /owner|founder|president|proprietor|managing member/i.test(
        websiteFinding.title
      )
        ? "owner"
        : /general manager/i.test(websiteFinding.title)
          ? "general_manager"
          : /operations/i.test(websiteFinding.title)
            ? "operations_manager"
            : /office/i.test(websiteFinding.title)
              ? "office_manager"
              : "unknown_decision_maker",
      contact_source: "website",
      confidence: websiteFinding.confidence,
      verified_status: "verified_by_public_source",
      notes: `Found on ${websiteFinding.url}`,
    });
  } else if (named && named.full_name) {
    successLevel = "A";
    finalStatus = "decision_maker_found";
    confidence = 0.85;
    const title = named.title ? `, the ${named.title.toLowerCase()}` : "";
    const ext =
      "extension" in named && named.extension ? ` Extension ${named.extension}.` : "";
    const direct =
      "direct_phone" in named && named.direct_phone
        ? ` Direct line: ${named.direct_phone}.`
        : "";
    recommendedAsk = `Call the main line and ask for ${named.full_name}${title}.${ext}${direct}`;

    const d = discoveries?.[0];
    if (d?.best_callback_time) recommendedAsk += ` Best time: ${d.best_callback_time}.`;
    if (d?.transfer_instructions) recommendedAsk += ` ${d.transfer_instructions}`;

    await db.from("enrichment_evidence").insert({
      lead_id: leadId,
      source_type: "internal_db",
      field: "owner_name",
      value: named.full_name,
      supporting_text: "Reused from an existing contact or caller discovery",
      extraction_method: "deterministic",
      confidence,
    });
  } else {
    // Success Level C: no name, but the right role to ask for, and a working
    // main line. This is callable.
    recommendedAsk = roleBasedAsk(lead.industry);
    await db.from("enrichment_evidence").insert({
      lead_id: leadId,
      source_type: "internal_db",
      field: "role",
      value: findIndustry(lead.industry)?.askFor || "the owner",
      supporting_text: `Role-based ask derived from industry: ${lead.industry || "unknown"}`,
      extraction_method: "deterministic",
      confidence,
    });
  }

  // A lead with no usable phone is not callable at all.
  if (!lead.normalized_phone) {
    await db
      .from("leads")
      .update({
        machine_status: "enrichment_failed",
        qualification_failure_reason: "no usable main phone",
      })
      .eq("id", leadId);
    await db.from("enrichment_runs").insert({
      lead_id: leadId,
      steps_attempted: stepsAttempted,
      failure_reason: "no usable main phone",
      duration_ms: Date.now() - startedAt,
      finished_at: new Date().toISOString(),
    });
    return;
  }

  await db
    .from("leads")
    .update({
      machine_status: "ready_for_calling",
      recommended_ask: recommendedAsk,
      enrichment_confidence: confidence,
    })
    .eq("id", leadId);

  await db.from("enrichment_runs").insert({
    lead_id: leadId,
    steps_attempted: stepsAttempted,
    succeeded_at_step: websiteFinding ? stepsAttempted[stepsAttempted.length - 1] : "internal_db",
    success_level: successLevel,
    duration_ms: Date.now() - startedAt,
    finished_at: new Date().toISOString(),
  });

  await logEvent("lead.enriched", "lead", leadId, {
    success_level: successLevel,
    status: finalStatus,
    steps: stepsAttempted,
  });

  // Hand off to auto-assignment so packets build themselves.
  const campaignId = job.payload.campaign_id ? String(job.payload.campaign_id) : null;
  if (campaignId) {
    await enqueue({
      type: "auto_assign_packets",
      payload: { campaign_id: campaignId },
      // One pending assignment sweep at a time per campaign.
      idempotencyKey: `auto_assign_packets:${campaignId}:${Math.floor(Date.now() / 60000)}`,
      campaignId,
      priority: 300,
      runAfter: new Date(Date.now() + 5000),
    });
  }
};

/* ------------------------------------------------------------------ */
/* 7. auto_assign_packets — build caller packets with no manual step   */
/* ------------------------------------------------------------------ */

const autoAssignPackets: Handler = async (job) => {
  const campaignId = String(job.payload.campaign_id);
  const db = supabaseAdmin();
  const campaign = await getCampaign(campaignId);
  if (!campaign.auto_assign_packets) return;

  const { data: callers } = await db
    .from("callers")
    .select("id, name")
    .eq("active", true)
    .order("created_at");
  if (!callers || callers.length === 0) return; // nobody to assign to yet

  const packetSize = Math.max(1, campaign.packet_size || 50);

  // Distribute ready leads evenly, giving each caller work in turn.
  for (const caller of callers) {
    const { data: ready } = await db
      .from("leads")
      .select("id")
      .eq("sourcing_campaign_id", campaignId)
      .eq("status", "new")
      .eq("machine_status", "ready_for_calling")
      .eq("do_not_call", false)
      .is("archived_at", null)
      .order("created_at")
      .limit(packetSize);

    if (!ready || ready.length === 0) break;

    // Don't pile a second packet on a caller who still has open work.
    const { count: openPackets } = await db
      .from("packets")
      .select("*", { count: "exact", head: true })
      .eq("caller_id", caller.id)
      .eq("status", "open");
    if ((openPackets ?? 0) > 0) continue;

    const packetName = `${caller.name} — ${new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })} (${ready.length} leads)`;

    const { data: packet, error: pErr } = await db
      .from("packets")
      .insert({
        sourcing_campaign_id: campaignId,
        caller_id: caller.id,
        name: packetName,
      })
      .select("id")
      .single();
    if (pErr) throw new Error(`packet insert failed: ${pErr.message}`);

    const rows = ready.map((l, i) => ({
      packet_id: packet.id,
      lead_id: l.id,
      position: i + 1,
    }));
    const { error: plErr } = await db.from("packet_leads").insert(rows);
    if (plErr) {
      await db.from("packets").delete().eq("id", packet.id);
      throw new Error(`packet_leads insert failed: ${plErr.message}`);
    }

    await db
      .from("leads")
      .update({ status: "in_packet", machine_status: "assigned_to_packet" })
      .in("id", ready.map((l) => l.id));

    await bumpCampaign(campaignId, { packets_created: 1 });
    await logEvent("packet.created", "packet", packet.id, {
      campaign_id: campaignId,
      caller_id: caller.id,
      lead_count: ready.length,
      auto: true,
    });
  }
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
  auto_assign_packets: autoAssignPackets,
};
