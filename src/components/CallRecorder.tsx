"use client";

// The room recorder on the call screen.
//
// The caller puts their handset on speaker; this captures the room through the
// laptop microphone. There is no telephony provider involved and the tel: link
// is untouched — this is the cheap route to recorded calls.
//
// Three things this component refuses to do:
//
//   Start without a level check. A recording that turns out to be silence is
//   discovered days later, when the call is long gone.
//
//   Start without the consent the law requires. The gate is computed on the
//   server from the lead's state and re-checked here; a browser that skipped
//   it would still be refused by the API.
//
//   Hold the whole call in memory. Audio uploads in chunks as it is captured,
//   so a refresh, a closed laptop or a dead connection costs the tail rather
//   than the call.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ROOM_SETUP_STEPS,
  PART_INTERVAL_MS,
  formatTimer,
  levelVerdict,
  pickMimeType,
  retryDelayFor,
  recoveryPlanFor,
  startGate,
  statusFor,
  type CapturedConsent,
  type LevelVerdict,
  type RecorderState,
} from "@/lib/recordingSession";
import { dialGate, type ConsentDecision, type DialGate } from "@/lib/consent";

type Config = {
  enabled: boolean;
  decision: ConsentDecision;
  announcement: string;
  leadState: string | null;
  retentionDays: number;
  transcription: { enabled: boolean; available: boolean; reason: string };
  open: { id: string; partsUploaded: number; consentStatus: string; startedAt: string | null } | null;
};

const TONE_COLOR: Record<string, string> = {
  idle: "var(--text-dim)",
  live: "var(--red)",
  warn: "var(--amber)",
  done: "var(--amber)",
  error: "var(--red)",
};

