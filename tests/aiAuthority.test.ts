import { describe, it, expect } from "vitest";
import {
  decideAuthority,
  disagreements,
  escalationSummary,
  reviewLoad,
  DEFAULT_AUTHORITY,
  HUMAN_WINS_WHEN_PRESENT,
  MATERIAL_FIELDS,
  NEVER_AUTONOMOUS,
} from "../src/lib/aiAuthority";
import type { CallAnalysisResult } from "../src/lib/callAnalysis";

const human = (over: Partial<CallAnalysisResult> = {}): CallAnalysisResult => ({
  personReached: "receptionist",
  ownerReached: false,
  interestLevel: "unknown",
  meetingStatus: "none",
  objections: [],
  ...over,
});

const ai = (over: Partial<CallAnalysisResult> = {}): CallAnalysisResult => ({
  personReached: "the owner",
  ownerReached: true,
  interestLevel: "mild",
  meetingStatus: "none",
  objections: [],
  ...over,
});

/**
 * The point of this module: 300 calls a day cannot be confirmed by hand, so the
 * model's reading is applied. These tests are what stops that being reckless.
 */
describe("the AI's reading is applied without being asked", () => {
  it("writes the model's answer over the caller's form", () => {
    const d = decideAuthority({ human: human(), ai: ai(), aiConfidence: 0.9, sample: 1 });
    expect(d.authority).toBe("ai");
    expect(d.applied.ownerReached).toBe(true);
    expect(d.applied.personReached).toBe("the owner");
  });

  it("keeps the caller's answer where the model said nothing", () => {
    const d = decideAuthority({
      human: human({ coachingPoint: "slow down at the open" }),
      ai: ai({ coachingPoint: null }),
      aiConfidence: 0.9,
      sample: 1,
    });
    expect(d.applied.coachingPoint).toBe("slow down at the open");
  });

  it("falls back to the form when there is no transcript at all", () => {
    const d = decideAuthority({ human: human(), ai: null, sample: 1 });
    expect(d.authority).toBe("form_only");
    expect(d.applied).toEqual(human());
    expect(d.escalate).toBe(false);
  });

  it("applies nothing when the setting is off", () => {
    const d = decideAuthority({
      human: human(),
      ai: ai(),
      aiConfidence: 0.99,
      settings: { aiDecides: false },
      sample: 1,
    });
    expect(d.applied.ownerReached).toBe(false);
    expect(d.authority).toBe("human");
    expect(d.held.length).toBeGreaterThan(0);
  });
});

describe("what it never decides alone", () => {
  it("refuses to lift a do-not-call the caller recorded", () => {
    const d = decideAuthority({
      human: human({ doNotCallRequested: true }),
      ai: ai({ doNotCallRequested: false }),
      aiConfidence: 0.99,
      sample: 1,
    });
    // The suppression stands.
    expect(d.applied.doNotCallRequested).toBe(true);
    expect(d.blockedActions).toContain("release_do_not_call");
    expect(d.reasons).toContain("dnc_reversal_attempted");
    expect(d.escalate).toBe(true);
  });

  it("does apply a do-not-call it heard, because suppression is the safe way", () => {
    const d = decideAuthority({
      human: human({ doNotCallRequested: null }),
      ai: ai({ doNotCallRequested: true }),
      aiConfidence: 0.9,
      sample: 1,
    });
    expect(d.applied.doNotCallRequested).toBe(true);
    expect(d.blockedActions).toEqual([]);
    // Still surfaced — it is consequential even when correct.
    expect(d.reasons).toContain("do_not_call_heard");
  });

  it("names actions rather than scoring them, because confidence cannot make them safe", () => {
    expect(NEVER_AUTONOMOUS).toContain("release_do_not_call");
    expect(NEVER_AUTONOMOUS).toContain("change_price_or_discount");
    expect(NEVER_AUTONOMOUS).toContain("change_script_or_prompt");
    expect(NEVER_AUTONOMOUS).toContain("send_message_to_prospect");
    expect(NEVER_AUTONOMOUS).toContain("judge_or_dismiss_a_caller");
  });

  it("keeps the caller's email over a transcript of it being spelled out", () => {
    const d = decideAuthority({
      human: human({ contactConfirmed: "dave@northside.com" }),
      ai: ai({ contactConfirmed: "dave at north side dot com" }),
      aiConfidence: 0.95,
      sample: 1,
    });
    expect(d.applied.contactConfirmed).toBe("dave@northside.com");
    expect(d.held.some((h) => h.field === "contactConfirmed")).toBe(true);
  });

  it("fills a contact field the caller left blank", () => {
    const d = decideAuthority({
      human: human({ contactConfirmed: null }),
      ai: ai({ contactConfirmed: "555-0142" }),
      aiConfidence: 0.9,
      sample: 1,
    });
    expect(d.applied.contactConfirmed).toBe("555-0142");
  });

  it("guards exactly the fields speech-to-text is worst at", () => {
    expect(HUMAN_WINS_WHEN_PRESENT).toContain("contactConfirmed");
    expect(HUMAN_WINS_WHEN_PRESENT).toContain("meetingAt");
  });
});

