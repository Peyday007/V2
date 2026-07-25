import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";
import { parseCsv, IMPORTABLE_FIELDS } from "@/lib/csv";
import {
  normalizeBusinessName,
  normalizeDomain,
  normalizePhone,
  normalizeState,
  normalizeZip,
} from "@/lib/normalize";

export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  const mappingRaw = form.get("mapping");
  const campaignId = form.get("campaign_id");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (10 MB max)" }, { status: 413 });
  }
  let mapping: Record<string, string>;
  try {
    mapping = JSON.parse(String(mappingRaw));
  } catch {
    return NextResponse.json({ error: "Invalid mapping" }, { status: 400 });
  }
  const invalid = Object.values(mapping).filter(
    (f) => !(IMPORTABLE_FIELDS as readonly string[]).includes(f)
  );
  if (invalid.length) {
    return NextResponse.json({ error: `Unknown fields: ${invalid.join(", ")}` }, { status: 400 });
  }
  if (!Object.values(mapping).includes("business_name")) {
    return NextResponse.json({ error: "Mapping must include business_name" }, { status: 400 });
  }

  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
  }
  const headers = rows[0].map((h) => h.trim());

  const db = supabase();

  // Existing matching keys (leads table is small at this scale).
  const { data: existing } = await db
    .from("leads")
    .select("id, normalized_phone, domain, place_id");
  const byPhone = new Map<string, string>();
  const byDomain = new Map<string, string>();
  const byPlaceId = new Map<string, string>();
  for (const l of existing || []) {
    if (l.normalized_phone) byPhone.set(l.normalized_phone, l.id);
    if (l.domain) byDomain.set(l.domain, l.id);
    if (l.place_id) byPlaceId.set(l.place_id, l.id);
  }

  let created = 0;
  let duplicates = 0;
  let errorRows = 0;
  const errors: { line: number; error: string }[] = [];

  for (let r = 1; r < rows.length; r++) {
    const line = r + 1;
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => (raw[h] = (rows[r][i] || "").trim()));

    const row: Record<string, string> = {};
    for (const [header, field] of Object.entries(mapping)) {
      row[field] = raw[header] || "";
    }

    const name = row.business_name;
    if (!name) {
      errorRows++;
      errors.push({ line, error: "missing business_name" });
      continue;
    }

    const normPhone = normalizePhone(row.phone);
    const normDomain = normalizeDomain(row.website);
    const sourceId = row.source_id || null;

    let existingId: string | null = null;
    let reason: string | null = null;
    if (normPhone && byPhone.has(normPhone)) {
      existingId = byPhone.get(normPhone)!;
      reason = `same phone ${normPhone}`;
    } else if (normDomain && byDomain.has(normDomain)) {
      existingId = byDomain.get(normDomain)!;
      reason = `same domain ${normDomain}`;
    } else if (sourceId && byPlaceId.has(sourceId)) {
      existingId = byPlaceId.get(sourceId)!;
      reason = `same source id ${sourceId}`;
    }

    if (existingId) {
      await db.from("source_records").insert({
        lead_id: existingId,
        filename: file.name,
        raw_data: raw,
        duplicate_of_existing: true,
        duplicate_reason: reason,
      });
      duplicates++;
      continue;
    }

    const rating = row.rating ? Number(row.rating) : null;
    const reviewCount = row.review_count ? parseInt(row.review_count, 10) : null;

    const { data: lead, error } = await db
      .from("leads")
      .insert({
        campaign_id: campaignId ? String(campaignId) : null,
        business_name: name,
        normalized_name: normalizeBusinessName(name),
        phone: row.phone || null,
        normalized_phone: normPhone,
        website: row.website || null,
        domain: normDomain,
        address: row.address || null,
        city: row.city || null,
        state: normalizeState(row.state) || row.state || null,
        zip: normalizeZip(row.zip),
        industry: row.industry || null,
        rating: rating != null && !Number.isNaN(rating) ? rating : null,
        review_count:
          reviewCount != null && !Number.isNaN(reviewCount) ? reviewCount : null,
        place_id: sourceId,
        source: row.source || "csv_import",
      })
      .select("id")
      .single();

    if (error) {
      errorRows++;
      errors.push({ line, error: error.message });
      continue;
    }

    await db.from("source_records").insert({
      lead_id: lead.id,
      filename: file.name,
      raw_data: raw,
    });
    await logEvent("lead.created", "lead", lead.id, {
      business_name: name,
      source: "csv_import",
      filename: file.name,
    });

    if (normPhone) byPhone.set(normPhone, lead.id);
    if (normDomain) byDomain.set(normDomain, lead.id);
    if (sourceId) byPlaceId.set(sourceId, lead.id);
    created++;
  }

  await logEvent("import.completed", "campaign", campaignId ? String(campaignId) : null, {
    filename: file.name,
    total_rows: rows.length - 1,
    created,
    duplicates,
    errors: errorRows,
  });

  return NextResponse.json({
    filename: file.name,
    total_rows: rows.length - 1,
    created,
    duplicates,
    error_rows: errorRows,
    errors: errors.slice(0, 50),
  });
}
