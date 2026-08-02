"use client";

import { useCallback, useEffect, useState } from "react";

type Rel<T> = T | T[] | null;

type Suppression = {
  id: string;
  lead_id: string | null;
  normalized_phone: string | null;
  requested_by: string | null;
  reason: string | null;
  note: string | null;
  source: string | null;
  created_at: string;
  leads: Rel<{ business_name: string; city: string | null; state: string | null }>;
};

function one<T>(rel: Rel<T>): T | null {
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

function formatPhone(p: string | null): string {
  if (!p || p.length !== 10) return p || "—";
  return `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}`;
}

export default function SuppressionsPage() {
  const [rows, setRows] = useState<Suppression[] | null>(null);
  const [covers, setCovers] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/suppressions");
    const json = await res.json();
    if (!res.ok || json.error) {
      setError(json.error || "Could not load the do-not-call list.");
      setRows([]);
      return;
    }
    setError(null);
    setRows(json.suppressions || []);
    setCovers(json.covers || {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    setSaving(true);
    setResult(null);
    const res = await fetch("/api/suppressions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, reason, requested_by: "Owner / decision-maker" }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      setResult(json.error || "Could not add that number.");
      return;
    }
    setResult(
      `${formatPhone(json.phone)} added. ${json.leads_suppressed} lead record${
        json.leads_suppressed === 1 ? "" : "s"
      } suppressed and removed from open packets.`
    );
    setPhone("");
    setReason("");
    load();
  }

  return (
    <div style={{ maxWidth: 950, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Do not call</h1>
      <p className="faint" style={{ marginBottom: 24, lineHeight: 1.6 }}>
        Matched on the <strong>phone number</strong>, not on a lead record. The
        same business is routinely in the database more than once — imported
        twice, sourced under two trades — so suppressing one record would leave
        the duplicates dialable. Every lead sharing a listed number is blocked
        from packets, pulled out of any packet it is already in, and re-checked
        the moment before it would reach a caller&apos;s screen.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 20 }}>
          {error}
        </div>
      )}

      <div className="card" style={{ marginBottom: 28 }}>
        <h3 style={{ marginBottom: 10 }}>Add a number by hand</h3>
        <p className="faint" style={{ marginBottom: 10 }}>
          For a request that did not come in on a call — an email, a letter, a
          voicemail.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="Phone number"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            style={{ flex: "0 1 200px" }}
          />
          <input
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ flex: 1, minWidth: 180 }}
          />
          <button className="btn" onClick={add} disabled={saving || !phone.trim()}>
            {saving ? "Adding…" : "Add to do-not-call"}
          </button>
        </div>
        {result && (
          <p style={{ marginTop: 10, color: "var(--amber)", fontSize: "0.85rem" }}>{result}</p>
        )}
      </div>

      <h2 style={{ marginBottom: 10 }}>
        On the list{rows ? ` (${rows.length})` : ""}
      </h2>
      {rows === null ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">
          Nothing suppressed yet. Numbers land here when a caller logs a Do Not
          Call outcome, or when you add one above.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Business</th>
              <th>Records covered</th>
              <th>Requested by</th>
              <th>Reason</th>
              <th>Source</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const lead = one(s.leads);
              const covered = s.normalized_phone ? covers[s.normalized_phone] || 0 : 0;
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{formatPhone(s.normalized_phone)}</td>
                  <td>
                    {lead?.business_name || <span className="faint">not linked to a lead</span>}
                    {lead?.city && (
                      <span className="faint">
                        {" "}
                        · {lead.city}, {lead.state || ""}
                      </span>
                    )}
                  </td>
                  <td style={{ color: covered > 1 ? "var(--amber)" : undefined, fontWeight: covered > 1 ? 600 : undefined }}>
                    {covered}
                  </td>
                  <td className="faint">{s.requested_by || "unknown"}</td>
                  <td className="faint">{s.reason || "—"}</td>
                  <td className="faint">{s.source === "manual" ? "added by hand" : "logged on a call"}</td>
                  <td className="faint">
                    {new Date(s.created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="faint" style={{ marginTop: 20, lineHeight: 1.6 }}>
        Entries are never removed from this page. A suppression outlives the
        lead it came from — deleting a lead no longer deletes the request.
      </p>
    </div>
  );
}