describe("what reaches a person", () => {
  it("escalates a reading the transcript could not support", () => {
    const d = decideAuthority({ human: human(), ai: ai(), aiConfidence: 0.3, sample: 1 });
    expect(d.escalate).toBe(true);
    expect(d.reasons).toContain("low_confidence");
  });

  it("escalates a contradiction that matters", () => {
    const d = decideAuthority({
      human: human({ meetingStatus: "none" }),
      ai: ai({ meetingStatus: "booked" }),
      aiConfidence: 0.9,
      sample: 1,
    });
    expect(d.reasons).toContain("material_disagreement");
  });

  it("does not escalate a contradiction that does not", () => {
    // Identical on everything material; differing only on the coaching note.
    const d = decideAuthority({
      human: human({ coachingPoint: "slow down" }),
      ai: human({ coachingPoint: "ask about after-hours" }),
      aiConfidence: 0.9,
      sample: 1,
    });
    expect(d.escalate).toBe(false);
    expect(d.disagreements.some((x) => x.field === "coachingPoint")).toBe(true);
  });

  it("escalates anything that sounded like a complaint", () => {
    const d = decideAuthority({
      human: human(),
      ai: ai({ objections: ["said he'd speak to his lawyer"] }),
      aiConfidence: 0.9,
      sample: 1,
    });
    expect(d.reasons).toContain("complaint_heard");
  });

  it("keeps a random slice so accuracy stays measurable", () => {
    // Without this, "the AI decides" becomes "nobody can tell if it is right".
    const checked = decideAuthority({
      human: human(),
      ai: human(),
      aiConfidence: 0.99,
      sample: 0.001,
    });
    expect(checked.reasons).toEqual(["spot_check"]);

    const skipped = decideAuthority({
      human: human(),
      ai: human(),
      aiConfidence: 0.99,
      sample: 0.9,
    });
    expect(skipped.escalate).toBe(false);
  });

  it("does not spot-check a call that already escalated for a real reason", () => {
    const d = decideAuthority({ human: human(), ai: ai(), aiConfidence: 0.2, sample: 0.001 });
    expect(d.reasons).toContain("low_confidence");
    expect(d.reasons).not.toContain("spot_check");
  });

  it("stays quiet on an ordinary, confident, agreeing call", () => {
    const same = human();
    const d = decideAuthority({ human: same, ai: same, aiConfidence: 0.9, sample: 0.9 });
    expect(d.escalate).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it("never repeats a reason", () => {
    const d = decideAuthority({
      human: human({ doNotCallRequested: true }),
      ai: ai({ doNotCallRequested: true }),
      aiConfidence: 0.2,
      sample: 0.001,
    });
    expect(new Set(d.reasons).size).toBe(d.reasons.length);
  });
});

describe("comparing the two readings", () => {
  it("does not call silence a disagreement", () => {
    const diffs = disagreements(human({ interestLevel: undefined }), ai({ interestLevel: "mild" }));
    expect(diffs.some((d) => d.field === "interestLevel")).toBe(false);
  });

  it("treats a deliberate false as an answer, not an absence", () => {
    const diffs = disagreements(human({ ownerReached: false }), ai({ ownerReached: true }));
    expect(diffs.some((d) => d.field === "ownerReached")).toBe(true);
  });

  it("ignores ordering and case in lists", () => {
    const diffs = disagreements(
      human({ objections: ["Cost", "Timing"] }),
      ai({ objections: ["timing", "cost"] })
    );
    expect(diffs.some((d) => d.field === "objections")).toBe(false);
  });

  it("marks the consequential fields as material", () => {
    for (const f of ["ownerReached", "meetingStatus", "doNotCallRequested"]) {
      expect(MATERIAL_FIELDS).toContain(f);
    }
  });
});

describe("the promise that you will not review 300 calls", () => {
  it("is stated as a checkable number", () => {
    expect(reviewLoad(300, 7)).toContain("7 of 300");
    expect(reviewLoad(300, 7)).toContain("2%");
    expect(reviewLoad(0, 0)).toContain("No calls analysed yet");
  });

  it("defaults to a spot check small enough to actually do", () => {
    // 2% of 300 is six calls a day.
    expect(DEFAULT_AUTHORITY.spotCheckRate).toBeLessThanOrEqual(0.05);
    expect(DEFAULT_AUTHORITY.spotCheckRate).toBeGreaterThan(0);
    expect(DEFAULT_AUTHORITY.aiDecides).toBe(true);
  });

  it("says why a call is in front of you, in words", () => {
    expect(escalationSummary(["low_confidence"])).toContain("not sure");
    expect(escalationSummary([])).toContain("Applied automatically");
  });
});
