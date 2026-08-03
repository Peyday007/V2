"use client";

// The call screen.
//
// It answers three questions and refuses the rest:
//
//   Who am I calling?    the header
//   What do I say next?  the guided call
//   What happened?       the outcome bar, always on screen
//
// Everything else — research, history, AI notes, what the last caller learned
// — is real and occasionally useful, so it lives one click away in Lead
// details rather than competing with the conversation.
//
// What was deliberately removed: "Why this one now" and its business-hours
// counts (the packet already decided, and the caller cannot act on it), the
// thirteen call-stage buttons (inferred now — see inferStage), the assistant's
// used/dismissed/star controls (grading software mid-call), and the permanent
// "Recording off" card (a pill in the header).

import { useCallback, useEffect, useState } from "react";
import CallRecorder from "@/components/CallRecorder";
import { OUTCOME_FORM_MAP } from "@/lib/outcomeForms";
import { OBJECTIONS } from "@/lib/callGuidance";
import { timezoneForState, looksOpen } from "@/lib/callWindows";
import { PHONE_CLASS_LABEL, formatUs, type PhoneClass } from "@/lib/phoneIntel";
import { CONTACT_OUTCOMES, CONTACT_OUTCOME_LABEL, type ContactOutcome } from "@/lib/contactFeedback";
import {
  PRIMARY_OUTCOMES,
  MORE_OUTCOMES,
  SPEAKING_WITH_LABEL,
  attemptSummary,
  guidedCall,
  inferStage,
  likelyOutcome,
  spokeWithRoleFor,
  type SpeakingWith,
} from "@/lib/dialerFocus";
import {
  SCRIPT_VERSIONS,
  applyScript,
  buildScript,
  type ScriptVersion,
} from "@/lib/gatekeeperScripts";
import OutcomeModal from "@/components/OutcomeModal";
import LiveAssistant from "@/components/LiveAssistant";
import PacketPanel from "@/components/PacketPanel";
import CallerUpdates from "@/components/CallerUpdates";

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

  /* --- owner enrichment (migration 0023) --- */
  decision_maker_name?: string | null;
  decision_maker_title?: string | null;
  decision_maker_role?: string | null;
  decision_maker_confidence?: number | null;
  decision_maker_source_url?: string | null;
  decision_maker_evidence?: string | null;
  direct_phone?: string | null;
  direct_phone_class?: string | null;
  direct_phone_confidence?: number | null;
  direct_phone_provider?: string | null;
  main_business_phone?: string | null;
  enrichment_grade?: string | null;
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

type Dossier = {
  status: string;
  people: string[];
  theirSituation: string[];
  statedProblems: string[];
  pitched: string[];
  resistance: string[];
  promises: string[];
  commitments: string[];
  gaps: string[];
  hasSubstance: boolean;
};

