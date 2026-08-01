import { describe, it, expect } from "vitest";
import {
  inferStage,
  guidedCall,
  likelyOutcome,
  spokeWithRoleFor,
  attemptSummary,
  PRIMARY_OUTCOMES,
  MORE_OUTCOMES,
  SPEAKING_WITH_LABEL,
  type SpeakingWith,
} from "../src/lib/dialerFocus";
import { OUTCOME_FORM_MAP, OUTCOME_FORMS } from "../src/lib/outcomeForms";
import type { LeadIntel } from "../src/lib/callGuidance";
import { CALL_STAGES } from "../src/lib/callStages";

const lead = (over: Partial<LeadIntel> = {}): LeadIntel => ({
  owner_name: null,
  owner_title: null,
  extension: null,
  direct_number: null,
  best_call_day: null,
  best_call_time: null,
  gatekeeper_name: null,
  other_decision_maker: null,
  owner_reached: false,
  last_next_step: null,
  attempt_count: 0,
  ...over,
});

/**
 * The old screen asked the caller to pick one of thirteen call stages, mid
 * conversation. This works it out from the one thing they actually know.
 */
describe("the call stage is inferred, not asked for", () => {
  it("is dialing until somebody picks up", () => {
    expect(inferStage({ speakingWith: "nobody" })).toBe("dialing");
  });

  it("is gatekeeper when reception answered", () => {
    expect(inferStage({ speakingWith: "gatekeeper" })).toBe("gatekeeper");
  });

  it("is a confirmed decision-maker on a first owner conversation", () => {
    expect(inferStage({ speakingWith: "owner" })).toBe("dm_confirmed");
  });

  it("moves to discovery once they are past the opening line", () => {
    expect(inferStage({ speakingWith: "owner", lineIndex: 1 })).toBe("discovery");
  });

  it("starts in discovery with an owner already reached before", () => {
    // Nobody re-introduces themselves to someone they spoke to last week.
    expect(inferStage({ speakingWith: "owner", ownerReachedBefore: true })).toBe("discovery");
  });

  it("an objection outranks where they are in the script", () => {
    expect(
      inferStage({ speakingWith: "owner", objectionKey: "cost", lineIndex: 3 })
    ).toBe("objection");
    expect(
      inferStage({ speakingWith: "gatekeeper", objectionKey: "owner_unavailable" })
    ).toBe("objection");
  });

  it("ignores an objection while nobody has answered", () => {
    // A stale objection from a previous attempt must not claim someone is on
    // the line when the phone is still ringing.
    expect(inferStage({ speakingWith: "nobody", objectionKey: "cost" })).toBe("dialing");
  });

  it("only ever returns a real stage", () => {
    const stages = new Set<string>(CALL_STAGES);
    for (const speakingWith of ["nobody", "gatekeeper", "owner"] as SpeakingWith[]) {
      for (const objectionKey of [null, "cost"]) {
        for (const lineIndex of [0, 2]) {
          const s = inferStage({ speakingWith, objectionKey, lineIndex });
          expect(stages.has(s), s).toBe(true);
        }
      }
    }
  });
});

describe("what gets saved about who was on the phone", () => {
  it("reports a role only when there is one to report", () => {
    expect(spokeWithRoleFor("owner")).toBe("owner");
    expect(spokeWithRoleFor("gatekeeper")).toBe("gatekeeper");
    // Never claims a role from silence — the server treats null as unknown.
    expect(spokeWithRoleFor("nobody")).toBeNull();
  });
});

/**
 * "Who to ask for", "Call objective" and "Script" were three cards restating
 * one idea. One goal, then one line at a time.
 */
