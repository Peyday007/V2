"use client";

import { useCallback, useEffect, useState } from "react";

// "Somebody agreed to a trial."
//
// This sits at the top of the board because of what it is: the only moment in
// the whole pipeline where a business owner has said yes and is waiting on a
// person. Everything else here can wait an hour; this cannot. It is deliberately
// not a number on a dashboard, not a row in a report, and not dismissible until
// somebody has actually picked it up.

type Waiting = {
  id: string;
  lead_id: string;
  status: string;
  owner_name: string | null;
  owner_phone: string | null;
  agreed_name: string | null;
  agreed_phone: string | null;
  agreed_email: string | null;
  sent_by_name: string | null;
  trial_requested_at: string | null;
  leads: { business_name: string; city: string | null; state: string | null } | null;
};

function one<T>(rel: T | T[] | null | undefined): T | null {
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}

/** How long they have been waiting, in the words a person would use. */
function waitedFor(iso: string | null): string {
  if (!iso) return "";
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default function TrialAlerts() {
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/workshop-packets");
      const j = await res.json();
      setWaiting(j.waiting ?? []);
      setError(j.error ?? null);
    } catch {
      // A failure here must never take the board down with it. The board is
      // the app's front door and this is one strip at the top of it.
      setWaiting([]);
    }
  }, []);

  useEffect(() => {
    load();
    // Polled rather than realtime: this is a handful of rows a day, and a
    // subscription is a lot of machinery for a banner.
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  async function acknowledge(id: string) {
    setBusy(id);
    await fetch("/api/workshop-packets", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    setBusy(null);
    load();
  }

  // The migration hint is worth showing; anything else is noise on the board.
  if (waiting.length === 0) {
    return error && /migration/i.test(error) ? (
      <div className="card" style={{ borderColor: "var(--red)", marginBottom: 14, flexShrink: 0 }}>
        <p style={{ color: "var(--red)", fontSize: "0.82rem" }}>{error}</p>
      </div>
    ) : null;
  }

  return (
    <div
      style={{
        border: "2px solid var(--amber)",
        background: "var(--amber-soft)",
        borderRadius: 4,
        padding: "14px 16px",
        marginBottom: 14,
        flexShrink: 0,
      }}
    >
      <div style={{ fontWeight: 700, color: "var(--amber)", marginBottom: 10 }}>
        {waiting.length === 1
          ? "Somebody agreed to a trial"
          : `${waiting.length} people agreed to a trial`}{" "}
        — waiting on you
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {waiting.map((w) => {
          const lead = one(w.leads);
          const name = w.agreed_name || w.owner_name || "";
          const phone = w.agreed_phone || w.owner_phone || "";
          return (
            <div
              key={w.id}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "baseline",
                flexWrap: "wrap",
                borderTop: "1px solid var(--amber-dim)",
                paddingTop: 9,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 700 }}>
                  {lead?.business_name || "A business"}
                  {lead?.city ? ` · ${lead.city}` : ""}
                </div>
                <div style={{ fontSize: "0.85rem", lineHeight: 1.55, marginTop: 2 }}>
                  {name}
                  {phone && (
                    <>
                      {" — "}
                      <a href={`tel:${phone}`} style={{ fontWeight: 700 }}>
                        {phone}
                      </a>
                    </>
                  )}
                  {w.agreed_email ? ` · ${w.agreed_email}` : ""}
                </div>
                <div className="faint" style={{ marginTop: 2 }}>
                  {waitedFor(w.trial_requested_at)}
                  {w.sent_by_name ? ` · sent by ${w.sent_by_name}` : ""}
                </div>
              </div>
              <a className="btn-ghost" href={`/admin/leads/${w.lead_id}`}>
                Open the record
              </a>
              <button
                className="btn"
                disabled={busy === w.id}
                onClick={() => acknowledge(w.id)}
                title="Clears it off this list. The trial request itself is not changed."
              >
                {busy === w.id ? "…" : "I've got this"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
