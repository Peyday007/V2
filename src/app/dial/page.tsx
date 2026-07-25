"use client";

import { useEffect, useState } from "react";
import { CALL_OUTCOMES } from "@/lib/constants";

type Lead = {
  id: string;
  business_name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  rating: number | null;
  review_count: number | null;
  dm_name: string | null;
  dm_title: string | null;
  dm_phone: string | null;
  dm_email: string | null;
  notes: string | null;
};

type NextResp = {
  caller: string;
  lead: Lead | null;
  packetId?: string;
  approach?: string | null;
  remaining: number;
  error?: string;
};

export default function DialPage() {
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [state, setState] = useState<"login" | "loading" | "ready">("login");
  const [data, setData] = useState<NextResp | null>(null);
  const [notes, setNotes] = useState("");
  const [logging, setLogging] = useState(false);

  async function fetchNext() {
    setState("loading");
    setNotes("");
    const res = await fetch("/api/dial/next");
    if (res.status === 401) {
      setState("login");
      setData(null);
      return;
    }
    const json: NextResp = await res.json();
    setData(json);
    setState("ready");
  }

  useEffect(() => {
    fetchNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login() {
    setLoginError("");
    const res = await fetch("/api/caller/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (!res.ok) {
      const j = await res.json();
      setLoginError(j.error || "Login failed");
      return;
    }
    setPin("");
    fetchNext();
  }

  async function logOutcome(outcome: string) {
    if (!data?.lead) return;
    setLogging(true);
    await fetch("/api/dial/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: data.lead.id,
        packet_id: data.packetId,
        outcome,
        notes,
      }),
    });
    setLogging(false);
    fetchNext();
  }

  async function logout() {
    await fetch("/api/caller/logout", { method: "POST" });
    setState("login");
    setData(null);
  }

  if (state === "login") {
    return (
      <div style={{ maxWidth: 360, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ marginBottom: 8 }}>Caller sign-in</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          Enter your 6-digit PIN
        </p>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => e.key === "Enter" && pin.length === 6 && login()}
          placeholder="••••••"
          inputMode="numeric"
          autoFocus
          style={{
            textAlign: "center",
            fontSize: "1.6rem",
            letterSpacing: "0.4em",
            marginBottom: 12,
          }}
        />
        {loginError && (
          <p style={{ color: "var(--red)", marginBottom: 12 }}>{loginError}</p>
        )}
        <button className="btn" onClick={login} disabled={pin.length !== 6} style={{ width: "100%", justifyContent: "center" }}>
          Start dialing
        </button>
      </div>
    );
  }

  if (state === "loading" || !data) {
    return <p className="muted" style={{ textAlign: "center", marginTop: 60 }}>Loading…</p>;
  }

  if (!data.lead) {
    return (
      <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}>All done 🎉</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          No leads left in your packet, {data.caller}. Check with your admin for a new packet.
        </p>
        <button className="btn-ghost" onClick={logout}>Sign out</button>
      </div>
    );
  }

  const lead = data.lead;

  return (
    <div style={{ maxWidth: 640, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <span className="muted">
          {data.caller} · {data.remaining} lead{data.remaining === 1 ? "" : "s"} left
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={logout} style={{ padding: "4px 10px" }}>
          Sign out
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h1 style={{ marginBottom: 4 }}>{lead.business_name}</h1>
        <p className="muted" style={{ marginBottom: 12 }}>
          {[lead.address, lead.city, lead.state].filter(Boolean).join(", ")}
        </p>
        {lead.phone && (
          <a
            href={`tel:${lead.phone}`}
            style={{ fontSize: "1.5rem", fontWeight: 700, display: "block", marginBottom: 8 }}
          >
            {lead.phone}
          </a>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {lead.rating != null && (
            <span className="tag-dim">★ {lead.rating} ({lead.review_count} reviews)</span>
          )}
          {lead.website && (
            <a className="tag-dim" href={lead.website} target="_blank" rel="noreferrer">
              website ↗
            </a>
          )}
        </div>
        {lead.dm_name && (
          <div style={{ marginTop: 8, padding: 10, background: "var(--amber-soft)", borderRadius: 6 }}>
            <strong style={{ color: "var(--amber)" }}>Decision maker:</strong>{" "}
            {lead.dm_name}
            {lead.dm_title ? ` — ${lead.dm_title}` : ""}
            {lead.dm_phone ? ` · ${lead.dm_phone}` : ""}
            {lead.dm_email ? ` · ${lead.dm_email}` : ""}
          </div>
        )}
      </div>

      {data.approach && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--amber-dim)" }}>
          <h3 style={{ color: "var(--amber)", marginBottom: 6 }}>Approach</h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{data.approach}</p>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginBottom: 10 }}>Log outcome</h3>
        <textarea
          placeholder="Notes (optional)"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {CALL_OUTCOMES.map((o) => (
            <button
              key={o.value}
              className={
                o.value === "dm_conversation" || o.value === "appointment_set"
                  ? "btn"
                  : "btn-ghost"
              }
              onClick={() => logOutcome(o.value)}
              disabled={logging}
              style={{ justifyContent: "center" }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