type NextResp = {
  caller: string;
  lead: Lead | null;
  contacts?: Contact[];
  history?: HistoryRow[];
  aiTip?: string | null;
  dossier?: Dossier | null;
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
  const [showObjections, setShowObjections] = useState(false);
  const [openObjection, setOpenObjection] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [lineIndex, setLineIndex] = useState(0);
  const [speakingWith, setSpeakingWith] = useState<SpeakingWith>("nobody");
  const [copied, setCopied] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  // Set when a room recording finishes. The calls row does not exist until the
  // outcome is saved, so the recording is linked to the call at that moment.
  const [recordingId, setRecordingId] = useState<string | null>(null);
  // What the caller found out about the enriched contact details. Separate
  // from the call outcome: "wrong number" is a fact about the data, not about
  // how the conversation went.
  const [showContactFeedback, setShowContactFeedback] = useState(false);
  const [contactNote, setContactNote] = useState("");
  // Which gatekeeper opener this caller is running. Sticky across leads on
  // purpose: a version picked per-call would be picked at random, and the
  // comparison would measure nothing but the caller's mood.
  const [scriptVersion, setScriptVersion] = useState<ScriptVersion | null>(null);
  const [showPacket, setShowPacket] = useState(false);

  // Measured, not asked for. The caller never types a duration; the clock
  // starts when the lead appears and stops when the outcome is saved.
  const [startedAt, setStartedAt] = useState<string>(() => new Date().toISOString());
  const [elapsed, setElapsed] = useState(0);
  // Every objection the caller actually opened on this call, saved with the
  // outcome so objection effectiveness becomes measurable.
  const [raised, setRaised] = useState<
    { key: string; label: string; rebuttal_shown: boolean }[]
  >([]);

  const onRecordingChange = useCallback((id: string | null) => setRecordingId(id), []);

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
    setLineIndex(0);
    setSpeakingWith("nobody");
    setOpenObjection(null);
    setShowObjections(false);
    setShowMore(false);
    setShowDetails(false);
    setShowContactFeedback(false);
    setContactNote("");
    setShowPacket(false);
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
    confirmed: boolean,
    intelValues: Record<string, string>
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
        intel: intelValues,
        confirmed,
        notes: values.note || "",
        started_at: startedAt,
        objections: raised,
        // Worked out from who picked up and what came up, rather than asked
        // for. See inferStage.
        call_stage: stage,
        spoke_with_role: spokeWithRoleFor(speakingWith),
        recording_id: recordingId,
        // Null when the caller has not opted into the test. Recording an
        // untagged call as a fourth variant would poison the comparison.
        script_version: scriptVersion,
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

  /**
   * The caller dialled the enriched number and found out something about it.
   * Sent separately from the outcome because it corrects the DATA — confidence
   * drops, a bad number stops being handed out, and the lead is re-graded,
   * which can take it out of the direct queue on the spot.
   */
  async function reportContact(outcome: ContactOutcome) {
    if (!data?.lead) return;
    setShowContactFeedback(false);
    await fetch("/api/dial/contact-feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: data.lead.id,
        outcome,
        phone_dialed: data.lead.direct_phone ?? data.lead.phone,
        note: contactNote,
      }),
    }).catch(() => {});
    setContactNote("");
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
        {loginError && <p style={{ color: "var(--red)", marginBottom: 12 }}>{loginError}</p>}
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
      <div style={{ maxWidth: 700, margin: "60px auto" }}>
        {/*
          The updates belong here too.

          This branch returns early, so without it a caller who has finished
          their packet — or who signs in before one has been built — sees
          nothing at all. That is exactly the person most likely to be reading
          the board and asking what to do next.
        */}
        <CallerUpdates />
        <div style={{ textAlign: "center", marginTop: 30 }}>
          {/*
            Only celebrate a real finish.
            
            "All done 🎉" used to show whenever no lead could be served, for any
            reason, so a fault looked exactly like a completed packet and the
            caller signed out on a packet with leads still in it.
          */}
          {data.error ? (
            <>
              <h1 style={{ marginBottom: 12, color: "var(--red)" }}>
                Something is wrong
              </h1>
              <p style={{ marginBottom: 8, lineHeight: 1.6, maxWidth: 520, margin: "0 auto 8px" }}>
                {data.error}
              </p>
              {data.remaining > 0 && (
                <p className="muted" style={{ marginBottom: 20 }}>
                  {data.remaining} lead{data.remaining === 1 ? "" : "s"} still in your packet.
                </p>
              )}
              <button className="btn" onClick={fetchNext} style={{ marginRight: 8 }}>
                Try again
              </button>
            </>
          ) : (
            <>
              <h1 style={{ marginBottom: 12 }}>All done 🎉</h1>
              <p className="muted" style={{ marginBottom: 20 }}>
                No leads left in your packet, {data.caller}. Check with your admin for
                a new packet.
              </p>
            </>
          )}
          <button className="btn-ghost" onClick={logout}>
            Sign out
          </button>
        </div>
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

  const guide = guidedCall(intelLead, speakingWith);

  // The gatekeeper script under test replaces the opener and the pushback
  // line, and only until the owner is on the phone. Everything after that is
  // the same for all three versions, so a difference in the numbers can only
  // have come from the opener.
  const activeScript = scriptVersion
    ? buildScript(scriptVersion, {
        ownerName: lead.decision_maker_name || lead.owner_name,
        businessName: lead.business_name,
        callerName: data.caller,
        reviewCount: lead.review_count,
      })
    : null;
  const lines = applyScript(guide.lines, activeScript, speakingWith === "owner");
  const currentLine = lines[Math.min(lineIndex, lines.length - 1)];
  const lastObjection = raised[raised.length - 1]?.key ?? null;
  const stage = inferStage({
    speakingWith,
    objectionKey: openObjection || lastObjection,
    ownerReachedBefore: !!lead.owner_reached,
    lineIndex,
  });
  const suggested = likelyOutcome(speakingWith);

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
      open = looksOpen(h, new Date().getDay());
    } catch {
      localTime = null;
    }
  }

  const detailCount =
    (data.aiTip ? 1 : 0) +
    (data.dossier?.hasSubstance ? 1 : 0) +
    (history.length > 0 ? 1 : 0) +
    (contacts.length > 0 ? 1 : 0);

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", paddingBottom: 96 }}>
      {/* ============================ session bar ============================ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 12,
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 700 }}>{data.caller}</span>
        <span className="tag-dim">{data.remaining} left</span>
        <span className="tag-dim">{data.doneToday ?? 0} done today</span>
        {!!data.callbacksWaiting && data.callbacksWaiting > 0 && (
          <span className="tag" title="Callbacks that have come due. These are served first.">
            {data.callbacksWaiting} callback{data.callbacksWaiting === 1 ? "" : "s"} due
          </span>
        )}
        <span className="tag-dim" title="Time on this lead. Saved automatically.">
          {String(Math.floor(elapsed / 60)).padStart(2, "0")}:
          {String(elapsed % 60).padStart(2, "0")}
        </span>
        <CallRecorder leadId={lead.id} onRecordingChange={onRecordingChange} />
        <div style={{ flex: 1 }} />
        <button className="btn-ghost" onClick={() => setSkipping(true)} style={{ padding: "4px 12px" }}>
          Skip
        </button>
        <button className="btn-ghost" onClick={logout} style={{ padding: "4px 12px" }}>
          Sign out
        </button>
      </div>

      {/* Unread process updates open themselves here, above the lead. The brief
          asked for impossible-to-miss on login, and a badge alone is something
          people learn to scroll past. */}
      <CallerUpdates />

      {data.dueCallback && (
        <div
          className="card"
          style={{ marginBottom: 12, borderColor: "var(--amber)", background: "var(--amber-soft)" }}
        >
          <div style={{ fontWeight: 700, color: "var(--amber)" }}>
            ⏰ You promised to call them back
          </div>
          <div style={{ fontSize: "0.85rem", marginTop: 3, lineHeight: 1.5 }}>
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
            {data.dueCallback.reason ? ` — ${data.dueCallback.reason}` : ""}. Open by
            referring back to it.
          </div>
        </div>
      )}

      {/* ========================== 1. who am I calling ======================= */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 20,
          flexWrap: "wrap",
          paddingBottom: 12,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1
            style={{
              marginBottom: 3,
              textTransform: "none",
              letterSpacing: 0,
              fontSize: "1.5rem",
            }}
          >
            {lead.business_name}
          </h1>
          {/* The person this number is supposed to reach. Named before the
              business detail, because it is what the caller says first. */}
          {lead.decision_maker_name && (
            <div style={{ marginBottom: 4, color: "var(--amber)", fontWeight: 600 }}>
              {lead.decision_maker_name}
              {lead.decision_maker_title ? ` — ${lead.decision_maker_title}` : ""}
              {lead.decision_maker_confidence != null && (
                <span className="faint" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {Math.round(lead.decision_maker_confidence * 100)}% confident
                </span>
              )}
            </div>
          )}
          <div
            className="faint"
            style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
          >
            <Meta>{[lead.city, lead.state].filter(Boolean).join(", ")}</Meta>
            {localTime && (
              <Meta color={open === false ? "var(--red)" : undefined}>
                {localTime} their time{open === false ? ", likely closed" : ""}
              </Meta>
            )}
            <Meta>{attemptSummary(lead.attempt_count ?? 0, !!lead.owner_reached)}</Meta>
            {lead.enrichment_grade && <Meta>grade {lead.enrichment_grade}</Meta>}
            {lead.industry && <Meta>{lead.industry}</Meta>}
            {lead.rating != null && (
              <Meta>
                ★ {lead.rating} ({lead.review_count})
              </Meta>
            )}
            <span style={{ display: "flex", gap: 10 }}>
              {lead.website && (
                <a href={lead.website} target="_blank" rel="noreferrer">
                  website ↗
                </a>
              )}
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                  `${lead.business_name} ${lead.address || ""}`
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                maps ↗
              </a>
            </span>
          </div>
        </div>

        <div style={{ textAlign: "right", minWidth: 260 }}>
          {/* The direct number leads. Reaching a switchboard is the failure this
              whole pipeline exists to prevent, so the main line is a fallback
              and is labelled as one. */}
          {lead.direct_phone ? (
            <>
              <a
                href={`tel:${lead.direct_phone}`}
                style={{ fontSize: "1.8rem", fontWeight: 700, whiteSpace: "nowrap", lineHeight: 1.1 }}
              >
                {formatUs(lead.direct_phone) ?? lead.direct_phone}
              </a>
              <div className="faint" style={{ marginTop: 2 }}>
                {PHONE_CLASS_LABEL[(lead.direct_phone_class as PhoneClass) ?? "unknown"]}
                {lead.direct_phone_confidence != null &&
                  ` · ${Math.round(lead.direct_phone_confidence * 100)}% confident`}
              </div>
            </>
          ) : (
            lead.phone && (
              <a
                href={`tel:${lead.phone}`}
                style={{ fontSize: "1.8rem", fontWeight: 700, whiteSpace: "nowrap", lineHeight: 1.1 }}
              >
                {lead.phone}
              </a>
            )
          )}

          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 4, flexWrap: "wrap" }}>
            <button
              className="tag-dim"
              style={{ border: "none", cursor: "pointer" }}
              onClick={() => {
                const n = lead.direct_phone || lead.phone;
                if (n) navigator.clipboard?.writeText(n);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "copied ✓" : "copy number"}
            </button>
            {lead.direct_phone && lead.phone && (
              <a className="tag-dim" href={`tel:${lead.phone}`} title="Main business line — fallback only">
                main line {lead.phone}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* ======================= 2. what do I say next ======================= */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: showDetails ? "minmax(0, 1.4fr) minmax(0, 1fr)" : "1fr",
          gap: 18,
          alignItems: "start",
          marginTop: 16,
        }}
      >
        <div>
          {/* who picked up — the one question worth asking, because it changes
              both the next line and what gets saved */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="faint">On the phone:</span>
            {(["nobody", "gatekeeper", "owner"] as SpeakingWith[]).map((w) => (
              <button
                key={w}
                onClick={() => {
                  setSpeakingWith(w);
                  setLineIndex(0);
                }}
                style={{
                  padding: "4px 12px",
                  borderRadius: 3,
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  border: `1px solid ${
                    speakingWith === w ? "var(--amber)" : "var(--border-strong)"
                  }`,
                  background: speakingWith === w ? "var(--amber-soft)" : "transparent",
                  color: speakingWith === w ? "var(--amber)" : "var(--text-dim)",
                }}
              >
                {SPEAKING_WITH_LABEL[w]}
              </button>
            ))}

            <div style={{ flex: 1 }} />

            {/* Which gatekeeper opener you are running. Stays put between
                leads — flipping it per call would make the comparison
                meaningless. Off by default, so nobody is silently enrolled. */}
            <span className="faint">Script:</span>
            {(["off", ...SCRIPT_VERSIONS] as const).map((v) => {
              const on = v === "off" ? scriptVersion === null : scriptVersion === v;
              return (
                <button
                  key={v}
                  onClick={() => {
                    setScriptVersion(v === "off" ? null : (v as ScriptVersion));
                    setLineIndex(0);
                  }}
                  title={
                    v === "off"
                      ? "Not part of the test. The call is logged without a version."
                      : buildScript(v as ScriptVersion, {
                          businessName: lead.business_name,
                        }).premise
                  }
                  style={{
                    padding: "4px 10px",
                    borderRadius: 3,
                    fontSize: "0.72rem",
                    fontWeight: 700,
                    cursor: "pointer",
                    border: `1px solid ${on ? "var(--amber)" : "var(--border-strong)"}`,
                    background: on ? "var(--amber-soft)" : "transparent",
                    color: on ? "var(--amber)" : "var(--text-dim)",
                  }}
                >
                  {v === "off" ? "off" : v}
                </button>
              );
            })}
          </div>

          <p
            style={{
              marginTop: 12,
              fontSize: "0.95rem",
              lineHeight: 1.5,
              color: "var(--amber)",
              fontWeight: 600,
            }}
          >
            {guide.goal}
          </p>
          {guide.notes.length > 0 && (
            <p className="faint" style={{ marginTop: 3 }}>
              {guide.notes.join(" · ")}
            </p>
          )}

          {/* the line to say, one at a time */}
          <div
            style={{
              marginTop: 12,
              padding: "20px 22px",
              border: "1px solid var(--amber-dim)",
              borderRadius: 4,
              background: "var(--bg-inset)",
            }}
          >
            <div className="faint" style={{ marginBottom: 7 }}>
              {currentLine.heading} · {Math.min(lineIndex + 1, lines.length)} of{" "}
              {lines.length}
            </div>
            <p style={{ fontSize: "1.3rem", lineHeight: 1.5, maxWidth: "62ch" }}>
              {currentLine.line}
            </p>

            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={() => setLineIndex((n) => (n + 1) % lines.length)}
              >
                Next line
              </button>
              <button
                className={showObjections ? "btn" : "btn-ghost"}
                onClick={() => setShowObjections(!showObjections)}
              >
                Objection help
                {raised.length > 0 ? ` · ${raised.length}` : ""}
              </button>
              <div style={{ flex: 1 }} />
              {lead.direct_phone && (
                <button
                  className={showContactFeedback ? "btn" : "btn-ghost"}
                  onClick={() => setShowContactFeedback(!showContactFeedback)}
                  title="Tell the system whether these contact details were right"
                >
                  Number wrong?
                </button>
              )}
              <button
                className={showPacket ? "btn" : "btn-ghost"}
                onClick={() => setShowPacket(!showPacket)}
                title="Text them the gap summary, the demo and the trial offer, right now"
              >
                Send packet
              </button>
              <button
                className="btn-ghost"
                onClick={() => setShowDetails(!showDetails)}
                title="Research, previous calls, notes and what earlier callers learned"
              >
                {showDetails ? "Hide" : "Lead"} details
                {!showDetails && detailCount > 0 ? ` · ${detailCount}` : ""}
              </button>
            </div>
          </div>

          {showPacket && (
            <div style={{ marginTop: 10 }}>
              <PacketPanel
                leadId={lead.id}
                businessName={lead.business_name}
                endpoint="/api/dial/packet"
              />
            </div>
          )}

          {showContactFeedback && (
            <div
              style={{
                marginTop: 10,
                padding: "12px 14px",
                border: "1px solid var(--border-strong)",
                borderRadius: 4,
              }}
            >
              <div style={{ fontWeight: 700, fontSize: "0.82rem" }}>
                What happened when you dialled it?
              </div>
              <p className="faint" style={{ marginTop: 3, marginBottom: 8, lineHeight: 1.5 }}>
                This corrects the record. A wrong number stops being handed to
                anyone else and the lead goes back for re-enrichment.
              </p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {CONTACT_OUTCOMES.map((o) => (
                  <button
                    key={o}
                    className={
                      o === "wrong_number" || o === "disconnected" || o === "owner_no_longer_there"
                        ? "btn-danger"
                        : "btn-ghost"
                    }
                    style={{ padding: "6px 10px", fontSize: "0.72rem" }}
                    onClick={() => reportContact(o)}
                  >
                    {CONTACT_OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>
              <input
                placeholder="Anything worth adding (optional)"
                value={contactNote}
                onChange={(e) => setContactNote(e.target.value)}
                style={{ width: "100%", marginTop: 8 }}
              />
            </div>
          )}

          {showObjections && (
            <div style={{ marginTop: 10, display: "grid", gap: 4 }}>
              {OBJECTIONS.map((o) => (
                <div key={o.key}>
                  <button
                    className="btn-ghost"
                    style={{
                      width: "100%",
                      justifyContent: "flex-start",
                      padding: "6px 10px",
                      fontSize: "0.74rem",
                    }}
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
                    <div
                      style={{
                        padding: "10px 12px",
                        fontSize: "0.88rem",
                        lineHeight: 1.5,
                        background: "var(--bg-inset)",
                        border: "1px solid var(--border)",
                        borderRadius: 4,
                        marginTop: 4,
                      }}
                    >
                      <div>{o.response}</div>
                      <div style={{ color: "var(--amber)", marginTop: 5 }}>{o.followUp}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* one private nudge, when there is one worth making */}
          <div style={{ marginTop: 10 }}>
            <LiveAssistant
              ctx={{
                stage,
                businessName: lead.business_name,
                ownerName: lead.owner_name,
                ownerReachedBefore: !!lead.owner_reached,
                gatekeeperName: lead.gatekeeper_name,
                answeringSetup: lead.answering_setup || null,
                existingProvider: lead.existing_provider || null,
                objectionKey: openObjection || lastObjection,
                contactConfirmed: false,
                meetingTimeAgreed: false,
              }}
            />
          </div>
        </div>

        {/* ---------------------- lead details, on request ---------------------- */}
        {showDetails && (
          <div style={{ display: "grid", gap: 12 }}>
            <LeadDetails lead={lead} history={history} contacts={contacts} aiTip={data.aiTip} dossier={data.dossier} pendingCallback={data.pendingCallback} />
          </div>
        )}
      </div>

      {/* ========================= 3. what happened ========================== */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "var(--bg)",
          borderTop: "1px solid var(--border-strong)",
          padding: "10px 16px",
          zIndex: 30,
        }}
      >
        <div
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {PRIMARY_OUTCOMES.map((value) => {
            const form = OUTCOME_FORM_MAP[value];
            if (!form) return null;
            return (
              <button
                key={value}
                className={value === "appointment_set" ? "btn" : "btn-ghost"}
                onClick={() => setPendingOutcome(value)}
                disabled={logging}
                style={{ padding: "9px 14px" }}
              >
                {form.label}
              </button>
            );
          })}

          <div style={{ position: "relative" }}>
            <button
              className="btn-ghost"
              onClick={() => setShowMore(!showMore)}
              disabled={logging}
              style={{ padding: "9px 14px" }}
            >
              More {showMore ? "▾" : "▴"}
            </button>
            {showMore && (
              <div
                className="card"
                style={{
                  position: "absolute",
                  bottom: "calc(100% + 8px)",
                  right: 0,
                  width: 260,
                  display: "grid",
                  gap: 6,
                  zIndex: 40,
                }}
              >
                {MORE_OUTCOMES.map((value) => {
                  const form = OUTCOME_FORM_MAP[value];
                  if (!form) return null;
                  return (
                    <button
                      key={value}
                      className={value === "do_not_call" ? "btn-danger" : "btn-ghost"}
                      onClick={() => {
                        setShowMore(false);
                        setPendingOutcome(value);
                      }}
                      style={{ justifyContent: "flex-start", padding: "8px 12px" }}
                    >
                      {form.label}
                      {value === suggested && (
                        <span className="faint" style={{ marginLeft: 6 }}>
                          likely
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
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
          intel={intel}
          onIntelChange={setIntel}
          saving={logging}
          onCancel={() => setPendingOutcome(null)}
          onSave={(values, confirmed, intelValues) =>
            logOutcome(pendingOutcome, values, confirmed, intelValues)
          }
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* lead details                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything true but not urgent. One panel, plain rows — the old screen gave
 * each of these its own bordered card, which is how six useful facts came to
 * fill a screen and a half.
 */
function LeadDetails({
  lead,
  history,
  contacts,
  aiTip,
  dossier,
  pendingCallback,
}: {
  lead: Lead;
  history: HistoryRow[];
  contacts: Contact[];
  aiTip?: string | null;
  dossier?: Dossier | null;
  pendingCallback?: { scheduled_for: string; reason: string | null } | null;
}) {
  const known: string[] = [];
  if (lead.owner_name) {
    known.push(`Owner: ${lead.owner_name}${lead.owner_title ? ` (${lead.owner_title})` : ""}`);
  }
  if (lead.best_call_day || lead.best_call_time) {
    known.push(`Best time: ${[lead.best_call_day, lead.best_call_time].filter(Boolean).join(" ")}`);
  }
  if (lead.answering_setup) known.push(`Answers calls via: ${lead.answering_setup}`);
  if (lead.existing_provider) known.push(`Existing provider: ${lead.existing_provider}`);
  if (lead.last_objection) known.push(`Last objection: ${lead.last_objection}`);
  if (lead.notes) known.push(lead.notes);

  return (
    <div className="card" style={{ maxHeight: "calc(100vh - 250px)", overflowY: "auto" }}>
      {dossier?.hasSubstance && (
        <Section title="Where you stand">
          <p style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{dossier.status}</p>
          {(
            [
              ["They told us", dossier.theirSituation],
              ["Their problem", dossier.statedProblems],
              ["We pitched", dossier.pitched],
              ["Pushback", dossier.resistance],
              ["We promised", dossier.promises],
              ["Booked", dossier.commitments],
            ] as [string, string[]][]
          )
            .filter(([, v]) => v.length > 0)
            .map(([title, lines]) => (
              <div key={title} style={{ marginTop: 6 }}>
                <div className="faint" style={{ fontWeight: 700 }}>
                  {title}
                </div>
                {lines.map((l, i) => (
                  <div key={i} style={{ fontSize: "0.82rem", lineHeight: 1.5 }}>
                    · {l}
                  </div>
                ))}
              </div>
            ))}
          {dossier.gaps.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 700, fontSize: "0.78rem", color: "var(--amber)" }}>
                Find out on this call
              </div>
              {dossier.gaps.map((g, i) => (
                <div key={i} className="faint" style={{ lineHeight: 1.5 }}>
                  · {g}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {known.length > 0 && (
        <Section title="What we know">
          {known.map((k, i) => (
            <div key={i} style={{ fontSize: "0.82rem", lineHeight: 1.55 }}>
              · {k}
            </div>
          ))}
        </Section>
      )}

      {aiTip && (
        <Section title="AI note">
          <p style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", lineHeight: 1.55 }}>{aiTip}</p>
        </Section>
      )}

      {(history.length > 0 || pendingCallback) && (
        <Section title={`Previous calls (${history.length})`}>
          {pendingCallback && (
            <div style={{ color: "var(--amber)", fontSize: "0.8rem", marginBottom: 6 }}>
              Callback booked for {new Date(pendingCallback.scheduled_for).toLocaleString()}
              {pendingCallback.reason ? ` — ${pendingCallback.reason}` : ""}
            </div>
          )}
          {history.map((h, i) => (
            <div key={i} style={{ fontSize: "0.79rem", marginBottom: 7, lineHeight: 1.5 }}>
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
              {h.next_step && <div style={{ color: "var(--amber)" }}>Next: {h.next_step}</div>}
              {h.notes && <div className="faint">{h.notes}</div>}
            </div>
          ))}
        </Section>
      )}

      {contacts.length > 0 && (
        <Section title="Contacts on file">
          {contacts.map((c) => (
            <div key={c.id} className="faint" style={{ marginBottom: 3 }}>
              {c.full_name || "(unknown)"}
              {c.title ? ` — ${c.title}` : ""}
              {c.direct_phone ? ` · ${c.direct_phone}` : ""}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

/** One fact in the header strip, with the separator that keeps it its own fact. */
function Meta({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <>
      <span style={{ color }}>{children}</span>
      <span aria-hidden style={{ opacity: 0.4 }}>
        ·
      </span>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ marginBottom: 5, color: "var(--text-dim)" }}>{title}</h3>
      {children}
    </div>
  );
}
