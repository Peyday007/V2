"use client";

import { useCallback, useEffect, useState } from "react";

/*
 * Cold email, through Instantly.
 *
 * The page is laid out in the order somebody actually has to do things:
 * connect it, pick a campaign, see who can be emailed, push a batch, then
 * answer what comes back. The replies section is last on the page but first in
 * importance, so it also announces itself at the top when anything is waiting.
 */

type Settings = {
  enabled: boolean;
  campaign_id: string | null;
  campaign_name: string | null;
  max_push_per_run: number;
  auto_reply_enabled: boolean;
  reply_confidence_floor: number;
};

type Status = {
  settings: Settings;
  error: string | null;
  countsError: string | null;
  capability: { available: boolean; reason: string; missing: string[] };
  webhookSecretSet: boolean;
  campaigns: { id: string; name: string; status: string | null }[];
  campaignsError: string | null;
  availability: { available: number; total: number; reasons: { reason: string; count: number }[] };
  pushed: number;
  awaitingHuman: number;
};

type Draft = {
  id: string;
  intent: string | null;
  intent_label: string | null;
  intent_confidence: number | null;
  intent_reason: string | null;
  subject: string | null;
  body: string;
  status: string;
  decision_note: string | null;
  send_error: string | null;
  created_at: string;
  lead: { id: string; business_name: string; city: string | null; state: string | null; phone: string | null } | null;
  reply: { body: string | null; subject: string | null; from_email: string | null; occurred_at: string } | null;
};

