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
  industry: string | null;
  rating: number | null;
  review_count: number | null;
  notes: string | null;
};

type Contact = {
  id: string;
  full_name: string | null;
  title: string | null;
  role_category: string;
  direct_phone: string | null;
  extension: string | null;
  email: string | null;
  contact_source: string;
  verified_status: string;
};

type HistoryRow = {
  outcome: string;
  notes: string | null;
  created_at: string;
  callers: { name: string } | null;
};

type NextResp = {
  caller: string;
  lead: Lead | null;
  contacts?: Contact[];
  discovery?: {
    best_callback_time: string | null;
    transfer_instructions: string | null;
    gatekeeper_name: string | null;
  } | null;
  history?: HistoryRow[];
  approach?: { route: string; text: string } | null;
  aiTip?: string | null;
  packetId?: string;
  remaining: number;
  error?: string;
};

const EMPTY_DISCOVERY = {
  owner_name: "",
  title: "",
  direct_number: "",
  extension: "",
  email: "",
  best_callback_time: "",
  transfer_instructions: "",
  gatekeeper_name: "",
};

export default function DialPage() {
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [state, setState] = useState<"login" | "loading" | "ready">("login");
  const [data, setData] = useState<NextResp | null>(null);
  const [notes, setNotes] = useState("");
  const [discovery, setDiscovery] = useState({ ...EMPTY_DISCOVERY });
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [logging, setLogging] = useState(false);

  async function fetchNext() {
    setState("loading");
    setNotes("");
    setDiscovery({ ...EMPTY_DISCOVERY });
    setShowDiscovery(false);
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
        discovery,
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
        <h1 style={{ marginBottom: 8 }}>Caller Sign-in</h1>
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
        <button
          className="btn"
          onClick={login}
          disabled={pin.length !== 6}
          style={{ width: "100%", justifyContent: "center" }}
        >
          Start dialing
        </button>
      </div>
    );
  }

  if (state === "loading" || !data) {
    return (
      <p className="muted" style={{ textAlign: "center", marginTop: 60 }}>
        Loading…
      </p>
    );
  }

  if (!data.lead) {
    return (
      <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center" }}>
        <h1 style={{ marginBottom: 12 }}>All done 🎉</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          No leads left in your packet, {data.caller}. Check with your admin for a
          new packet.
        </p>
        <button className="btn-ghost" onClick={logout}>
          Sign out
        </button>
      </div>
    );
  }

  const lead = data.lead;
  const contacts = data.contacts || [];
  const history = data.history || [];

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 14,
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 700 }}>{data.caller}</span>
        <span className="tag-dim">
          {data.remaining} lead{data.remaining === 1 ? "" : "s"} left
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={logout} style={{ padding: "4px 12px" }}>
          Sign out
        </button>
      </div>

      {/* Two columns on a desktop: everything you read on the left,
          everything you type on the right. No scrolling mid-call. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* ---------------- LEFT: who you are calling ---------------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 16,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <h1
                  style={{
                    marginBottom: 4,
                    textTransform: "none",
                    letterSpacing: 0,
                    fontSize: "1.35rem",
                  }}
                >
                  {lead.business_name}
                </h1>
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  {[lead.address, lead.city, lead.state].filter(Boolean).join(", ")}
                </p>
              </div>
              {lead.phone && (
                <a
                  href={`tel:${lead.phone}`}
                  style={{
                    fontSize: "1.7rem",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    lineHeight: 1.1,
                  }}
                >
                  {lead.phone}
                </a>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {lead.industry && <span className="tag-dim">{lead.industry}</span>}
              {lead.rating != null && (
                <span className="tag-dim">
                  ★ {lead.rating} ({lead.review_count} reviews)
                </span>
              )}
              {lead.website && (
                <a
                  className="tag-dim"
                  href={lead.website}
                  target="_blank"
                  rel="noreferrer"
                >
                  website ↗
                </a>
              )}
            </div>
          </div>

          {data.approach && (
            <div className="card" style={{ borderColor: "var(--amber-dim)" }}>
              <h3 style={{ color: "var(--amber)", marginBottom: 6 }}>
                Who to ask for
              </h3>
              <p style={{ fontSize: "1rem", lineHeight: 1.5 }}>{data.approach.text}</p>
            </div>
          )}

          {contacts.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Known contacts</h3>
              {contacts.map((c) => (
                <div
                  key={c.id}
                  style={{
                    padding: "8px 10px",
                    background: "var(--bg-inset)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    marginBottom: 6,
                    fontSize: "0.85rem",
                  }}
                >
                  <strong>{c.full_name || "(name unknown)"}</strong>
                  {c.title ? ` — ${c.title}` : ` — ${c.role_category.replace(/_/g, " ")}`}
                  {c.direct_phone && (
                    <>
                      {" · "}
                      <a href={`tel:${c.direct_phone}`}>{c.direct_phone}</a>
                    </>
                  )}
                  {c.extension && ` · ext ${c.extension}`}
                  {c.email && ` · ${c.email}`}
                  <span className="faint" style={{ marginLeft: 8 }}>
                    [{c.contact_source.replace(/_/g, " ")}]
                  </span>
                </div>
              ))}
            </div>
          )}

          {history.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Previous calls</h3>
              {history.map((h, i) => (
                <div key={i} className="faint" style={{ marginBottom: 4 }}>
                  {new Date(h.created_at).toLocaleDateString()} —{" "}
                  {h.outcome.replace(/_/g, " ")}
                  {h.callers?.name ? ` (${h.callers.name})` : ""}
                  {h.notes ? ` — ${h.notes.slice(0, 80)}` : ""}
                </div>
              ))}
            </div>
          )}

          {data.aiTip && (
            <div className="card">
              <h3 style={{ marginBottom: 8, color: "var(--text-dim)" }}>Call tip</h3>
              <p
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: "0.88rem",
                  lineHeight: 1.6,
                }}
              >
                {data.aiTip}
              </p>
            </div>
          )}
        </div>

        {/* ---------------- RIGHT: what you record ---------------- */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            position: "sticky",
            top: 16,
          }}
        >
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
                      : o.value === "do_not_call"
                        ? "btn-danger"
                        : "btn-ghost"
                  }
                  onClick={() => logOutcome(o.value)}
                  disabled={logging}
                  style={{ justifyContent: "center", padding: "10px 8px" }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3>Learned something?</h3>
              <button
                className="btn-ghost"
                style={{ padding: "3px 10px" }}
                onClick={() => setShowDiscovery(!showDiscovery)}
              >
                {showDiscovery ? "Hide" : "Open"}
              </button>
            </div>
            {showDiscovery && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginTop: 12,
                }}
              >
                <input
                  placeholder="Decision-maker name"
                  value={discovery.owner_name}
                  onChange={(e) =>
                    setDiscovery({ ...discovery, owner_name: e.target.value })
                  }
                />
                <input
                  placeholder="Their title"
                  value={discovery.title}
                  onChange={(e) => setDiscovery({ ...discovery, title: e.target.value })}
                />
                <input
                  placeholder="Direct number"
                  value={discovery.direct_number}
                  onChange={(e) =>
                    setDiscovery({ ...discovery, direct_number: e.target.value })
                  }
                />
                <input
                  placeholder="Extension"
                  value={discovery.extension}
                  onChange={(e) =>
                    setDiscovery({ ...discovery, extension: e.target.value })
                  }
                />
                <input
                  placeholder="Email"
                  value={discovery.email}
                  onChange={(e) => setDiscovery({ ...discovery, email: e.target.value })}
                />
                <input
                  placeholder="Best callback time"
                  value={discovery.best_callback_time}
                  onChange={(e) =>
                    setDiscovery({ ...discovery, best_callback_time: e.target.value })
                  }
                />
                <input
                  placeholder="Gatekeeper name"
                  value={discovery.gatekeeper_name}
                  onChange={(e) =>
                    setDiscovery({ ...discovery, gatekeeper_name: e.target.value })
                  }
                />
                <input
                  placeholder="Transfer instructions"
                  value={discovery.transfer_instructions}
                  onChange={(e) =>
                    setDiscovery({ ...discovery, transfer_instructions: e.target.value })
                  }
                />
              </div>
            )}
            <p className="faint" style={{ marginTop: 8 }}>
              Saved with the outcome — the team never has to rediscover it.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
