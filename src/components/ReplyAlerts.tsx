"use client";

import { useCallback, useEffect, useState } from "react";

// "Somebody replied to a cold email."
//
// One strip, on the board, for the same reason TrialAlerts is there: a reply
// is a person who answered, and it goes stale in hours. Burying it on the
// Email page would mean it is seen when somebody happens to visit that page,
// which is not a plan.
//
// Deliberately smaller and quieter than TrialAlerts. A trial agreement is
// somebody saying yes; a reply is somebody saying something. Both need a human,
// but only one of them needs the top of the board in a box with a thick border.

type Waiting = {
  id: string;
  intent: string | null;
  intent_label: string | null;
  created_at: string;
  lead: { id: string; business_name: string; city: string | null } | null;
};

function waitedFor(iso: string): string {
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function ReplyAlerts() {
  const [waiting, setWaiting] = useState<Waiting[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/instantly/drafts?status=pending");
      const j = await res.json();
      setWaiting(j.drafts ?? []);
    } catch {
      // Never take the board down for a banner. A missing table before
      // migration 0029 is run lands here and is correctly silent — the Email
      // page is where that gets explained, not the front door.
      setWaiting([]);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (waiting.length === 0) return null;

  return (
    <div
      style={{
        border: "1px solid var(--amber-dim)",
        borderLeft: "3px solid var(--amber)",
        borderRadius: 4,
        padding: "11px 14px",
        marginBottom: 14,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, color: "var(--amber)" }}>
          {waiting.length === 1 ? "1 email reply" : `${waiting.length} email replies`} waiting on
          you
        </span>
        <span className="faint" style={{ fontSize: "0.8rem", minWidth: 0, flex: 1 }}>
          {waiting
            .slice(0, 3)
            .map(
              (w) =>
                `${w.lead?.business_name || "a business"} (${(
                  w.intent_label || w.intent || "reply"
                ).toLowerCase()}, ${waitedFor(w.created_at)})`
            )
            .join(" · ")}
          {waiting.length > 3 ? ` · and ${waiting.length - 3} more` : ""}
        </span>
        <a className="btn-ghost" href="/admin/email#replies">
          Answer them
        </a>
      </div>
    </div>
  );
}