export default function EmailPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [confirmAuto, setConfirmAuto] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        fetch("/api/instantly").then((r) => r.json()),
        fetch("/api/instantly/drafts?status=pending").then((r) => r.json()),
      ]);
      setStatus(s);
      setDrafts(d.drafts ?? []);
      if (d.error) setErr(d.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Record<string, unknown>) {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/instantly", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || j.error) {
      setErr(j.error || "Could not save that.");
      return;
    }
    load();
  }

  async function push() {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/instantly/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || j.error) {
      setErr(j.error || "The push failed.");
      load();
      return;
    }
    const bits = [`${j.pushed} pushed into the campaign`];
    if (j.failed) bits.push(`${j.failed} failed`);
    if (j.considered > j.limit) bits.push(`${j.considered - j.limit} still waiting`);
    setMsg(
      `${bits.join(", ")}.${
        j.stoppedEarly ? ` Stopped early: ${j.stoppedEarly}` : ""
      }${
        j.failures?.length
          ? ` First failure — ${j.failures[0].business}: ${j.failures[0].error}`
          : ""
      }`
    );
    load();
  }

  async function decide(id: string, action: string) {
    setBusy(true);
    setErr("");
    setMsg("");
    const res = await fetch("/api/instantly/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action, body: edits[id] }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || j.error) {
      setErr(`${j.error || "That did not work."}${j.remedy ? ` ${j.remedy}` : ""}`);
      load();
      return;
    }
    if (j.note) setMsg(j.note);
    load();
  }

  if (!status) return <p className="muted">Loading…</p>;

  const s = status.settings;
  const canPush = status.capability.available && s.enabled && !!s.campaign_id;

  return (
    <div style={{ maxWidth: 940, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Email</h1>
      <p className="faint" style={{ marginBottom: 20, lineHeight: 1.6 }}>
        Instantly sends the email. This page decides who gets it — using the
        owner&rsquo;s name, the review count and what a caller learned on the phone,
        which is the part Instantly has no way to know — and catches every reply
        so none of them sit unread in a separate tab.
      </p>

      {/* Loudest thing on the page, because a reply is the most valuable event
          in the system and it goes stale in hours. */}
      {status.awaitingHuman > 0 && (
        <a
          href="#replies"
          className="card"
          style={{
            display: "block",
            borderColor: "var(--amber)",
            borderLeft: "3px solid var(--amber)",
            color: "var(--amber)",
            marginBottom: 16,
            textDecoration: "none",
            fontWeight: 700,
          }}
        >
          {status.awaitingHuman} {status.awaitingHuman === 1 ? "reply is" : "replies are"} waiting
          for you →
        </a>
      )}

      {[status.error, status.countsError, err].filter(Boolean).map((m, i) => (
        <div
          key={i}
          className="card"
          style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16, lineHeight: 1.55 }}
        >
          {m}
        </div>
      ))}
      {msg && (
        <div
          className="card"
          style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 16, lineHeight: 1.55 }}
        >
          {msg}
        </div>
      )}

      {/* ------------------------------ connection --------------------------- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0, marginBottom: 10 }}>Connection</h2>
        <p style={{ lineHeight: 1.6, marginTop: 0 }}>
          {status.capability.available ? (
            <span style={{ color: "var(--amber)" }}>Connected to Instantly.</span>
          ) : (
            <span style={{ color: "var(--red)" }}>{status.capability.reason}</span>
          )}
        </p>
        <p className="faint" style={{ lineHeight: 1.6 }}>
          Replies come back to{" "}
          <code>{typeof window !== "undefined" ? window.location.origin : ""}/api/instantly/webhook</code>
          . Add that as a webhook in Instantly and put the same secret in the{" "}
          <code>x-instantly-secret</code> header.{" "}
          {status.webhookSecretSet ? (
            <span style={{ color: "var(--amber)" }}>INSTANTLY_WEBHOOK_SECRET is set.</span>
          ) : (
            <span style={{ color: "var(--red)" }}>
              INSTANTLY_WEBHOOK_SECRET is not set, so the endpoint rejects everything and no
              replies will reach you.
            </span>
          )}
        </p>
      </div>

      {/* ------------------------------- campaign ---------------------------- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0, marginBottom: 10 }}>Campaign</h2>
        {status.campaignsError && (
          <p style={{ color: "var(--red)", lineHeight: 1.55 }}>{status.campaignsError}</p>
        )}
        <div style={{ display: "grid", gap: 12 }}>
          <label>
            <div className="faint" style={{ marginBottom: 4 }}>
              Leads are pushed into this campaign. The email copy itself lives in Instantly.
            </div>
            <select
              value={s.campaign_id || ""}
              disabled={busy || status.campaigns.length === 0}
              onChange={(e) => {
                const chosen = status.campaigns.find((c) => c.id === e.target.value);
                save({ campaign_id: e.target.value, campaign_name: chosen?.name || "" });
              }}
            >
              <option value="">
                {status.campaigns.length === 0 ? "No campaigns found" : "Pick a campaign…"}
              </option>
              {status.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.status ? ` — ${c.status}` : ""}
                </option>
              ))}
            </select>
          </label>

          <label>
            <div className="faint" style={{ marginBottom: 4 }}>
              Most leads to push in one run. The cap is what makes a mistake cost a batch
              rather than your whole list.
            </div>
            <input
              type="number"
              min={1}
              max={500}
              defaultValue={s.max_push_per_run}
              disabled={busy}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (n !== s.max_push_per_run) save({ max_push_per_run: n });
              }}
            />
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={busy}
              onChange={(e) => save({ enabled: e.target.checked })}
            />
            <span>Programme is on — leads may be pushed</span>
          </label>
        </div>
      </div>

      {/* -------------------------------- pushing ---------------------------- */}
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0, marginBottom: 10 }}>Who can be emailed</h2>
        <p style={{ lineHeight: 1.7, marginTop: 0 }}>
          <strong style={{ color: "var(--amber)", fontSize: "1.4rem" }}>
            {status.availability.available}
          </strong>{" "}
          of {status.availability.total} leads have an address and are not suppressed.{" "}
          {status.pushed} {status.pushed === 1 ? "is" : "are"} already in a campaign.
        </p>
        {status.availability.reasons.length > 0 && (
          <ul className="faint" style={{ lineHeight: 1.6, marginTop: 0 }}>
            {status.availability.reasons.slice(0, 5).map((r) => (
              <li key={r.reason}>
                {r.count} — {r.reason.toLowerCase()}
              </li>
            ))}
          </ul>
        )}
        <p className="faint" style={{ lineHeight: 1.6 }}>
          Anyone on the do-not-call list is excluded here too. Somebody who asked not to be
          called did not ask to be emailed instead.
        </p>
        <button className="btn" onClick={push} disabled={busy || !canPush}>
          {busy ? "Working…" : `Push up to ${s.max_push_per_run} leads`}
        </button>
        {!canPush && (
          <span className="faint" style={{ marginLeft: 12 }}>
            {!status.capability.available
              ? "Set INSTANTLY_API_KEY first."
              : !s.campaign_id
                ? "Pick a campaign first."
                : "Switch the programme on first."}
          </span>
        )}
      </div>

      {/* ------------------------------- replies ----------------------------- */}
      <h2 id="replies" style={{ marginBottom: 6 }}>
        Replies waiting on you ({drafts.length})
      </h2>
      <p className="faint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        A draft is a suggestion, and nothing here has been sent. Edit it, then either send it
        through Instantly or copy it into the Instantly inbox and mark it sent. Anyone who
        asked to be removed is suppressed automatically and never appears here — there is no
        good reply to &ldquo;take me off your list&rdquo;.
      </p>

      {drafts.length === 0 ? (
        <p className="muted" style={{ marginBottom: 30 }}>
          Nothing waiting.
        </p>
      ) : (
        <div style={{ display: "grid", gap: 14, marginBottom: 30 }}>
          {drafts.map((d) => (
            <div key={d.id} className="card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <strong>{d.lead?.business_name || "Unknown business"}</strong>
                <span className="faint">
                  {d.intent_label || d.intent}
                  {typeof d.intent_confidence === "number"
                    ? ` · ${Math.round(d.intent_confidence * 100)}% sure`
                    : ""}
                </span>
              </div>
              {d.intent_reason && (
                <div className="faint" style={{ marginTop: 4, fontSize: "0.78rem" }}>
                  Why: {d.intent_reason}
                </div>
              )}

              {d.reply?.body && (
                <div
                  style={{
                    marginTop: 12,
                    padding: "10px 12px",
                    background: "var(--bg-inset)",
                    borderLeft: "2px solid var(--border)",
                    whiteSpace: "pre-wrap",
                    lineHeight: 1.6,
                    fontSize: "0.86rem",
                  }}
                >
                  <div className="faint" style={{ marginBottom: 6 }}>
                    They wrote:
                  </div>
                  {d.reply.body}
                </div>
              )}

              <div className="faint" style={{ marginTop: 12, marginBottom: 4 }}>
                Draft reply — edit before sending:
              </div>
              <textarea
                rows={10}
                value={edits[d.id] ?? d.body}
                onChange={(e) => setEdits({ ...edits, [d.id]: e.target.value })}
                style={{ fontFamily: "inherit", lineHeight: 1.6 }}
              />

              {d.send_error && (
                <div style={{ color: "var(--red)", marginTop: 8, lineHeight: 1.55 }}>
                  Not sent: {d.send_error}
                </div>
              )}
              {d.decision_note && !d.send_error && (
                <div className="faint" style={{ marginTop: 8, lineHeight: 1.55 }}>
                  {d.decision_note}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button className="btn" disabled={busy} onClick={() => decide(d.id, "send")}>
                  Send through Instantly
                </button>
                <button
                  className="btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    navigator.clipboard?.writeText(edits[d.id] ?? d.body);
                    setMsg("Copied. Paste it into the Instantly inbox, send it, then mark it sent.");
                  }}
                >
                  Copy
                </button>
                <button className="btn-ghost" disabled={busy} onClick={() => decide(d.id, "mark_sent")}>
                  Mark as sent
                </button>
                <div style={{ flex: 1 }} />
                <button className="btn-ghost" disabled={busy} onClick={() => decide(d.id, "reject")}>
                  Discard
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ----------------------------- automatic ----------------------------- */}
      <div className="card" style={{ marginBottom: 40, borderColor: "var(--border)" }}>
        <h2 style={{ marginTop: 0, marginBottom: 10 }}>Automatic replies</h2>
        <p style={{ lineHeight: 1.7, marginTop: 0 }}>
          Off, and it should probably stay off. Switching it on means a message reaches a
          prospect in your name with nobody having read it — fine ninety-five times and
          unrecoverable the other five.
        </p>
        <p className="faint" style={{ lineHeight: 1.7 }}>
          Even switched on it only ever covers a clear &ldquo;interested&rdquo; or a plain
          question above the confidence floor. Anything about price, a referral, a
          wrong-person reply or an unclear one still waits for you, and nothing at all is
          ever auto-sent to somebody who asked to be removed.
        </p>
        <div style={{ display: "grid", gap: 12 }}>
          <label>
            <div className="faint" style={{ marginBottom: 4 }}>
              Confidence floor — below this the reading is not acted on at all.
            </div>
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              defaultValue={s.reply_confidence_floor}
              disabled={busy}
              onBlur={(e) => {
                const f = Number(e.target.value);
                if (f !== s.reply_confidence_floor) save({ reply_confidence_floor: f });
              }}
            />
          </label>
          {!s.auto_reply_enabled && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={confirmAuto}
                onChange={(e) => setConfirmAuto(e.target.checked)}
              />
              <span className="faint">
                I understand a reply can go to a prospect with nobody reading it.
              </span>
            </label>
          )}
          <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={s.auto_reply_enabled}
              disabled={busy || (!s.auto_reply_enabled && !confirmAuto)}
              onChange={(e) =>
                save({ auto_reply_enabled: e.target.checked, acknowledge_autonomous: true })
              }
            />
            <span>Answer clear replies without me</span>
          </label>
        </div>
      </div>
    </div>
  );
}