describe("the guided call", () => {
  it("names the owner when we know it", () => {
    const g = guidedCall(lead({ owner_name: "Dave Mercer" }), "nobody");
    expect(g.goal).toContain("Dave Mercer");
    expect(g.lines[0].line).toContain("Dave Mercer");
  });

  it("asks who the owner is when we do not know", () => {
    const g = guidedCall(lead(), "nobody");
    expect(g.goal).toMatch(/who the owner is/i);
    expect(g.lines[0].line).toMatch(/the owner/i);
  });

  it("switches the whole script when reception answers", () => {
    const dialing = guidedCall(lead(), "nobody");
    const gate = guidedCall(lead(), "gatekeeper");
    expect(gate.goal).not.toBe(dialing.goal);
    expect(gate.lines[0].line).not.toBe(dialing.lines[0].line);
    expect(gate.goal).toMatch(/name|time/i);
  });

  it("goes straight to the pitch when the owner is on the line", () => {
    const g = guidedCall(lead(), "owner");
    expect(g.lines.some((l) => /missed/i.test(l.line))).toBe(true);
    expect(g.lines.some((l) => /Tuesday or Thursday/i.test(l.line))).toBe(true);
  });

  it("picks up the promised next step instead of re-pitching", () => {
    const g = guidedCall(
      lead({ owner_reached: true, last_next_step: "send the pricing sheet" }),
      "owner"
    );
    expect(g.goal).toContain("send the pricing sheet");
  });

  it("surfaces a direct line and extension as notes, not as another card", () => {
    const g = guidedCall(lead({ extension: "12", direct_number: "555-0000" }), "nobody");
    expect(g.notes.join(" ")).toContain("12");
    expect(g.notes.join(" ")).toContain("555-0000");
  });

  it("carries no notes when there is nothing worth saying", () => {
    expect(guidedCall(lead(), "nobody").notes).toEqual([]);
  });

  it("always has at least one line to say", () => {
    for (const w of ["nobody", "gatekeeper", "owner"] as SpeakingWith[]) {
      const g = guidedCall(lead(), w);
      expect(g.lines.length, w).toBeGreaterThan(0);
      expect(g.goal.length, w).toBeGreaterThan(10);
      for (const l of g.lines) expect(l.line.length, w).toBeGreaterThan(10);
    }
  });
});

describe("the outcome bar", () => {
  it("keeps exactly the six common outcomes visible", () => {
    expect(PRIMARY_OUTCOMES).toEqual([
      "no_answer",
      "voicemail",
      "callback",
      "transferred",
      "not_interested",
      "appointment_set",
    ]);
  });

  it("puts the rare ones behind the menu, including the dangerous one", () => {
    expect(MORE_OUTCOMES).toContain("do_not_call");
    expect(MORE_OUTCOMES).toContain("bad_number");
    expect(MORE_OUTCOMES).toContain("gatekeeper");
    expect(MORE_OUTCOMES).toContain("dm_conversation");
  });

  it("covers every outcome the platform can save, with no duplicates", () => {
    const shown = [...PRIMARY_OUTCOMES, ...MORE_OUTCOMES];
    expect(new Set(shown).size).toBe(shown.length);
    expect([...shown].sort()).toEqual(OUTCOME_FORMS.map((o) => o.value).sort());
  });

  it("every button has a form behind it", () => {
    for (const v of [...PRIMARY_OUTCOMES, ...MORE_OUTCOMES]) {
      expect(OUTCOME_FORM_MAP[v], v).toBeTruthy();
    }
  });

  it("points at the likely outcome once somebody has answered", () => {
    expect(likelyOutcome("owner")).toBe("dm_conversation");
    expect(likelyOutcome("gatekeeper")).toBe("gatekeeper");
    expect(likelyOutcome("nobody")).toBeNull();
  });

  it("only ever suggests an outcome hidden behind the menu", () => {
    // Suggesting one already on screen would be noise.
    for (const w of ["nobody", "gatekeeper", "owner"] as SpeakingWith[]) {
      const s = likelyOutcome(w);
      if (s) expect(MORE_OUTCOMES as readonly string[]).toContain(s);
    }
  });
});

describe("the header", () => {
  it("says first attempt rather than attempt 1", () => {
    expect(attemptSummary(0, false)).toBe("First attempt");
  });

  it("says whether the owner was ever reached, which changes the opening", () => {
    expect(attemptSummary(2, true)).toContain("owner reached before");
    expect(attemptSummary(2, false)).toContain("never reached the owner");
  });

  it("counts this attempt, not the last one", () => {
    expect(attemptSummary(3, false)).toContain("Attempt 4");
  });

  it("does not go negative on bad data", () => {
    expect(attemptSummary(-5, false)).toBe("First attempt");
  });

  it("labels each answer in plain words", () => {
    expect(SPEAKING_WITH_LABEL.nobody).toBe("Nobody yet");
    expect(SPEAKING_WITH_LABEL.gatekeeper).toBe("Reception");
    expect(SPEAKING_WITH_LABEL.owner).toBe("The owner");
  });
});
