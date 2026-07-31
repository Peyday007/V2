import { describe, it, expect } from "vitest";
import {
  decideConsent,
  mayStartRecording,
  isAllPartyState,
  retentionExpiry,
  ALL_PARTY_CONSENT_STATES,
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
