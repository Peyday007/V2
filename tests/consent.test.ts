import {
  describe,
  it,
  expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  decideConsent,
  mayStartRecording,
  isAllPartyState,
  retentionExpiry,
  ALL_PARTY_CONSENT_STATES,
  dialGate,
  recordabilityLabel,
  type ConsentPolicy,
} from "../src/lib/consent";

/**
 * Recording without the consent the law requires is a criminal offence in
 * several states. Every ambiguous case here must fail CLOSED.
 */

describe("recording is off unless it has been deliberately turned on", () => {
  it("blocks when recording is disabled", () => {
    const d = decideConsent({ policy: "all_party", recordingEnabled: false, leadState: "MI" });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe("blocked");
  });

  it("blocks when the policy is disabled, even if recording is enabled", () => {
    const d = decideConsent({ policy: "disabled", recordingEnabled: true, leadState: "TX" });
    expect(d.allowed).toBe(false);
  });
});

describe("all-party states", () => {
  it("knows the states that require everyone to consent", () => {
    for (const s of ["CA", "FL", "PA", "IL", "WA", "MA", "MI"]) {
      expect(isAllPartyState(s), s).toBe(true);
    }
  });

  it("does not treat one-party states as all-party", () => {
    for (const s of ["TX", "NY", "OH", "GA", "NC", "TN", "AZ", "CO"]) {
      expect(isAllPartyState(s), s).toBe(false);
    }
  });

  it("is case and whitespace insensitive", () => {
    expect(isAllPartyState(" ca ")).toBe(true);
    expect(isAllPartyState("Fl")).toBe(true);
  });

  it("treats a missing state as not-known rather than not-all-party", () => {
    expect(isAllPartyState(null)).toBe(false);
    expect(isAllPartyState("")).toBe(false);
  });

  it("covers the states this business actually calls into", () => {
    // Michigan is where the team is; California and Florida are in the metro
    // mix. All three require all-party consent.
    for (const s of ["MI", "CA", "FL"]) {
      expect(ALL_PARTY_CONSENT_STATES as readonly string[]).toContain(s);
    }
  });
});

describe("all_party policy announces everywhere", () => {
  it("requires an announcement and active agreement regardless of state", () => {
    for (const state of ["TX", "CA", null]) {
      const d = decideConsent({ policy: "all_party", recordingEnabled: true, leadState: state });
      expect(d.announcementRequired, String(state)).toBe(true);
      expect(d.affirmativeConsentRequired, String(state)).toBe(true);
      expect(d.status, String(state)).toBe("pending");
    }
  });
});

describe("state law overrides the business's preference", () => {
  it("a one-party POLICY does not permit silent recording in an all-party STATE", () => {
    const d = decideConsent({ policy: "one_party", recordingEnabled: true, leadState: "CA" });
    expect(d.announcementRequired).toBe(true);
    expect(d.affirmativeConsentRequired).toBe(true);
    expect(d.reason).toContain("overrides the one-party setting");
  });

  it("allows silent recording only in a genuinely one-party state", () => {
    const d = decideConsent({ policy: "one_party", recordingEnabled: true, leadState: "TX" });
    expect(d.allowed).toBe(true);
    expect(d.announcementRequired).toBe(false);
    expect(d.status).toBe("not_required");
  });

  it("BLOCKS when the state is unknown rather than assuming the permissive case", () => {
    for (const policy of ["one_party", "per_state"] as const) {
      const d = decideConsent({ policy, recordingEnabled: true, leadState: null });
      expect(d.allowed, policy).toBe(false);
      expect(d.reason, policy).toContain("blocked rather than guessed");
    }
  });

  it("per_state announces in an all-party state and not elsewhere", () => {
    expect(
      decideConsent({ policy: "per_state", recordingEnabled: true, leadState: "FL" })
        .announcementRequired
    ).toBe(true);
    expect(
      decideConsent({ policy: "per_state", recordingEnabled: true, leadState: "OH" })
        .announcementRequired
    ).toBe(false);
  });
});

