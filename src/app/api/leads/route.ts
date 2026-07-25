import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { logEvent } from "@/lib/events";
import {
  normalizeBusinessName,
  normalizeDomain,
  normalizePhone,
  normalizeState,
} from "@/lib/normalize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { business_name, phone, website, city, state, industry, notes, stage } = body;
  if (!business_name?.trim()) {
    return NextResponse.json({ error: "Business name required" }, { status: 400 });
  }
  const { data, error } = await supabase()
    .from("leads")
    .insert({
      business_name: business_name.trim(),
      normalized_name: normalizeBusinessName(business_name),
      phone: phone || null,
      normalized_phone: normalizePhone(phone),
      website: website || null,
      domain: normalizeDomain(website),
      city: city || null,
      state: normalizeState(state) || state || null,
      industry: industry || null,
      notes: notes || null,
      stage: stage || "New Lead",
      source: "manual",
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await logEvent("lead.created", "lead", data.id, {
    business_name: data.business_name,
    source: "manual",
  });
  return NextResponse.json(data);
}
