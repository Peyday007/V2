"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { SalesStage } from "@/lib/stages";
import { deriveLoadState, withCanonicalStages, LoadState } from "@/lib/loadState";

export type Lead = {
  id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  rating: number | null;
  review_count: number | null;
  status: string;
  pipeline_stage: SalesStage;
  do_not_call: boolean;
  archived_at: string | null;
  notes: string | null;
  created_at: string;
  /** True when the stored stage was not a recognized value. */
  stage_was_unrecognized?: boolean;
};

export type { LoadState };

export type ContactLite = { lead_id: string; full_name: string | null; title: string | null };

/**
 * Loads leads from the database as the single source of truth.
 *
 * Deliberate behavior:
 * - Supabase errors are surfaced, never converted into an empty board.
 * - The `contacts` join is a SEPARATE query, so a missing/failed contacts
 *   table degrades to "no DM names shown" instead of wiping every card.
 * - Unrecognized stage values are coerced to new_lead and flagged rather
 *   than silently dropped.
 */
export function useLeads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [contacts, setContacts] = useState<Record<string, ContactLite[]>>({});
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setState((prev) =>
      prev.status === "loading" ? prev : { status: "loading" }
    );

    try {
      const db = supabase();
      const { data, error } = await db
        .from("leads")
        .select(
          "id, business_name, phone, website, city, state, industry, rating, review_count, status, pipeline_stage, do_not_call, archived_at, notes, created_at"
        )
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(2000);

      if (error) {
        console.error("[useLeads] leads query failed:", error);
        setState(deriveLoadState(null, error));
        inflight.current = false;
        return;
      }

      const rows = withCanonicalStages(data || []) as unknown as Lead[];
      setLeads(rows);
      setLastFetchedAt(new Date().toISOString());
      setState(deriveLoadState(rows, null));

      // Contact names are a non-critical enhancement: a failure here must not
      // empty the board.
      const { data: contactRows, error: contactErr } = await db
        .from("contacts")
        .select("lead_id, full_name, title")
        .eq("active", true);
      if (contactErr) {
        console.warn("[useLeads] contacts unavailable:", contactErr.message);
        setContacts({});
      } else {
        const grouped: Record<string, ContactLite[]> = {};
        for (const c of contactRows || []) {
          (grouped[c.lead_id] ||= []).push(c as ContactLite);
        }
        setContacts(grouped);
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Unexpected error loading leads";
      console.error("[useLeads] unexpected:", e);
      setState({
        status: "error",
        message: /Missing NEXT_PUBLIC_SUPABASE/i.test(message)
          ? "This deployment has no Supabase credentials. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy."
          : `Could not load leads. ${message}`,
      });
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Live updates: any insert/update/delete on leads refreshes the board so
  // imports and call logging appear without a manual refresh.
  const [realtime, setRealtime] = useState(false);
  useEffect(() => {
    let channel: ReturnType<ReturnType<typeof supabase>["channel"]> | null = null;
    try {
      channel = supabase()
        .channel("leads-board")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "leads" },
          () => load()
        )
        .subscribe((status) => setRealtime(status === "SUBSCRIBED"));
    } catch {
      setRealtime(false);
    }
    return () => {
      if (channel) supabase().removeChannel(channel);
    };
  }, [load]);

  /** Optimistic local move; caller is responsible for persisting. */
  const applyStageLocally = useCallback((id: string, stage: SalesStage) => {
    setLeads((prev) =>
      prev.map((l) => (l.id === id ? { ...l, pipeline_stage: stage } : l))
    );
  }, []);

  return {
    leads,
    contacts,
    state,
    reload: load,
    applyStageLocally,
    lastFetchedAt,
    realtime,
  };
}