describe("mayStartRecording is the final gate", () => {
  const allParty = decideConsent({
    policy: "all_party",
    recordingEnabled: true,
    leadState: "CA",
  });
  const onePartyOk = decideConsent({
    policy: "one_party",
    recordingEnabled: true,
    leadState: "TX",
  });

  it("will not start while consent is still pending", () => {
    expect(mayStartRecording(allParty, "pending").start).toBe(false);
  });

  it("will not start when consent was refused, under any policy", () => {
    expect(mayStartRecording(allParty, "refused").start).toBe(false);
    expect(mayStartRecording(onePartyOk, "refused").start).toBe(false);
  });

  it("starts once consent is granted", () => {
    expect(mayStartRecording(allParty, "granted").start).toBe(true);
  });

  it("starts without a prompt where consent is not required", () => {
    expect(mayStartRecording(onePartyOk, "not_required").start).toBe(true);
  });

  it("will not start when the decision itself blocked it", () => {
    const blocked = decideConsent({
      policy: "one_party",
      recordingEnabled: true,
      leadState: null,
    });
    expect(mayStartRecording(blocked, "granted").start).toBe(false);
  });

  it("treats a missing consent record as not-granted", () => {
    expect(mayStartRecording(allParty, null).start).toBe(false);
  });
});

describe("retention", () => {
  it("expires a recording the configured number of days later", () => {
    const created = new Date("2026-07-01T12:00:00Z");
    expect(retentionExpiry(created, 90).toISOString().slice(0, 10)).toBe("2026-09-29");
  });

  it("never produces a retention shorter than a day", () => {
    const created = new Date("2026-07-01T12:00:00Z");
    expect(retentionExpiry(created, 0).getTime()).toBeGreaterThan(created.getTime());
  });
});

describe("record one-party states, skip the two-party ones", () => {
  const base = { policy: "one_party_only" as const, recordingEnabled: true };

  it("records where one person's consent is enough, with NO announcement", () => {
    const d = decideConsent({ ...base, leadState: "TX" });
    expect(d.allowed).toBe(true);
    expect(d.announcementRequired).toBe(false);
    expect(d.affirmativeConsentRequired).toBe(false);
    expect(d.status).toBe("not_required");
  });

  it("DOES NOT RECORD AT ALL in an all-party state — it does not announce instead", () => {
    // This is the whole difference from the other policies: they handle a
    // two-party state by asking; this one handles it by walking away.
    for (const state of ALL_PARTY_CONSENT_STATES) {
      const d = decideConsent({ ...base, leadState: state });
      expect(d.allowed, state).toBe(false);
      expect(d.announcementRequired, state).toBe(false);
      expect(d.status, state).toBe("blocked");
    }
  });

  it("says which state stopped it, so nobody thinks it is broken", () => {
    expect(decideConsent({ ...base, leadState: "CA" }).reason).toMatch(/CA/);
    expect(decideConsent({ ...base, leadState: "CA" }).reason).toMatch(/not recorded/i);
  });

  it("an unknown state is not recorded either", () => {
    const d = decideConsent({ ...base, leadState: null });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe("blocked");
  });

  it("the master switch still wins", () => {
    expect(decideConsent({ ...base, recordingEnabled: false, leadState: "TX" }).allowed).toBe(false);
  });

  it("NEVER asks a caller to say anything, in any state", () => {
    const states = [...ALL_PARTY_CONSENT_STATES, "TX", "NY", "OH", null];
    for (const leadState of states) {
      expect(decideConsent({ ...base, leadState }).announcementRequired, String(leadState)).toBe(false);
    }
  });
});

/**
 * The two rules an admin asked for, in one place:
 *
 *   a two-party state can never be recorded, by anybody, by any route;
 *   a one-party state is recorded without being asked.
 *
 * Between them there is no decision left for a caller to get wrong.
 */
