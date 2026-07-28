"use client";

import { useEffect, useState } from "react";
import { OUTCOME_FORMS } from "@/lib/outcomeForms";
import { whoToAskFor, callObjective, callScript, OBJECTIONS } from "@/lib/callGuidance";
import { timezoneForState, looksOpen } from "@/lib/callWindows";
import OutcomeModal from "@/components/OutcomeModal";

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
  owner_name?: string | null;
  owner_title?: string | null;
  gatekeeper_name?: string | null;
  best_call_day?: string | null;
  best_call_time?: string | null;
  direct_number?: string | null;
  extension?: string | null;
  answering_setup?: string | null;
  existing_provider?: string | null;
  other_decision_maker?: string | null;
  last_next_step?: string | null;
  last_objection?: string | null;
  owner_reached?: boolean;
  attempt_count?: number;
  timezone?: string | null;
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
  next_step?: string | null;
  spoke_with_role?: string | null;
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
  doneToday?: number;
  pendingCallback?: {
    scheduled_for: string;
    reason: string | null;
    requested_by_name: string | null;
  } | null;
  /** Set when this lead was served because a callback came due. */
  dueCallback?: { scheduled_for: string | null; reason: string | null } | null;
  callbacksWaiting?: number;
  error?: string;
};

export default function DialPage() {
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [state, setState] = useState<"login" | "loading" | "ready">("login");
  const [data, setData] = useState<NextResp | null>(null);
  const [logging, setLogging] = useState(false);
  const [pendingOutcome, setPendingOutcome] = useState<string | null>(null);
  const [intel, setIntel] = useState<Record<string, string>>({});
  const [showIntel, setShowIntel] = useState(false);
  const [showObjections, setShowObjections] = useState(false);
  const [openObjection, setOpenObjection] = useState<string | null>(null);
  const [scriptStep, setScriptStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState("");

  // Measured, not asked for. The caller never types a duration; the clock
  // starts when the lead appears and stops when the outcome is saved.
  const [startedAt, setStartedAt] = useState<string>(() => new Date().toISOString());
  const [elapsed, setElapsed] = useState(0);
  // Every objection the caller actually opened on this call, saved with the
  // outcome so objection effectiveness becomes measurable.
  const [raised, setRaised] = useState<
    { key: string; label: string; rebuttal_shown: boolean }[]
  >([]);

  useEffect(() => {
    if (state !== "ready") return;
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [state, startedAt]);

  async function fetchNext() {
    setState("loading");
    setIntel({});
    setPendingOutcome(null);
    setScriptStep(0);
    setOpenObjection(null);
    setRaised([]);
    setSkipping(false);
    setSkipReason("");
    setStartedAt(new Date().toISOString());
    setElapsed(0);
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

  async function logOutcome(
    outcome: string,
    values: Record<string, string>,
    confirmed: boolean
  ) {
    if (!data?.lead) return;
    setLogging(true);
    const res = await fetch("/api/dial/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: data.lead.id,
        packet_id: data.packetId,
        outcome,
        values,
        intel,
        confirmed,
        notes: values.note || "",
        started_at: startedAt,
        objections: raised,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || "Could not save that outcome.");
      setLogging(false);
      return;
    }
    setLogging(false);
    fetchNext();
  }

  // Native prompt() is blocked by some browsers and returns nothing, which
  // made Skip look like a dead button. Asked for in-page instead.
  async function skipLead(reason: string) {
    if (!reason.trim()) return;
    setSkipping(false);
    setLogging(true);
    await fetch("/api/dial/outcome", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: data?.lead?.id,
        packet_id: data?.packetId,
        outcome: "no_answer",
        values: { what_happened: "Other", note: `Skipped: ${reason.trim()}` },
        intel: {},
        confirmed: true,
        started_at: startedAt,
        objections: raised,
      }),
    }).catch(() => {});
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

  const intelLead = {
    owner_name: lead.owner_name ?? null,
    owner_title: lead.owner_title ?? null,
    extension: lead.extension ?? null,
    direct_number: lead.direct_number ?? null,
    best_call_day: lead.best_call_day ?? null,
    best_call_time: lead.best_call_time ?? null,
    gatekeeper_name: lead.gatekeeper_name ?? null,
    other_decision_maker: lead.other_decision_maker ?? null,
    owner_reached: !!lead.owner_reached,
    last_next_step: lead.last_next_step ?? null,
    attempt_count: lead.attempt_count ?? 0,
  };
  const ask = whoToAskFor(intelLead);
  const objective = callObjective(intelLead);
  const script = callScript(intelLead);

  const tz = lead.timezone || timezoneForState(lead.state);
  let localTime: string | null = null;
  let open: boolean | null = null;
  if (tz) {
    try {
      localTime = new Date().toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "2-digit",
      });
      const h = Number(
        new Date().toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false })
      );
      const d = new Date().getDay();
      open = looksOpen(h, d);
    } catch {
      localTime = null;
    }
  }

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{data.caller}</span>
        <span className="tag-dim">{data.remaining} left</span>
        {!!data.callbacksWaiting && data.callbacksWaiting > 0 && (
          <span className="tag" title="Callbacks that have come due. These are served first.">
            {data.callbacksWaiting} callback{data.callbacksWaiting === 1 ? "" : "s"} due
          </span>
        )}
        <span className="tag-dim">{data.doneToday ?? 0} done today</span>
        <span className="tag-dim">attempt #{(lead.attempt_count ?? 0) + 1}</span>
        <span className="tag-dim" title="Time on this lead. Saved automatically with the outcome.">
          {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
          {String(elapsed % 60).padStart(2, "0")}
        </span>
        {localTime && (
          <span className="tag-dim">
            local {localTime}
            {open === false ? " · likely closed" : open ? " · open" : ""}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          className="btn-ghost"
          onClick={() => setSkipping(true)}
          style={{ padding: "4px 12px" }}
        >
          Skip
        </button>
        <button className="btn-ghost" onClick={logout} style={{ padding: "4px 12px" }}>
          Sign out
        </button>
      </div>

      {data.dueCallback && (
        <div
          className="card"
          style={{
            marginBottom: 14,
            borderColor: "var(--amber)",
            background: "var(--amber-soft)",
          }}
        >
          <div style={{ fontWeight: 700, color: "var(--amber)" }}>
            ⏰ This is a callback you promised
          </div>
          <div style={{ fontSize: "0.85rem", marginTop: 4, lineHeight: 1.5 }}>
            Booked for{" "}
            {data.dueCallback.scheduled_for
              ? new Date(data.dueCallback.scheduled_for).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "earlier"}
            {data.dueCallback.reason ? ` — ${data.dueCallback.reason}` : ""}. They are
            expecting you, so open by referring back to it.
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.15fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        {/* -------------------- LEFT -------------------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ marginBottom: 4, textTransform: "none", letterSpacing: 0, fontSize: "1.35rem" }}>
                  {lead.business_name}
                </h1>
                <p className="muted" style={{ fontSize: "0.85rem" }}>
                  {[lead.address, lead.city, lead.state].filter(Boolean).join(", ")}
                </p>
              </div>
              {lead.phone && (
                <a href={`tel:${lead.phone}`} style={{ fontSize: "1.7rem", fontWeight: 700, whiteSpace: "nowrap", lineHeight: 1.1 }}>
                  {lead.phone}
                </a>
              )}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
              {lead.industry && <span className="tag-dim">{lead.industry}</span>}
              {lead.rating != null && (
                <span className="tag-dim">★ {lead.rating} ({lead.review_count})</span>
              )}
              <button
                className="tag-dim"
                style={{ border: "none", cursor: "pointer" }}
                onClick={() => {
                  if (lead.phone) navigator.clipboard?.writeText(lead.phone);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "copied ✓" : "copy number"}
              </button>
              {lead.website && (
                <a className="tag-dim" href={lead.website} target="_blank" rel="noreferrer">website ↗</a>
              )}
              <a
                className="tag-dim"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${lead.business_name} ${lead.address || ""}`
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                maps ↗
              </a>
            </div>
          </div>

          <div className="card" style={{ borderColor: "var(--amber-dim)" }}>
            <h3 style={{ color: "var(--amber)", marginBottom: 6 }}>Who to ask for</h3>
            <p style={{ fontSize: "1rem", lineHeight: 1.5 }}>{ask.text}</p>
            {ask.detail.length > 0 && (
              <div className="faint" style={{ marginTop: 8 }}>
                {ask.detail.join(" · ")}
              </div>
            )}
          </div>

          <div className="card">
            <h3 style={{ marginBottom: 6, color: "var(--text-dim)" }}>Call objective</h3>
            <p style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{objective}</p>
          </div>

          {data.aiTip && (
            <div className="card">
              <h3 style={{ marginBottom: 8, color: "var(--text-dim)" }}>AI call tip</h3>
              <p style={{ whiteSpace: "pre-wrap", fontSize: "0.88rem", lineHeight: 1.6 }}>
                {data.aiTip}
              </p>
            </div>
          )}

          {(history.length > 0 || data.pendingCallback) && (
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Previous activity</h3>
              {data.pendingCallback && (
                <div style={{ color: "var(--amber)", fontSize: "0.82rem", marginBottom: 8 }}>
                  Callback booked for{" "}
                  {new Date(data.pendingCallback.scheduled_for).toLocaleString()}
                  {data.pendingCallback.reason ? ` — ${data.pendingCallback.reason}` : ""}
                </div>
              )}
              {history.map((h, i) => (
                <div key={i} style={{ fontSize: "0.8rem", marginBottom: 8, lineHeight: 1.5 }}>
                  <span className="muted">
                    {new Date(h.created_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                  {" — "}
                  <strong>{h.outcome.replace(/_/g, " ")}</strong>
                  {h.callers?.name ? ` (${h.callers.name})` : ""}
                  {h.spoke_with_role && h.spoke_with_role !== "unknown" && (
                    <span className="faint"> · spoke with {h.spoke_with_role}</span>
                  )}
                  {h.next_step && (
                    <div style={{ color: "var(--amber)" }}>Next step: {h.next_step}</div>
                  )}
                  {h.notes && <div className="faint">{h.notes}</div>}
                </div>
              ))}
            </div>
          )}

          {(lead.owner_name ||
            lead.answering_setup ||
            lead.existing_provider ||
            lead.best_call_time) && (
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Known intelligence</h3>
              <div style={{ fontSize: "0.82rem", display: "grid", gap: 3 }}>
                {lead.owner_name && (
                  <div>
                    Owner identified: <strong>{lead.owner_name}</strong>
                    {lead.owner_title ? ` (${lead.owner_title})` : ""}
                  </div>
                )}
                {(lead.best_call_day || lead.best_call_time) && (
                  <div>
                    Best time to call:{" "}
                    <strong>
                      {[lead.best_call_day, lead.best_call_time].filter(Boolean).join(" ")}
                    </strong>
                  </div>
                )}
                {lead.answering_setup && <div>Current setup: {lead.answering_setup}</div>}
                {lead.existing_provider && <div>Existing provider: {lead.existing_provider}</div>}
                {lead.last_objection && <div>Last objection: {lead.last_objection}</div>}
              </div>
            </div>
          )}

          {contacts.length > 0 && (
            <div className="card">
              <h3 style={{ marginBottom: 8 }}>Contacts on file</h3>
              {contacts.map((c) => (
                <div key={c.id} className="faint" style={{ marginBottom: 4 }}>
                  {c.full_name || "(unknown)"}
                  {c.title ? ` — ${c.title}` : ""}
                  {c.direct_phone ? ` · ${c.direct_phone}` : ""}
                  {` [${c.contact_source.replace(/_/g, " ")}]`}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* -------------------- RIGHT -------------------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, position: "sticky", top: 16 }}>
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Log outcome</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {OUTCOME_FORMS.map((o) => (
                <button
                  key={o.value}
                  className={
                    o.value === "dm_conversation" || o.value === "appointment_set"
                      ? "btn"
                      : o.value === "do_not_call"
                        ? "btn-danger"
                        : "btn-ghost"
                  }
                  onClick={() => setPendingOutcome(o.value)}
                  disabled={logging}
                  style={{ justifyContent: "center", padding: "10px 8px" }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Script</h3>
              <button className="btn-ghost" style={{ padding: "3px 10px" }} onClick={() => setScriptStep((n) => (n + 1) % script.length)}>
                Next line
              </button>
            </div>
            <div style={{ marginTop: 10 }}>
              <div className="faint" style={{ marginBottom: 4 }}>
                {script[scriptStep].heading}
              </div>
              <p style={{ fontSize: "0.92rem", lineHeight: 1.5 }}>{script[scriptStep].line}</p>
            </div>
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>
                Objections
                {raised.length > 0 && (
                  <span className="faint" style={{ marginLeft: 8, textTransform: "none" }}>
                    {raised.length} logged
                  </span>
                )}
              </h3>
              <button className="btn-ghost" style={{ padding: "3px 10px" }} onClick={() => setShowObjections(!showObjections)}>
                {showObjections ? "Hide" : "Open"}
              </button>
            </div>
            {showObjections && (
              <div style={{ marginTop: 10, display: "grid", gap: 5 }}>
                {OBJECTIONS.map((o) => (
                  <div key={o.key}>
                    <button
                      className="btn-ghost"
                      style={{ width: "100%", justifyContent: "flex-start", padding: "5px 10px", fontSize: "0.72rem" }}
                      onClick={() => {
                        const opening = openObjection !== o.key;
                        setOpenObjection(opening ? o.key : null);
                        if (opening) {
                          setRaised((prev) =>
                            prev.some((r) => r.key === o.key)
                              ? prev
                              : [...prev, { key: o.key, label: o.label, rebuttal_shown: true }]
                          );
                        }
                      }}
                    >
                      {raised.some((r) => r.key === o.key) ? "• " : ""}
                      {o.label}
                    </button>
                    {openObjection === o.key && (
                      <div style={{ padding: "8px 10px", fontSize: "0.8rem", lineHeight: 1.5, background: "var(--bg-inset)", border: "1px solid var(--border)", borderRadius: 4, marginTop: 4 }}>
                        <div>{o.response}</div>
                        <div style={{ color: "var(--amber)", marginTop: 4 }}>{o.followUp}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3>Update lead intelligence</h3>
              <button className="btn-ghost" style={{ padding: "3px 10px" }} onClick={() => setShowIntel(!showIntel)}>
                {showIntel ? "Hide" : "Open"}
              </button>
            </div>
            {showIntel && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
                {INTEL_FIELDS.map((f) => (
                  <input
                    key={f.name}
                    placeholder={f.label}
                    value={intel[f.name] || ""}
                    onChange={(e) => setIntel({ ...intel, [f.name]: e.target.value })}
                  />
                ))}
              </div>
            )}
            <p className="faint" style={{ marginTop: 8 }}>
              Saved with the outcome — visible to every future caller.
            </p>
          </div>

        </div>
      </div>

      {skipping && (
        <div
          onClick={() => setSkipping(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
            padding: 20,
          }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 420, maxWidth: "94vw" }}
          >
            <h3 style={{ marginBottom: 10 }}>Why are you skipping this lead?</h3>
            <input
              value={skipReason}
              onChange={(e) => setSkipReason(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && skipReason.trim() && skipLead(skipReason)}
              placeholder="e.g. wrong industry, already a customer"
              autoFocus
              style={{ width: "100%", marginBottom: 12 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn"
                disabled={!skipReason.trim() || logging}
                onClick={() => skipLead(skipReason)}
              >
                Skip this lead
              </button>
              <button className="btn-ghost" onClick={() => setSkipping(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingOutcome && (
        <OutcomeModal
          outcome={pendingOutcome}
          defaults={{
            owner_name: lead.owner_name || "",
            dm_name: lead.owner_name || "",
            gatekeeper_name: lead.gatekeeper_name || "",
            phone: lead.phone || "",
          }}
          saving={logging}
          onCancel={() => setPendingOutcome(null)}
          onSave={(values, confirmed) => logOutcome(pendingOutcome, values, confirmed)}
        />
      )}
    </div>
  );
}

const INTEL_FIELDS = [
  { name: "owner_name", label: "Owner name" },
  { name: "owner_title", label: "Owner title" },
  { name: "gatekeeper_name", label: "Gatekeeper name" },
  { name: "best_call_day", label: "Best calling day" },
  { name: "best_call_time", label: "Best calling time" },
  { name: "direct_number", label: "Direct number" },
  { name: "extension", label: "Extension" },
  { name: "email", label: "Email" },
  { name: "answering_setup", label: "Current answering setup" },
  { name: "existing_provider", label: "Existing provider" },
  { name: "office_staff_count", label: "Office staff count" },
  { name: "after_hours_process", label: "After-hours process" },
  { name: "other_decision_maker", label: "Other decision-maker" },
  { name: "ownership_type", label: "Independent or franchise" },
  { name: "company_notes", label: "Other company info" },
];
