"use client";

import { useCallback, useEffect, useState } from "react";

type Settings = {
  recording_enabled: boolean;
  consent_policy: string;
  consent_announcement: string;
  retention_days: number;
  transcription_enabled: boolean;
};

type Payload = {
  settings: Settings | null;
  allPartyStates: string[];
  transcription: { available: boolean; reason: string; remedy: string | null };
  serviceRole: boolean;
  error: string | null;
};

const POLICIES: { key: string; label: string; blurb: string }[] = [
  {
    key: "all_party",
    label: "Announce on every call",
    blurb:
      "The safest setting, and the default. Every prospect is told and has to agree before recording starts, wherever they are. Costs a sentence at the top of each call.",
  },
  {
    key: "per_state",
    label: "Announce where the law requires it",
    blurb:
      "Announce and get agreement in all-party states; record without an announcement elsewhere. A lead with no state on file is never recorded, because the law that applies is unknown.",
  },
  {
    key: "one_party",
    label: "One-party where lawful",
    blurb:
      "Same as above in practice — an all-party state still overrides this, because a business preference does not outrank a state's law.",
  },
  {
    key: "disabled",
    label: "Off",
    blurb: "Nothing is recorded, whatever the toggle above says.",
  },
];

export default function RecordingSettingsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/recording-settings");
    const j: Payload = await res.json();
    setData(j);
    setDraft(j.settings);
    setErr(j.error || "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(patch: Partial<Settings>) {
    setBusy(true);
    setErr("");
    const res = await fetch("/api/recording-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      setErr(j.error || "Could not save that.");
      return;
    }
    setMsg("Saved.");
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Call recording</h1>
      <p className="faint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        Callers keep dialling from their own phones. Recording works by putting
        the handset on <strong>speaker</strong> and capturing the room through
        the laptop microphone — no phone system, no per-minute call cost.
      </p>
      <p className="faint" style={{ marginBottom: 22, lineHeight: 1.6 }}>
        The trade is audio quality. Your caller is next to the microphone; the
        prospect is coming out of a phone speaker across the desk. Their half
        will be quieter, and the transcript will be less reliable on their side
        than on your caller&rsquo;s. <strong>Headphones break it entirely</strong>{" "}
        — the prospect&rsquo;s voice then goes straight into the caller&rsquo;s
        ear and never reaches the microphone.
      </p>

      {err && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {err}
        </div>
      )}
      {msg && !err && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {!draft ? (
        <p className="muted">Settings are unavailable until the migrations are run.</p>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={draft.recording_enabled}
                disabled={busy}
                onChange={(e) => save({ recording_enabled: e.target.checked })}
              />
              <strong>Record calls</strong>
            </label>
            <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
              Off by default. With this off, the Record button never appears on
              the call screen and the dialer works exactly as it does today.
            </p>
          </div>

          <h2 style={{ margin: "22px 0 8px" }}>Consent</h2>
          <p className="faint" style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Recording a call without the consent the law requires is a criminal
            offence in some states, not a policy breach. These{" "}
            {data.allPartyStates.length} need everyone on the call to agree:{" "}
            <strong>{data.allPartyStates.join(", ")}</strong>. Where anything is
            unknown, the app refuses to record rather than guessing.
          </p>

          <div style={{ display: "grid", gap: 10 }}>
            {POLICIES.map((p) => (
              <label
                key={p.key}
                className="card"
                style={{
                  cursor: "pointer",
                  borderColor: draft.consent_policy === p.key ? "var(--amber-dim)" : "var(--border)",
                }}
              >
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <input
                    type="radio"
                    name="policy"
                    checked={draft.consent_policy === p.key}
                    disabled={busy}
                    onChange={() => save({ consent_policy: p.key })}
                  />
                  <strong>{p.label}</strong>
                </div>
                <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
                  {p.blurb}
                </p>
              </label>
            ))}
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <strong>What the caller reads out</strong>
            <p className="faint" style={{ marginTop: 4, marginBottom: 8, lineHeight: 1.55 }}>
              Shown on the call screen wherever an announcement is required.
            </p>
            <textarea
              value={draft.consent_announcement}
              onChange={(e) => setDraft({ ...draft, consent_announcement: e.target.value })}
              rows={2}
              style={{ width: "100%" }}
            />
            <button
              className="btn"
              style={{ marginTop: 8 }}
              disabled={busy || !draft.consent_announcement.trim()}
              onClick={() => save({ consent_announcement: draft.consent_announcement })}
            >
              Save wording
            </button>
          </div>

          <h2 style={{ margin: "22px 0 8px" }}>Keeping and transcribing</h2>

          <div className="card" style={{ marginBottom: 10 }}>
            <strong>Delete recordings after</strong>
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <input
                type="number"
                min={1}
                max={3650}
                value={draft.retention_days}
                onChange={(e) => setDraft({ ...draft, retention_days: Number(e.target.value) })}
                style={{ maxWidth: 100 }}
              />
              <span className="faint">days</span>
              <button
                className="btn"
                disabled={busy}
                onClick={() => save({ retention_days: draft.retention_days })}
              >
                Save
              </button>
            </div>
          </div>

          <div className="card">
            <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={draft.transcription_enabled}
                disabled={busy}
                onChange={(e) => save({ transcription_enabled: e.target.checked })}
              />
              <strong>Write out a transcript after each call</strong>
            </label>
            <p
              className="faint"
              style={{
                marginTop: 4,
                lineHeight: 1.55,
                color: data.transcription.available ? undefined : "var(--red)",
              }}
            >
              {data.transcription.reason}
            </p>
            {data.transcription.remedy && (
              <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
                {data.transcription.remedy}
              </p>
            )}
            <p className="faint" style={{ marginTop: 6, lineHeight: 1.55 }}>
              Recording and playback work without this. Speaker names are only
              shown where the transcriber was confident — one microphone hearing
              both sides usually cannot tell them apart, and a transcript that
              puts the prospect&rsquo;s words in your caller&rsquo;s mouth is
              worse than one that admits it does not know.
            </p>
          </div>

          {!data.serviceRole && (
            <div className="card" style={{ marginTop: 14, borderColor: "var(--amber-dim)" }}>
              <strong>No service-role key is set.</strong>
              <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
                Recordings are being written with the public key. That works, but
                it relies on the storage policy in migration 0021 having applied.
                If uploads fail, add <code>SUPABASE_SERVICE_ROLE_KEY</code> in
                Vercel and redeploy.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