describe("no judgement calls left for a human", () => {
  const policy = "one_party_only" as const;
  const on = { policy, recordingEnabled: true };

  it("A TWO-PARTY STATE CANNOT BE RECORDED — no announcement, no consent, no route in", () => {
    for (const leadState of ALL_PARTY_CONSENT_STATES) {
      const d = decideConsent({ ...on, leadState });
      expect(d.allowed, leadState).toBe(false);
      expect(d.mandatory, leadState).toBe(false);
      // Crucially it does not fall back to "announce and ask", which is where
      // a caller could talk their way into recording anyway.
      expect(d.announcementRequired, leadState).toBe(false);
      expect(d.affirmativeConsentRequired, leadState).toBe(false);
      expect(d.status, leadState).toBe("blocked");
    }
  });

  it("even a prospect ENTHUSIASTICALLY agreeing cannot unlock it", () => {
    const d = decideConsent({ ...on, leadState: "MI" });
    expect(mayStartRecording(d, "granted").start).toBe(false);
    expect(mayStartRecording(d, "not_required").start).toBe(false);
  });

  it("A ONE-PARTY STATE IS RECORDED WITHOUT ASKING", () => {
    for (const leadState of ["TX", "NY", "OH", "GA", "AZ"]) {
      const d = decideConsent({ ...on, leadState });
      expect(d.allowed, leadState).toBe(true);
      expect(d.mandatory, leadState).toBe(true);
      expect(d.announcementRequired, leadState).toBe(false);
      expect(mayStartRecording(d, null).start, leadState).toBe(true);
    }
  });

  it("an unknown state is not recorded — the law that applies is unknown", () => {
    const d = decideConsent({ ...on, leadState: null });
    expect(d.allowed).toBe(false);
    expect(d.mandatory).toBe(false);
  });

  it("the master switch still beats everything", () => {
    const d = decideConsent({ ...on, recordingEnabled: false, leadState: "TX" });
    expect(d.allowed).toBe(false);
    expect(d.mandatory).toBe(false);
  });

  it("MANDATORY IS NEVER TRUE WHERE A HUMAN HAS TO SAY SOMETHING", () => {
    // If an announcement is required, a person is in the loop and the recorder
    // must not start itself behind them.
    const policies = ["all_party", "one_party", "per_state", "one_party_only", "disabled"] as const;
    const states = [...ALL_PARTY_CONSENT_STATES, "TX", "NY", null];
    for (const p of policies) {
      for (const leadState of states) {
        const d = decideConsent({ policy: p, recordingEnabled: true, leadState });
        if (d.mandatory) {
          expect(d.allowed, `${p}/${leadState}`).toBe(true);
          expect(d.announcementRequired, `${p}/${leadState}`).toBe(false);
          expect(d.affirmativeConsentRequired, `${p}/${leadState}`).toBe(false);
        }
      }
    }
  });

  /*
   * This test used to read "only the skip-two-party policy ever makes it
   * mandatory". That was the old design, and it meant the same lawful,
   * nothing-to-ask call was mandatory under one policy and optional under
   * another. The law does not change with the setting, so the rule now keys on
   * the situation rather than the policy name.
   */
  it("is mandatory wherever recording is lawful and nobody has to be asked", () => {
    for (const p of ["all_party", "one_party", "per_state", "one_party_only", "disabled"] as const) {
      for (const leadState of ["TX", "NY", "MI", "CA", null]) {
        const d = decideConsent({ policy: p, recordingEnabled: true, leadState });
        const nobodyToAsk =
          d.allowed && !d.announcementRequired && !d.affirmativeConsentRequired;
        expect(d.mandatory, `${p}/${leadState}`).toBe(nobodyToAsk);
      }
    }
  });

  it("is never mandatory while recording is switched off", () => {
    for (const p of ["all_party", "one_party", "per_state", "one_party_only"] as const) {
      expect(
        decideConsent({ policy: p, recordingEnabled: false, leadState: "TX" }).mandatory,
        p
      ).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* the dial gate                                                              */
/* -------------------------------------------------------------------------- */

/*
 * "Recording has to be mandatory so they cannot call until the mic is on."
 *
 * The rule is narrow on purpose. It blocks only where recording is REQUIRED,
 * which is only where recording is lawful on the caller's consent alone. The
 * two cases it must never block are the ones that would take the phones down.
 */
describe("A RECORDABLE CALL CANNOT BE DIALLED UNTIL THE MIC IS ON", () => {
  const oneParty = (policy: ConsentPolicy = "one_party_only") =>
    decideConsent({ policy, recordingEnabled: true, leadState: "TX" });

  it("blocks the dial while nothing is being captured", () => {
    const g = dialGate({ decision: oneParty(), capturing: false });
    expect(g.blocked).toBe(true);
    expect(g.reason).toMatch(/Start the recording before you dial/);
  });

  it("opens the moment audio is genuinely being taken", () => {
    expect(dialGate({ decision: oneParty(), capturing: true }).blocked).toBe(false);
  });

  it("applies under every policy that makes recording lawful without asking", () => {
    for (const policy of ["one_party_only", "one_party", "per_state"] as ConsentPolicy[]) {
      expect(decideConsent({ policy, recordingEnabled: true, leadState: "TX" }).mandatory).toBe(true);
      expect(dialGate({ decision: oneParty(policy), capturing: false }).blocked).toBe(true);
    }
  });

  it("NEVER blocks a call it could not record anyway", () => {
    // Michigan under one_party_only: recording is refused outright. Gating the
    // dial on a recording that will never start strands the caller on a lead
    // they can neither ring nor get past.
    const mi = decideConsent({
      policy: "one_party_only",
      recordingEnabled: true,
      leadState: "MI",
    });
    expect(mi.allowed).toBe(false);
    const g = dialGate({ decision: mi, capturing: false });
    expect(g.blocked).toBe(false);
    expect(g.reason).toMatch(/You can still make the call/);
  });

  it("NEVER blocks when recording is switched off for the whole deployment", () => {
    const off = decideConsent({ policy: "one_party_only", recordingEnabled: false, leadState: "TX" });
    expect(dialGate({ decision: off, capturing: false }).blocked).toBe(false);
  });

  it("never blocks a call that needs the prospect asked — that is a human decision", () => {
    const ca = decideConsent({ policy: "all_party", recordingEnabled: true, leadState: "CA" });
    expect(ca.affirmativeConsentRequired).toBe(true);
    expect(dialGate({ decision: ca, capturing: false }).blocked).toBe(false);
  });

  it("never blocks when the state is unknown", () => {
    const unknown = decideConsent({ policy: "one_party_only", recordingEnabled: true, leadState: null });
    expect(unknown.allowed).toBe(false);
    expect(dialGate({ decision: unknown, capturing: false }).blocked).toBe(false);
  });
});

describe("WIDENING mandatory NEVER AUTHORISES A NEW RECORDING", () => {
  it("is false everywhere an announcement or an agreement is required", () => {
    for (const policy of ["all_party", "one_party", "per_state", "one_party_only"] as ConsentPolicy[]) {
      for (const state of ["CA", "MI", "FL", "IL", "WA", null]) {
        const d = decideConsent({ policy, recordingEnabled: true, leadState: state });
        if (d.announcementRequired || d.affirmativeConsentRequired || !d.allowed) {
          expect(d.mandatory, `${policy}/${state} must not be mandatory`).toBe(false);
        }
      }
    }
  });

  it("is only ever true where recording was already allowed with nobody to ask", () => {
    for (const policy of ["all_party", "one_party", "per_state", "one_party_only"] as ConsentPolicy[]) {
      for (const state of ["TX", "NY", "OH", "CA", "MI", null]) {
        const d = decideConsent({ policy, recordingEnabled: true, leadState: state });
        if (d.mandatory) {
          expect(d.allowed).toBe(true);
          expect(d.announcementRequired).toBe(false);
          expect(d.affirmativeConsentRequired).toBe(false);
        }
      }
    }
  });
});

describe("the caller is told which kind of call this is", () => {
  it("labels each case", () => {
    const at = (policy: ConsentPolicy, state: string | null) =>
      recordabilityLabel(decideConsent({ policy, recordingEnabled: true, leadState: state }));
    expect(at("one_party_only", "TX")).toBe("RECORDED");
    expect(at("one_party_only", "MI")).toBe("NOT RECORDABLE");
    expect(at("all_party", "CA")).toBe("ASK FIRST");
  });
});

/*
 * The gate is only as good as what the recorder calls "capturing".
 *
 * Permission granted is not capture. A pressed button is not capture. A
 * microphone that is permitted but silent is exactly the failure this exists to
 * catch, and it is the state the team was in for weeks — the pill said NOT
 * RECORDING while everybody assumed calls were being kept.
 *
 * No pure test can reach a React component's internals, so this reads the
 * source for the one line that matters.
 */
describe("THE RECORDER REPORTS CAPTURE, NOT PERMISSION", () => {
  const src = readFileSync(
    new URL("../src/components/CallRecorder.tsx", import.meta.url),
    "utf8"
  );

  it("gates on audio actually being taken", () => {
    expect(src).toMatch(/capturing:\s*state === "recording"/);
  });

  it("does not report the gate from a looser state", () => {
    expect(src).not.toMatch(/capturing:\s*state !== "idle"/);
    expect(src).not.toMatch(/capturing:\s*true/);
  });

  it("never blocks before the config has loaded", () => {
    // A slow request must not look like a compliance stop.
    expect(src).toMatch(/if \(!config\)[\s\S]{0,220}blocked: false/);
  });
});
