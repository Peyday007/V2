"use client";

// Playback for a lead's recorded calls.
//
// Two rules show up in the markup:
//
//   A deleted recording still appears, as a row saying it was deleted and why.
//   Silently vanishing rows are how a compliance question becomes unanswerable
//   six months later.
//
//   Speaker labels are shown only where the transcriber was confident. A
//   single microphone hearing a caller and a phone speaker cannot reliably
//   tell them apart, and a transcript that confidently misattributes a
//   sentence is worse than one that admits it does not know.

import { useCallback, useEffect, useState } from "react";
import { useConfirm, type ConfirmOptions } from "@/components/Confirm";

type Recording = {
  id: string;
  call_id: string | null;
  capture_mode: string;
  duration_seconds: number | null;
  size_bytes: number | null;
  started_at: string | null;
  consent_status: string;
  consent_policy_applied: string | null;
  processing_status: string;
  transcription_error: string | null;
  deleted_at: string | null;
  discard_reason: string | null;
  created_at: string;
  callers?: { name: string } | { name: string }[] | null;
};

type Segment = {
  sequence: number;
  start_ms: number;
  end_ms: number | null;
  speaker: string;
  speaker_confidence: number | null;
  text: string;
};

const CONSENT_LABEL: Record<string, string> = {
  granted: "consent given",
  refused: "consent refused",
  not_required: "one-party state",
  pending: "consent not marked",
  unknown: "consent unknown",
};

function mmss(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function sizeText(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export default function RecordingPlayer({ leadId }: { leadId: string }) {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/recordings?lead_id=${encodeURIComponent(leadId)}`);
      const j = await res.json();
      setRecordings(j.recordings || []);
      setError(j.error || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!recordings) return null;
  if (recordings.length === 0 && !error) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ marginBottom: 6 }}>Recordings ({recordings.length})</h2>
      <p className="faint" style={{ marginBottom: 12, lineHeight: 1.55 }}>
        Captured through the caller&rsquo;s laptop microphone with the handset on
        speaker. The prospect&rsquo;s side comes through a phone speaker across a
        desk, so expect their half to be quieter than the caller&rsquo;s.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>
          {error}
        </div>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {recordings.map((r) => (
          <RecordingRow
            key={r.id}
            recording={r}
            open={openId === r.id}
            onToggle={() => setOpenId(openId === r.id ? null : r.id)}
            onDeleted={load}
            ask={ask}
          />
        ))}
      </div>
      {dialog}
    </div>
  );
}

function RecordingRow({
  recording: r,
  open,
  onToggle,
  onDeleted,
  ask,
}: {
  recording: Recording;
  open: boolean;
  onToggle: () => void;
  onDeleted: () => void;
  ask: (opts: ConfirmOptions) => Promise<boolean>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const caller = Array.isArray(r.callers) ? r.callers[0] : r.callers;
  const deleted = !!r.deleted_at;

  useEffect(() => {
    if (!open || deleted || url) return;
    setLoading(true);
    fetch(`/api/recordings/${r.id}`)
      .then(async (res) => {
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || "Could not load that recording.");
        // A signed link, minted per view and short-lived. Never a public URL.
        setUrl(j.playbackUrl);
        setSegments(j.segments || []);
        if (!j.playbackUrl) setRowError("The audio file is missing from storage.");
      })
      .catch((e) => setRowError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open, deleted, url, r.id]);

  async function remove() {
    const ok = await ask({
      title: "Delete this recording?",
      body: [
        "The audio and any transcript are removed from storage for good.",
        "The record that a call happened, and that this recording was deleted, both stay.",
      ],
      confirmLabel: "Delete the audio",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/recordings/${r.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "deleted_by_admin" }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setRowError(j.error || "The audio could not be deleted.");
      return;
    }
    onDeleted();
  }

  return (
    <div className="card" style={{ opacity: deleted ? 0.7 : 1 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>
          {r.started_at ? new Date(r.started_at).toLocaleString() : new Date(r.created_at).toLocaleString()}
        </strong>
        {caller?.name && <span className="tag-dim">{caller.name}</span>}
        <span className="tag-dim">{mmss(r.duration_seconds)}</span>
        <span className="tag-dim">{CONSENT_LABEL[r.consent_status] || r.consent_status}</span>
        {r.size_bytes ? <span className="faint">{sizeText(r.size_bytes)}</span> : null}
      </div>

      {deleted ? (
        // Kept visible on purpose. A row that disappeared would make a later
        // question about what happened to this call unanswerable.
        <p className="faint" style={{ marginTop: 6, lineHeight: 1.5 }}>
          Audio deleted{r.discard_reason ? ` — ${r.discard_reason.replace(/_/g, " ")}` : ""}. The
          call itself is still on record above.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button className="btn-ghost" onClick={onToggle}>
              {open ? "Hide" : "Play"}
            </button>
            <button className="btn-danger" onClick={remove} disabled={busy}>
              {busy ? "Deleting…" : "Delete audio"}
            </button>
          </div>

          {open && (
            <div style={{ marginTop: 10 }}>
              {loading && <p className="muted">Fetching the audio…</p>}
              {url && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <audio controls preload="none" src={url} style={{ width: "100%" }} />
              )}

              {segments.length > 0 ? (
                <div style={{ marginTop: 12, maxHeight: 320, overflowY: "auto" }}>
                  {segments.map((s) => (
                    <div key={s.sequence} style={{ marginBottom: 8, lineHeight: 1.5 }}>
                      <span className="faint">{mmss(Math.floor(s.start_ms / 1000))}</span>{" "}
                      {s.speaker !== "unknown" && (
                        <strong style={{ fontSize: "0.82rem" }}>
                          {s.speaker === "caller" ? "Caller" : "Prospect"}:
                        </strong>
                      )}{" "}
                      {s.text}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="faint" style={{ marginTop: 10, lineHeight: 1.5 }}>
                  {r.processing_status === "skipped"
                    ? r.transcription_error || "No transcript — transcription is switched off."
                    : r.processing_status === "failed"
                      ? `Transcription failed: ${r.transcription_error || "unknown reason"}`
                      : r.processing_status === "transcribing"
                        ? "Transcribing…"
                        : "No transcript for this recording."}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {rowError && <p style={{ marginTop: 8, color: "var(--red)" }}>{rowError}</p>}
    </div>
  );
}
