import { describe, it, expect } from "vitest";
import {
  startGate,
  onConsentChanged,
  levelVerdict,
  statusFor,
  recoveryPlanFor,
  retryDelayFor,
  partKey,
  finalKey,
  extensionFor,
  pickMimeType,
  formatTimer,
  PREFERRED_MIME_TYPES,
  ROOM_SETUP_STEPS,
  UPLOAD_RETRY_DELAYS_MS,
  LEVEL_SILENT,
  LEVEL_QUIET,
} from "../src/lib/recordingSession";
import { decideConsent } from "../src/lib/consent";

const decision = (over: Partial<ReturnType<typeof decideConsent>> = {}) => ({
  allowed: true,
  announcementRequired: true,
  affirmativeConsentRequired: true,
  status: "pending" as const,
  reason: "because",
  policyApplied: "all_party" as const,
  ...over,
});

/**
 * Recording a call without the consent the law requires is a criminal offence
 * in several states. Every one of these is a fail-closed check.
 */
describe("nothing records without consent", () => {
  it("refuses to start while affirmative consent is outstanding", () => {
    const gate = startGate({
      decision: decision(),
      captured: "pending",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
    expect(gate.needsConsentFirst).toBe(true);
    expect(gate.reason).toContain("Being told is not the same as agreeing");
  });

  it("refuses when consent was never captured at all", () => {
    const gate = startGate({
      decision: decision(),
      captured: null,
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
  });

  it("a refusal outranks a policy that would otherwise allow it", () => {
    const gate = startGate({
      decision: decision({ affirmativeConsentRequired: false, status: "not_required" }),
      captured: "refused",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain("They said no");
  });

  it("refuses when the policy itself blocks, whatever the caller ticked", () => {
    const gate = startGate({
      decision: decision({ allowed: false, reason: "Recording is switched off." }),
      captured: "granted",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain("switched off");
  });

  it("starts once they have actually agreed", () => {
    const gate = startGate({
      decision: decision(),
      captured: "granted",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(true);
    expect(gate.announcement).toBe("notice");
  });

  it("starts without an announcement only where none is required", () => {
    const gate = startGate({
      decision: decision({
        announcementRequired: false,
        affirmativeConsentRequired: false,
        status: "not_required",
      }),
      captured: "not_required",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(true);
    expect(gate.announcement).toBeNull();
  });

  it("holds an unknown state closed, end to end with the consent module", () => {
    // per_state with no state on file is the case most likely to be fudged.
    const d = decideConsent({ policy: "per_state", recordingEnabled: true, leadState: null });
    const gate = startGate({
      decision: d,
      captured: "granted",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain("blocked rather than guessed");
  });

  it("still announces in an all-party state under a one-party policy", () => {
    const d = decideConsent({ policy: "one_party", recordingEnabled: true, leadState: "CA" });
    const gate = startGate({
      decision: d,
      captured: "pending",
      micReady: true,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
    expect(gate.needsConsentFirst).toBe(true);
  });
});

describe("a refusal deletes the audio", () => {
  it("stops and discards when consent is withdrawn mid-call", () => {
    const action = onConsentChanged("refused", true);
    expect(action.stop).toBe(true);
    expect(action.discard).toBe(true);
    expect(action.discardReason).toBe("consent_refused");
  });

  it("discards even when nothing is recording, so a started capture cannot survive", () => {
    const action = onConsentChanged("refused", false);
    expect(action.discard).toBe(true);
  });

  it("tells the caller the outcome form is unaffected", () => {
    expect(onConsentChanged("refused", true).message).toContain("outcome form");
  });

  it("granting does not stop or discard anything", () => {
    const action = onConsentChanged("granted", true);
    expect(action.stop).toBe(false);
    expect(action.discard).toBe(false);
  });
});

describe("the microphone check happens before the call, not after", () => {
  it("fails a dead microphone", () => {
    const v = levelVerdict(0);
    expect(v.ok).toBe(false);
    expect(v.key).toBe("silent");
    expect(v.message).toContain("muted");
  });

  it("fails a level too faint for the prospect to survive", () => {
    const v = levelVerdict((LEVEL_SILENT + LEVEL_QUIET) / 2);
    expect(v.ok).toBe(false);
    expect(v.key).toBe("quiet");
  });

  it("passes a normal level", () => {
    expect(levelVerdict(0.15).key).toBe("good");
    expect(levelVerdict(0.15).ok).toBe(true);
  });

  it("warns about distortion without blocking the call", () => {
    const v = levelVerdict(0.95);
    expect(v.key).toBe("clipping");
    expect(v.ok).toBe(true);
  });

  it("treats a broken reading as silence rather than as fine", () => {
    expect(levelVerdict(NaN).ok).toBe(false);
  });

  it("will not start before the check has run", () => {
    const gate = startGate({
      decision: decision({ affirmativeConsentRequired: false, status: "not_required" }),
      captured: "not_required",
      micReady: false,
      announcement: "notice",
    });
    expect(gate.canStart).toBe(false);
    expect(gate.reason).toContain("microphone check");
  });

  it("tells the caller to take headphones off, because that breaks it silently", () => {
    expect(ROOM_SETUP_STEPS.join(" ")).toMatch(/headphones/i);
    expect(ROOM_SETUP_STEPS.join(" ")).toMatch(/speaker/i);
  });
});

describe("surviving a refresh, a dropped connection and a closed laptop", () => {
  it("keeps what uploaded and admits the tail is gone", () => {
    const plan = recoveryPlanFor({ partsUploaded: 4, consentStatus: "granted" });
    expect(plan.action).toBe("finalize");
    expect(plan.message).toContain("last few seconds before the reload were lost");
  });

  it("discards an open recording that captured nothing", () => {
    expect(recoveryPlanFor({ partsUploaded: 0, consentStatus: "granted" }).action).toBe("discard");
  });

  it("discards an open recording on a call where consent was refused", () => {
    const plan = recoveryPlanFor({ partsUploaded: 9, consentStatus: "refused" });
    expect(plan.action).toBe("discard");
  });

  it("does nothing when there is nothing open", () => {
    expect(recoveryPlanFor(null).action).toBe("none");
  });

  it("backs off on a failing upload and then gives up", () => {
    expect(retryDelayFor(0)).toBe(UPLOAD_RETRY_DELAYS_MS[0]);
    for (let i = 1; i < UPLOAD_RETRY_DELAYS_MS.length; i++) {
      expect(retryDelayFor(i)!).toBeGreaterThan(retryDelayFor(i - 1)!);
    }
    expect(retryDelayFor(UPLOAD_RETRY_DELAYS_MS.length)).toBeNull();
    expect(retryDelayFor(-1)).toBeNull();
  });

  it("names parts so a plain sort is chronological", () => {
    // Concatenating parts out of order produces an unplayable file, so the
    // ordering must survive a lexicographic sort at 10 and at 100.
    const keys = [2, 10, 100, 9].map((n) => partKey("rec", n));
    expect([...keys].sort()).toEqual([
      partKey("rec", 2),
      partKey("rec", 9),
      partKey("rec", 10),
      partKey("rec", 100),
    ]);
  });
});

describe("browser differences are handled, not declared unsupported", () => {
  it("prefers opus where it exists", () => {
    expect(pickMimeType((t) => t.includes("opus"))).toContain("opus");
  });

  it("falls back to what Safari can do", () => {
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });

  it("reports honestly when the browser can do none of them", () => {
    expect(pickMimeType(() => false)).toBeNull();
  });

  it("gives every candidate a sane file extension", () => {
    for (const t of PREFERRED_MIME_TYPES) {
      expect(extensionFor(t), t).not.toBe(".bin");
    }
    expect(finalKey("rec", "audio/webm;codecs=opus")).toBe("rec/call.webm");
    expect(finalKey("rec", "audio/mp4")).toBe("rec/call.mp4");
  });
});

describe("what the caller is told", () => {
  it("says the tab must stay open while chunks are in flight", () => {
    const s = statusFor({ state: "recording", seconds: 65, partsUploaded: 3, partsPending: 2 });
    expect(s.label).toBe("Recording 1:05");
    expect(s.detail).toContain("keep this tab open");
    expect(s.tone).toBe("live");
  });

  it("reassures that little is at risk when nothing is pending", () => {
    const s = statusFor({ state: "recording", seconds: 10, partsUploaded: 1, partsPending: 0 });
    expect(s.detail).toContain("last few seconds");
  });

  it("says the outcome form still works when recording fails", () => {
    const s = statusFor({ state: "failed", seconds: 0, partsUploaded: 0, partsPending: 0 });
    expect(s.detail).toContain("outcome form");
    expect(s.tone).toBe("error");
  });

  it("says everything else still saves when audio is deleted", () => {
    const s = statusFor({ state: "discarded", seconds: 30, partsUploaded: 2, partsPending: 0 });
    expect(s.detail).toContain("Everything else");
  });

  it("formats the timer past an hour without wrapping", () => {
    expect(formatTimer(0)).toBe("0:00");
    expect(formatTimer(9)).toBe("0:09");
    expect(formatTimer(3661)).toBe("61:01");
    expect(formatTimer(-5)).toBe("0:00");
  });
});