export default function CallRecorder({
  leadId,
  onRecordingChange,
  onDialGate,
}: {
  leadId: string;
  /** The finished recording's id, so the outcome save can link it to the call. */
  onRecordingChange: (recordingId: string | null) => void;
  /**
   * Whether the number may be dialled yet.
   *
   * Reported upward because the phone number lives in the dialler header, not
   * in here. The recorder is the only thing that knows whether audio is
   * genuinely being captured, and the gate has to be decided on that rather
   * than on whether a button was pressed.
   */
  onDialGate?: (gate: DialGate) => void;
}) {
  // Compact by design: this sits in the call header as a pill and opens into
  // the full controls only when the caller asks. It used to be a permanent
  // card whose most common state was the words "Recording off" — a whole
  // block of screen spent saying nothing was happening.
  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<RecorderState>("idle");
  const [level, setLevel] = useState<LevelVerdict | null>(null);
  const [consent, setConsent] = useState<CapturedConsent>(null);
  const [seconds, setSeconds] = useState(0);
  const [partsUploaded, setPartsUploaded] = useState(0);
  const [partsPending, setPartsPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(true);

  const recordingIdRef = useRef<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sequenceRef = useRef(0);
  const pendingRef = useRef(0);
  const startedAtRef = useRef<number>(0);
  const mimeRef = useRef<string>("audio/webm");

  /* ------------------------------ teardown ------------------------------- */

  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  useEffect(() => releaseMic, [releaseMic]);

  /* -------------------------------- config -------------------------------- */

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch(`/api/dial/recording?lead_id=${encodeURIComponent(leadId)}`);
      if (!res.ok) return;
      const j: Config = await res.json();
      setConfig(j);

      // A recording left open by a refresh or a closed laptop.
      const plan = recoveryPlanFor(j.open);
      if (j.open && plan.action !== "none") {
        setNotice(plan.message);
        if (plan.action === "finalize") {
          await fetch(`/api/dial/recording/${j.open.id}/finalize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ parts: j.open.partsUploaded }),
          }).catch(() => {});
        } else {
          await fetch(`/api/dial/recording/${j.open.id}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: plan.action === "discard" ? "abandoned" : "recovered" }),
          }).catch(() => {});
        }
      }
    } catch {
      // Recording is optional. A config it cannot read means no Record button,
      // never a broken call screen.
    }
  }, [leadId]);

  // Reset for each new lead: a recording belongs to one call.
  useEffect(() => {
    recordingIdRef.current = null;
    sequenceRef.current = 0;
    pendingRef.current = 0;
    setState("idle");
    setConsent(null);
    setSeconds(0);
    setPartsUploaded(0);
    setPartsPending(0);
    setError(null);
    setNotice(null);
    onRecordingChange(null);
    loadConfig();
  }, [leadId, loadConfig, onRecordingChange]);

  /* ------------------------- record it, don't ask -------------------------- */

  /*
   * Where the law needs only one party's consent, recording is not a choice
   * the caller makes — so it starts by itself.
   *
   * Two failure modes existed and this removes the second. Recording somewhere
   * unlawful is already impossible: the controls do not render and the server
   * refuses independently. What was left was forgetting to press Record in a
   * state where recording was fine, which loses the call silently and is
   * exactly the sort of thing that goes wrong at 4pm on a Friday.
   *
   * Deliberately fires once per lead, and never while anything is already
   * running or finishing — an auto-start that retried would spawn a second
   * recorder over the first.
   */
  const autoStartedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!config?.enabled) return;
    if (!config.decision.mandatory) return;
    if (autoStartedFor.current === leadId) return;
    // Something is already in flight, or already finished, for this lead.
    if (state !== "idle") return;
    if (config.open) return;

    autoStartedFor.current = leadId;
    void start();
    // `start` is stable enough for this: it closes over refs and setters, and
    // the guard above makes a second run impossible for the same lead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, leadId, state]);

  /* ------------------------------ the dial gate ---------------------------- */

  /*
   * Tell the dialler whether the phone may be used yet.
   *
   * `state === "recording"` and nothing looser: permission granted is not
   * capture, and a pressed button is not capture. A microphone that is
   * permitted but silent is exactly the failure this gate exists to catch, and
   * it is the state the team was in for weeks.
   */
  useEffect(() => {
    if (!onDialGate) return;
    if (!config) {
      // Config not loaded yet. Never block on ignorance — a slow request must
      // not look like a compliance stop.
      onDialGate({ blocked: false, reason: "" });
      return;
    }
    onDialGate(
      dialGate({
        decision: config.decision,
        capturing: state === "recording",
      })
    );
  }, [config, state, onDialGate]);

  /* -------------------------------- timer --------------------------------- */

  useEffect(() => {
    if (state !== "recording") return;
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      1000
    );
    return () => clearInterval(id);
  }, [state]);

  /* --------------------------- warn before leaving ------------------------ */

  useEffect(() => {
    if (state !== "recording" && state !== "finishing") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state]);

  /* ----------------------------- the mic check ---------------------------- */

  async function checkMicrophone() {
    setError(null);
    setState("checking_mic");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Left ON. Room capture through a laptop mic is noisy, and the
          // prospect arrives via a phone speaker across the desk.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const buf = new Float32Array(analyser.fftSize);
      let peak = 0;
      const started = Date.now();

      // Sample for three seconds and keep the loudest moment: an average would
      // be dragged to nothing by the pauses between words.
      const sample = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        peak = Math.max(peak, Math.sqrt(sum / buf.length));
        if (Date.now() - started < 3000) {
          requestAnimationFrame(sample);
        } else {
          const verdict = levelVerdict(peak);
          setLevel(verdict);
          setState(verdict.ok ? "ready" : "mic_blocked");
          if (!verdict.ok) setError(verdict.message);
        }
      };
      requestAnimationFrame(sample);
    } catch (e) {
      releaseMic();
      setState("mic_blocked");
      const name = e instanceof Error ? e.name : "";
      setError(
        name === "NotAllowedError"
          ? "You (or your browser) blocked the microphone. Click the padlock in the address bar, allow the microphone, then run the check again."
          : name === "NotFoundError"
            ? "No microphone was found. Plug one in or enable the built-in one, then run the check again."
            : "The microphone could not be opened. Close anything else using it (Zoom, Meet, Teams) and try again."
      );
    }
  }

  /* ------------------------------- uploading ------------------------------ */

  /** Push one chunk, retrying a flaky connection but never a refusal. */
  const uploadPart = useCallback(async (recordingId: string, sequence: number, blob: Blob) => {
    pendingRef.current += 1;
    setPartsPending(pendingRef.current);

    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(
          `/api/dial/recording/${recordingId}/part?sequence=${sequence}`,
          { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob }
        );
        if (res.ok) {
          pendingRef.current -= 1;
          setPartsPending(pendingRef.current);
          setPartsUploaded((n) => Math.max(n, sequence + 1));
          return;
        }
        // 409 means it will never succeed — consent refused, or the recording
        // is gone. Retrying would just burn the caller's connection.
        if (res.status === 409) break;
      } catch {
        // Network dropped. Fall through to the backoff.
      }
      const delay = retryDelayFor(attempt);
      if (delay === null) break;
      await new Promise((r) => setTimeout(r, delay));
    }

    pendingRef.current -= 1;
    setPartsPending(pendingRef.current);
    setError(
      "A chunk of audio could not be uploaded. The rest of the call is still being saved — the outcome form is unaffected."
    );
  }, []);

  /* -------------------------------- start --------------------------------- */

  async function start() {
    if (!config) return;
    setError(null);

    const mime = pickMimeType((t) => {
      try {
        return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    });
    if (!mime) {
      setState("failed");
      setError("This browser cannot record audio. Chrome, Edge, Firefox and Safari all can.");
      return;
    }
    mimeRef.current = mime;

    if (!streamRef.current) {
      await checkMicrophone();
      if (!streamRef.current) return;
    }

    // Create the row first: the server re-checks consent and can refuse.
    let recordingId: string;
    try {
      const res = await fetch("/api/dial/recording", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: leadId,
          client_capture_id: crypto.randomUUID(),
          mime_type: mime,
        }),
      });
      const j = await res.json();
      if (!res.ok) {
        setState("failed");
        setError(j.error || "Recording was refused.");
        return;
      }
      recordingId = j.recording_id;
    } catch {
      setState("failed");
      setError("Could not reach the server to start recording. The outcome form still works.");
      return;
    }

    recordingIdRef.current = recordingId;
    onRecordingChange(recordingId);

    // Tell the server what the prospect said, before any audio is kept.
    if (consent === "granted") {
      fetch(`/api/dial/recording/${recordingId}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "granted" }),
      }).catch(() => {});
    }

    try {
      const recorder = new MediaRecorder(streamRef.current!, { mimeType: mime });
      mediaRef.current = recorder;
      sequenceRef.current = 0;

      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return;
        const seq = sequenceRef.current++;
        uploadPart(recordingId, seq, ev.data);
      };
      recorder.onerror = () => {
        setError("The browser stopped recording unexpectedly. Whatever uploaded is kept.");
        setState("failed");
      };

      // A timeslice is what makes this survive a refresh: chunks arrive during
      // the call rather than one blob at the end.
      recorder.start(PART_INTERVAL_MS);
      startedAtRef.current = Date.now();
      setSeconds(0);
      setState("recording");
      setShowSetup(false);
    } catch {
      setState("failed");
      setError("The recorder would not start. The outcome form still works.");
    }
  }

  /* --------------------------------- stop --------------------------------- */

  async function stop(discard = false, reason = "discarded_by_caller") {
    const recordingId = recordingIdRef.current;
    const recorder = mediaRef.current;
    const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);

    setState("finishing");
    if (recorder && recorder.state !== "inactive") {
      // requestData flushes the tail before stopping, so the final seconds are
      // not lost between the last timeslice and the stop.
      try {
        recorder.requestData();
      } catch {
        /* not fatal */
      }
      recorder.stop();
    }
    mediaRef.current = null;
    releaseMic();

    if (!recordingId) {
      setState("idle");
      return;
    }

    // Let in-flight chunks land before stitching, but do not wait forever.
    const deadline = Date.now() + 30_000;
    while (pendingRef.current > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
    }

    if (discard) {
      await fetch(`/api/dial/recording/${recordingId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      }).catch(() => {});
      recordingIdRef.current = null;
      onRecordingChange(null);
      setState("discarded");
      return;
    }

    try {
      const res = await fetch(`/api/dial/recording/${recordingId}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_seconds: elapsed, parts: sequenceRef.current }),
      });
      const j = await res.json();
      if (!res.ok) {
        setState("failed");
        setError(j.error || "The recording could not be saved.");
        return;
      }
      setSeconds(elapsed);
      setState("stored");
      if (j.transcript && !j.transcript.ok && j.transcript.error) {
        setNotice(`Audio saved. Transcript not produced: ${j.transcript.error}`);
      }
    } catch {
      setState("failed");
      setError("The recording could not be finished. Whatever uploaded is still there.");
    }
  }

  /* ------------------------------- consent -------------------------------- */

  async function markConsent(status: "granted" | "refused") {
    setConsent(status);
    const recordingId = recordingIdRef.current;

    if (status === "refused") {
      setNotice("Recording stopped and the audio deleted. Everything else about this call still saves.");
      if (recordingId) {
        // The server deletes the audio on a refusal; this is not just a flag.
        await fetch(`/api/dial/recording/${recordingId}/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "refused" }),
        }).catch(() => {});
        await stop(true, "consent_refused");
      } else {
        setState("idle");
      }
      return;
    }

    setNotice(null);
    if (recordingId) {
      await fetch(`/api/dial/recording/${recordingId}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "granted" }),
      }).catch(() => {});
    }
  }

  /* -------------------------------- render -------------------------------- */

  if (!config) return null;

  if (!config.enabled || !config.decision.allowed) {
    /*
     * No controls at all. Not a disabled button, not a consent panel — there
     * is nothing here to press.
     *
     * In a two-party state this is the whole safety design: the caller cannot
     * record even by accident, because the control does not exist and the
     * server refuses the same request independently. Human error has nowhere
     * to enter.
     */
    const blockedByLaw =
      config.enabled && !config.decision.allowed && !!config.leadState;
    return (
      <span
        className="tag-dim"
        title={config.decision.reason}
        style={blockedByLaw ? { color: "var(--text-dim)" } : undefined}
      >
        {blockedByLaw ? `${config.leadState} — not recorded` : "not recording"}
      </span>
    );
  }

  const gate = startGate({
    decision: config.decision,
    captured: consent,
    micReady: state === "ready" || state === "recording",
    announcement: config.announcement,
  });
  const status = statusFor({ state, seconds, partsUploaded, partsPending, lastError: error });
  const live = state === "recording";

  // While live, or while something needs the caller's attention, the panel
  // opens itself — a recording that silently failed is worse than a card.
  const demandsAttention = live || state === "finishing" || !!error || gate.needsConsentFirst;
  const open = expanded || demandsAttention;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="tag-dim"
        style={{
          border: `1px solid ${live ? "var(--red)" : "var(--border-strong)"}`,
          color: live ? "var(--red)" : TONE_COLOR[status.tone],
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
        title={status.detail}
      >
        {live && (
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--red)",
              animation: "pulse 1.2s ease-in-out infinite",
            }}
          />
        )}
        {status.label}
      </button>

      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 40,
            width: 380,
            maxWidth: "90vw",
            borderColor: live ? "var(--red)" : "var(--amber-dim)",
            textAlign: "left",
            whiteSpace: "normal",
          }}
        >
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <strong style={{ color: TONE_COLOR[status.tone] }}>{status.label}</strong>
        {config.leadState && <span className="tag-dim">{config.leadState}</span>}
        <div style={{ flex: 1 }} />
        {!demandsAttention && (
          <button
            className="btn-ghost"
            style={{ padding: "2px 8px", fontSize: "0.66rem" }}
            onClick={() => setExpanded(false)}
          >
            Close
          </button>
        )}
      </div>
      {status.detail && (
        <p className="faint" style={{ marginTop: 3, lineHeight: 1.5 }}>
          {status.detail}
        </p>
      )}

      {/* how to set the room up */}
      {showSetup && !live && !level?.ok && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 700, fontSize: "0.82rem" }}>Before you dial</div>
          <ol style={{ margin: "4px 0 0 18px", padding: 0 }}>
            {ROOM_SETUP_STEPS.map((s, i) => (
              <li key={i} className="faint" style={{ lineHeight: 1.5 }}>
                {s}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* the microphone check */}
      {!live && (
        <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn-ghost" onClick={checkMicrophone} disabled={state === "checking_mic"}>
            {state === "checking_mic" ? "Listening…" : level ? "Re-check microphone" : "Check microphone"}
          </button>
          {level && (
            <span
              className="faint"
              style={{ color: level.ok ? "var(--amber)" : "var(--red)", lineHeight: 1.4 }}
            >
              {level.message}
            </span>
          )}
        </div>
      )}

      {/* consent */}
      {config.decision.announcementRequired && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 700, fontSize: "0.82rem" }}>Read this out</div>
          <p
            style={{
              marginTop: 4,
              padding: "8px 10px",
              background: "var(--bg-inset)",
              borderRadius: 4,
              lineHeight: 1.5,
            }}
          >
            {config.announcement}
          </p>
          <p className="faint" style={{ marginTop: 4, lineHeight: 1.5 }}>
            {config.decision.reason}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              className={consent === "granted" ? "btn" : "btn-ghost"}
              onClick={() => markConsent("granted")}
            >
              They agreed
            </button>
            <button
              className={consent === "refused" ? "btn-danger" : "btn-ghost"}
              onClick={() => markConsent("refused")}
            >
              They said no
            </button>
          </div>
        </div>
      )}

      {/* start / stop */}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {!live ? (
          <button
            className="btn"
            onClick={start}
            disabled={!gate.canStart || state === "finishing" || state === "checking_mic"}
            title={gate.canStart ? "" : gate.reason}
          >
            Start recording
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => stop(false)}>
              Stop and save
            </button>
            <button className="btn-danger" onClick={() => stop(true)}>
              Stop and delete
            </button>
          </>
        )}
      </div>

      {!gate.canStart && !live && state !== "stored" && state !== "discarded" && (
        <p className="faint" style={{ marginTop: 6, lineHeight: 1.5 }}>
          {gate.reason}
        </p>
      )}

      {notice && (
        <p style={{ marginTop: 8, color: "var(--amber)", lineHeight: 1.5 }}>{notice}</p>
      )}
      {error && <p style={{ marginTop: 8, color: "var(--red)", lineHeight: 1.5 }}>{error}</p>}

      {config.transcription.enabled && !config.transcription.available && (
        <p className="faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
          {config.transcription.reason}
        </p>
      )}

        </div>
      )}

      <style jsx>{`
        @keyframes pulse {
          0%,
          100% {
            opacity: 1;
          }
          50% {
            opacity: 0.25;
          }
        }
      `}</style>
    </span>
  );
}
