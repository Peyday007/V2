import { describe, it, expect } from "vitest";
import {
  needsAPerson,
  actionableReasons,
  ESCALATION_LABEL,
  SYSTEM_STATE_REASONS,
} from "../src/lib/aiAuthority";
import {
  suggestionsFor,
  primarySuggestion,
  suggestedOutcomeFor,
  CALL_STAGES,
  MAX_HEADLINE,
  MAX_DETAIL,
  type AssistantContext,
} from "../src/lib/callStages";
import {
  analyzeFromOutcomeForm,
  compareResults,
  accuracyOf,
  mergeConfirmed,
  confidenceLabel,
  type CallAnalysisResult,
} from "../src/lib/callAnalysis";
import {
  triggerFor,
  deadlineFor,
  buildQueue,
  draftFollowup,
  needsAlert,
} from "../src/lib/followup";
import {
  proposeChange,
  evaluateExperiment,
  assignArm,
  summariseVariants,
  type Observation,
} from "../src/lib/learning";
import { resolveSpeaker, recordingCapability, idempotencyKeyFor } from "../src/lib/telephony";

/* ========================================================================== */
/* live assistant                                                             */
/* ========================================================================== */

function ctx(over: Partial<AssistantContext> = {}): AssistantContext {
  return { stage: "discovery", businessName: "Ace Roofing", ...over };
}

describe("the live assistant is readable mid-conversation", () => {
  it("every stage produces at least one suggestion", () => {
    for (const stage of CALL_STAGES) {
      const s = suggestionsFor(ctx({ stage }));
      expect(s.length, stage).toBeGreaterThan(0);
    }
  });

  it("nothing is long enough to need reading twice", () => {
    for (const stage of CALL_STAGES) {
      for (const s of suggestionsFor(ctx({ stage, objectionKey: "cost" }))) {
        expect(s.headline.length, `${stage}: ${s.headline}`).toBeLessThanOrEqual(MAX_HEADLINE);
        if (s.detail) {
          expect(s.detail.length, `${stage}: ${s.detail}`).toBeLessThanOrEqual(MAX_DETAIL);
        }
      }
    }
  });

  it("shows exactly one primary suggestion", () => {
    const p = primarySuggestion(ctx({ stage: "gatekeeper" }));
    expect(p).toBeTruthy();
    expect(p!.type).toBe("ask_for_owner");
  });

  it("uses the owner's name when it is known", () => {
    expect(primarySuggestion(ctx({ stage: "dialing", ownerName: "Mike" }))!.headline).toContain(
      "Mike"
    );
    expect(primarySuggestion(ctx({ stage: "dialing" }))!.headline).toContain("the owner");
  });
});

describe("compliance outranks selling", () => {
  it("a do-not-call request takes over the panel from any stage", () => {
    const p = primarySuggestion(ctx({ stage: "qualified_interest", dncHeard: true }));
    expect(p!.type).toBe("compliance_warning");
    expect(p!.headline).toContain("stop pitching");
  });

  it("an unread recording notice outranks the sales suggestion", () => {
    const p = primarySuggestion(ctx({ stage: "meeting_request", awaitingConsent: true }));
    expect(p!.type).toBe("compliance_warning");
  });

  it("a do-not-call request outranks even the consent notice", () => {
    const p = primarySuggestion(ctx({ stage: "discovery", dncHeard: true, awaitingConsent: true }));
    expect(p!.headline).toContain("stop pitching");
  });
});

describe("the assistant chases what is missing", () => {
  it("asks the qualifying question when the setup is unknown", () => {
    const s = suggestionsFor(ctx({ stage: "discovery" }));
    expect(s.some((x) => x.type === "missing_qualification")).toBe(true);
  });

  it("stops asking once it has been answered", () => {
    const s = suggestionsFor(ctx({ stage: "discovery", answeringSetup: "Office staff answers" }));
    expect(s.some((x) => x.headline.includes("How are calls handled"))).toBe(false);
  });

  it("will not let interest be logged as a meeting without a time", () => {
    const s = suggestionsFor(ctx({ stage: "meeting_request", meetingTimeAgreed: false }));
    expect(
      s.some((x) => x.headline.toLowerCase().includes("do not log this as booked"))
    ).toBe(true);
  });

  it("chases the email before a booked meeting is left", () => {
    const s = suggestionsFor(ctx({ stage: "meeting_booked", contactConfirmed: false }));
    expect(s.some((x) => x.headline.includes("Confirm the email"))).toBe(true);
  });

  it("challenges a no from someone who may not decide", () => {
    const s = suggestionsFor(ctx({ stage: "not_interested" }));
    expect(s[0].headline).toContain("your call");
  });
});

describe("suggestedOutcomeFor pre-selects rather than decides", () => {
  it("maps the stages that map cleanly", () => {
    expect(suggestedOutcomeFor("meeting_booked")).toBe("appointment_set");
    expect(suggestedOutcomeFor("do_not_call")).toBe("do_not_call");
    expect(suggestedOutcomeFor("gatekeeper")).toBe("gatekeeper");
  });
  it("offers nothing for stages that do not imply an outcome", () => {
    expect(suggestedOutcomeFor("dialing")).toBeNull();
    expect(suggestedOutcomeFor("dm_not_confirmed")).toBeNull();
  });
});

/* ========================================================================== */
/* post-call analysis                                                         */
/* ========================================================================== */

describe("analysis from the outcome form", () => {
  it("reads a decision-maker conversation", () => {
    const { result, confidence } = analyzeFromOutcomeForm({
      outcome: "dm_conversation",
      reachedDm: true,
      details: {
        dm_name: "Mike Reynolds",
        answering_setup: "Calls go to voicemail",
        main_problem: "Missed calls",
        interest_level: "Strong interest",
        next_step: "Send pricing",
      },
    });
    expect(result.personReached).toBe("Mike Reynolds");
    expect(result.ownerReached).toBe(true);
    expect(result.liveAnswer).toBe(true);
    expect(result.interestLevel).toBe("strong");
    expect(result.qualificationStatus).toBe("qualified");
    expect(confidence).toBeGreaterThan(0.5);
  });

  it("never claims certainty from a form", () => {
    const { confidence } = analyzeFromOutcomeForm({
      outcome: "dm_conversation",
      reachedDm: true,
      details: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" },
      notes: "x".repeat(200),
    });
    expect(confidence).toBeLessThanOrEqual(0.9);
  });

  it("is confident about nobody answering, because that is hard to misread", () => {
    const { result, confidence } = analyzeFromOutcomeForm({
      outcome: "no_answer",
      details: {},
    });
    expect(result.liveAnswer).toBe(false);
    expect(confidence).toBeGreaterThan(0.8);
  });

  it("spots the missed opportunities", () => {
    const { result } = analyzeFromOutcomeForm({
      outcome: "dm_conversation",
      reachedDm: true,
      details: { dm_name: "Mike" },
    });
    expect(result.missedOpportunities).toContain(
      "Reached the decision-maker but did not book a meeting"
    );
    expect(result.missedOpportunities).toContain(
      "Did not find out how they handle calls today"
    );
  });

  it("flags a no taken from someone who may not decide", () => {
    const { result } = analyzeFromOutcomeForm({
      outcome: "not_interested",
      details: { said_by_role: "Gatekeeper", reason: "Too expensive" },
    });
    expect(result.missedOpportunities).toContain("Took a no from someone who may not decide");
    expect(result.objections).toContain("Too expensive");
  });

  it("collects everything newly learned about the business", () => {
    const { result } = analyzeFromOutcomeForm({
      outcome: "gatekeeper",
      details: { answering_setup: "Office staff answers", best_call_time: "before 9am" },
    });
    expect(result.newInformation?.join(" ")).toContain("Office staff answers");
    expect(result.newInformation?.join(" ")).toContain("before 9am");
  });

  it("reads a do-not-call request", () => {
    const { result } = analyzeFromOutcomeForm({ outcome: "do_not_call", details: {} });
    expect(result.doNotCallRequested).toBe(true);
  });
});

describe("the machine never overwrites the person", () => {
  const ai: CallAnalysisResult = {
    ownerReached: true,
    interestLevel: "strong",
    objections: ["Too expensive"],
    coachingPoint: "Ask for the meeting sooner",
  };

  it("a human edit wins", () => {
    const merged = mergeConfirmed(ai, { interestLevel: "mild" });
    expect(merged.interestLevel).toBe("mild");
    expect(merged.ownerReached).toBe(true); // untouched, machine value kept
  });

  it("an explicit empty from a person is honoured, not treated as unset", () => {
    const merged = mergeConfirmed(ai, { coachingPoint: null });
    expect(merged.coachingPoint).toBeNull();
  });

  it("records exactly which fields the person changed", () => {
    const confirmed = mergeConfirmed(ai, { interestLevel: "mild" });
    const diff = compareResults(ai, confirmed);
    expect(diff.find((d) => d.field === "interestLevel")!.changed).toBe(true);
    expect(diff.find((d) => d.field === "ownerReached")!.changed).toBe(false);
  });

  it("measures accuracy only over fields that were actually assessed", () => {
    const confirmed = mergeConfirmed(ai, { interestLevel: "mild" });
    const acc = accuracyOf(compareResults(ai, confirmed));
    expect(acc.assessed).toBe(4);
    expect(acc.agreed).toBe(3);
    expect(acc.rate).toBeCloseTo(0.75, 5);
  });

  it("does not compare array order", () => {
    const diff = compareResults({ objections: ["a", "b"] }, { objections: ["b", "a"] });
    expect(diff.find((d) => d.field === "objections")!.changed).toBe(false);
  });

  it("has no accuracy to report when nothing was assessed", () => {
    expect(accuracyOf(compareResults({}, {})).rate).toBeNull();
  });

  it("labels low confidence as something to check", () => {
    expect(confidenceLabel(0.4)).toContain("check every field");
    expect(confidenceLabel(0.9)).toBe("high");
    expect(confidenceLabel(null)).toBe("not assessed");
  });
});

/* ========================================================================== */
/* follow-up                                                                  */
/* ========================================================================== */

describe("follow-up triggers only on something real", () => {
  it("fires when they asked for information and gave an address", () => {
    const t = triggerFor("dm_conversation", {
      followupRequested: true,
      contactConfirmed: "mike@ace.example",
    });
    expect(t?.kind).toBe("email");
    expect(t?.target).toBe("mike@ace.example");
  });

  it("fires on a booked meeting so it gets confirmed in writing", () => {
    expect(triggerFor("appointment_set", {})?.reason).toContain("confirm it in writing");
  });

  it("falls back to a call-back when there is no address", () => {
    expect(triggerFor("dm_conversation", { interestLevel: "strong" })?.kind).toBe("call_back");
  });

  it("does NOT fire for an ordinary call", () => {
    expect(triggerFor("no_answer", {})).toBeNull();
    expect(triggerFor("gatekeeper", {})).toBeNull();
    expect(triggerFor("dm_conversation", { interestLevel: "mild" })).toBeNull();
  });

  it("never fires for someone who asked not to be contacted", () => {
    expect(
      triggerFor("do_not_call", { doNotCallRequested: true, followupRequested: true })
    ).toBeNull();
  });
});

describe("deadlines", () => {
  const now = new Date("2026-07-22T14:00:00Z");
  const emailTrigger = { reason: "r", kind: "email" as const, target: "a@b.c" };

  it("defaults to the configured minutes", () => {
    expect(deadlineFor(emailTrigger, now, 10).getTime() - now.getTime()).toBe(10 * 60_000);
  });

  it("honours a time the prospect actually asked for", () => {
    const asked = "2026-07-23T09:00:00.000Z";
    expect(deadlineFor(emailTrigger, now, 10, asked).toISOString()).toBe(asked);
  });

  it("ignores a requested time already in the past", () => {
    const past = "2026-07-01T09:00:00.000Z";
    expect(deadlineFor(emailTrigger, now, 10, past).getTime()).toBeGreaterThan(now.getTime());
  });

  it("gives a promised call-back longer than a warm email", () => {
    const cb = { reason: "r", kind: "call_back" as const, target: null };
    expect(deadlineFor(cb, now, 10).getTime() - now.getTime()).toBe(60 * 60_000);
  });
});

describe("the queue surfaces what is late", () => {
  const now = new Date("2026-07-22T14:00:00Z");
  const at = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();

  it("puts overdue first, then due now, then the rest", () => {
    const q = buildQueue(
      [
        { id: "later", dueAt: at(120), status: "pending" },
        { id: "late", dueAt: at(-30), status: "pending" },
        { id: "soon", dueAt: at(15), status: "drafted" },
        { id: "now", dueAt: at(1), status: "pending" },
      ],
      now
    );
    expect(q.map((e) => e.id)).toEqual(["late", "now", "soon", "later"]);
  });

  it("says how late, in words", () => {
    const [e] = buildQueue([{ id: "a", dueAt: at(-45), status: "pending" }], now);
    expect(e.urgency).toBe("overdue");
    expect(e.urgencyLabel).toBe("45 min late");
  });

  it("drops finished work to the bottom without calling it late", () => {
    const [e] = buildQueue([{ id: "a", dueAt: at(-500), status: "sent" }], now);
    expect(e.urgency).toBe("done");
    expect(e.minutesLate).toBe(0);
  });

  it("alerts once, on something overdue", () => {
    expect(needsAlert({ urgency: "overdue" })).toBe(true);
    expect(needsAlert({ urgency: "overdue", alertedAt: "2026-07-22T13:00:00Z" })).toBe(false);
    expect(needsAlert({ urgency: "soon" })).toBe(false);
  });
});

describe("drafts use only what the call established", () => {
  it("names the problem they actually stated", () => {
    const d = draftFollowup({
      businessName: "Ace Roofing",
      contactName: "Mike Reynolds",
      callerName: "Jack",
      trigger: { reason: "r", kind: "email", target: "m@a.c" },
      analysis: { needsDiscovered: ["Missed calls"] },
    });
    expect(d.body).toContain("Mike");
    expect(d.body).toContain("missed calls");
    expect(d.body).toContain("Jack");
  });

  it("does not invent a problem when none was discovered", () => {
    const d = draftFollowup({
      businessName: "Ace Roofing",
      callerName: "Jack",
      trigger: { reason: "r", kind: "email", target: null },
      analysis: {},
    });
    expect(d.body).not.toContain("you mentioned");
    expect(d.body).toContain("Hi there,");
  });

  it("confirms a booked meeting with its real date", () => {
    const d = draftFollowup({
      businessName: "Ace Roofing",
      contactName: "Mike",
      callerName: "Jack",
      trigger: { reason: "r", kind: "email", target: "m@a.c" },
      analysis: { meetingAt: "2026-08-06T13:00:00.000Z" },
    });
    expect(d.subject).toContain("Confirming");
    expect(d.body).toContain("Confirming we are speaking");
  });

  it("never invents a price", () => {
    const d = draftFollowup({
      businessName: "Ace",
      callerName: "Jack",
      trigger: { reason: "r", kind: "email", target: null },
      analysis: { needsDiscovered: ["Missed calls"] },
    });
    expect(d.body).not.toMatch(/\$\d/);
  });
});

/* ========================================================================== */
/* learning                                                                   */
/* ========================================================================== */

function obs(over: Partial<Observation> = {}): Observation {
  return {
    callId: Math.random().toString(36).slice(2),
    callerId: "c1",
    dimension: "opening",
    variant: "A",
    industry: "roofing",
    outcomeType: "owner_conversation",
    succeeded: false,
    ...over,
  };
}

function many(n: number, wins: number, over: Partial<Observation> = {}): Observation[] {
  return Array.from({ length: n }, (_, i) => obs({ ...over, succeeded: i < wins }));
}

describe("the engine refuses far more often than it proposes", () => {
  const opts = { minimumSample: 40, primaryMetric: "owner_conversation" as const };

  it("says nothing with no observations", () => {
    const d = proposeChange([], opts);
    expect(d.propose).toBe(false);
  });

  it("says nothing when only one approach has been tried", () => {
    const d = proposeChange(many(100, 40, { variant: "A" }), opts);
    expect(d.propose).toBe(false);
    if (!d.propose) expect(d.reason).toContain("nothing to compare");
  });

  it("refuses below the minimum sample, and says how many more are needed", () => {
    // B is the incumbent (most used); A looks better but neither has the
    // volume to say so.
    const d = proposeChange(
      [
        ...many(10, 8, { variant: "A", callerId: "a1" }),
        ...many(6, 6, { variant: "A", callerId: "a2" }),
        ...many(20, 4, { variant: "B", callerId: "b1" }),
      ],
      opts
    );
    expect(d.propose).toBe(false);
    if (!d.propose) expect(d.reason).toContain("more needed");
  });

  it("refuses to adopt one person's style as policy", () => {
    const d = proposeChange(
      [
        ...many(60, 40, { variant: "A", callerId: "solo" }),
        ...many(60, 12, { variant: "B", callerId: "b1" }),
        ...many(20, 4, { variant: "B", callerId: "b2" }),
      ],
      { ...opts, minimumCallers: 2 }
    );
    expect(d.propose).toBe(false);
    if (!d.propose) expect(d.reason).toContain("one person's style");
  });

  it("refuses when the difference is within normal variation", () => {
    const d = proposeChange(
      [
        ...many(60, 31, { variant: "A", callerId: "a1" }),
        ...many(60, 30, { variant: "B", callerId: "b1" }),
      ],
      opts
    );
    expect(d.propose).toBe(false);
  });

  it("DOES propose a real, well-sampled, multi-caller difference", () => {
    const d = proposeChange(
      [
        ...many(60, 40, { variant: "direct_ask", callerId: "a1" }),
        ...many(60, 38, { variant: "direct_ask", callerId: "a2" }),
        ...many(80, 20, { variant: "soft_open", callerId: "b1" }),
        ...many(80, 18, { variant: "soft_open", callerId: "b2" }),
      ],
      opts
    );
    expect(d.propose).toBe(true);
    if (d.propose) {
      expect(d.evidence.candidateVariant).toBe("direct_ask");
      expect(d.evidence.sampleSize).toBe(280);
      expect(d.evidence.pValue).toBeLessThan(0.05);
      expect(d.evidence.supportingCallIds.length).toBeGreaterThan(0);
      expect(d.evidence.controlledFor).toContain("caller");
    }
  });

  it("states what it could NOT control for", () => {
    const d = proposeChange(
      [
        ...many(60, 40, { variant: "direct_ask", callerId: "a1", industry: "roofing" }),
        ...many(60, 38, { variant: "direct_ask", callerId: "a2", industry: "roofing" }),
        ...many(80, 20, { variant: "soft_open", callerId: "b1", industry: "roofing" }),
        ...many(80, 18, { variant: "soft_open", callerId: "b2", industry: "roofing" }),
      ],
      opts
    );
    if (d.propose) expect(d.evidence.notControlledFor).toContain("industry");
  });
});

describe("summariseVariants", () => {
  it("ignores observations with no outcome yet", () => {
    const stats = summariseVariants(
      [obs({ variant: "A", succeeded: true }), obs({ variant: "A", succeeded: null })],
      "owner_conversation"
    );
    expect(stats[0].trials).toBe(1);
  });

  it("ignores a different outcome type", () => {
    const stats = summariseVariants(
      [obs({ variant: "A", outcomeType: "sale", succeeded: true })],
      "owner_conversation"
    );
    expect(stats).toEqual([]);
  });
});

describe("experiments promote only on a real win with no collateral damage", () => {
  const base = {
    primaryMetric: "owner_conversation" as const,
    minimumSample: 40,
    guardrails: [],
  };

  it("keeps running below the minimum sample", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 20, successes: 6 },
      candidate: { trials: 20, successes: 12 },
    });
    expect(v.decision).toBe("keep_running");
  });

  it("promotes a genuine improvement", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 200, successes: 60 },
      candidate: { trials: 200, successes: 110 },
    });
    expect(v.decision).toBe("promote");
    expect(v.primaryImproved).toBe(true);
  });

  it("abandons a change that made things worse", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 200, successes: 110 },
      candidate: { trials: 200, successes: 60 },
    });
    expect(v.decision).toBe("abandon");
  });

  it("REFUSES to promote a primary win that costs attended meetings", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 200, successes: 60 },
      candidate: { trials: 200, successes: 110 },
      guardrails: [
        {
          outcome: "meeting_attended",
          baseline: { trials: 60, successes: 42 },
          candidate: { trials: 110, successes: 40 },
        },
      ],
    });
    expect(v.decision).toBe("abandon");
    expect(v.reason).toContain("Guardrail moved the wrong way");
    expect(v.reason).toContain("not promoted even if the primary metric improved");
  });

  it("REFUSES to promote a primary win that raises complaints", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 200, successes: 60 },
      candidate: { trials: 200, successes: 110 },
      guardrails: [
        {
          outcome: "complaint",
          baseline: { trials: 200, successes: 2 },
          candidate: { trials: 200, successes: 20 },
        },
      ],
    });
    expect(v.decision).toBe("abandon");
  });

  it("does not trip a guardrail on a rounding wobble", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 200, successes: 60 },
      candidate: { trials: 200, successes: 110 },
      guardrails: [
        {
          outcome: "meeting_attended",
          baseline: { trials: 100, successes: 70 },
          candidate: { trials: 100, successes: 69 },
        },
      ],
    });
    expect(v.decision).toBe("promote");
  });

  it("does not trip a guardrail it cannot yet judge", () => {
    const v = evaluateExperiment({
      ...base,
      baseline: { trials: 200, successes: 60 },
      candidate: { trials: 200, successes: 110 },
      guardrails: [
        {
          outcome: "sale",
          baseline: { trials: 3, successes: 3 },
          candidate: { trials: 2, successes: 0 },
        },
      ],
    });
    expect(v.decision).toBe("promote");
    expect(v.guardrails[0].detail).toContain("too few to judge");
  });
});

describe("experiment assignment is stable", () => {
  it("puts the same call in the same arm every time", () => {
    const id = "call-abc-123";
    expect(assignArm(id, 50)).toBe(assignArm(id, 50));
  });

  it("sends everything to baseline at 0% and everything to candidate at 100%", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `call-${i}`);
    expect(ids.every((i) => assignArm(i, 0) === "baseline")).toBe(true);
    expect(ids.every((i) => assignArm(i, 100) === "candidate")).toBe(true);
  });

  it("splits roughly evenly at 50%", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `call-${i}`);
    const candidate = ids.filter((i) => assignArm(i, 50) === "candidate").length;
    expect(candidate).toBeGreaterThan(400);
    expect(candidate).toBeLessThan(600);
  });
});

/* ========================================================================== */
/* telephony                                                                  */
/* ========================================================================== */

describe("telephony is honest about not being connected", () => {
  it("reports recording as unavailable, with the reason and the remedy", () => {
    const c = recordingCapability();
    expect(c.available).toBe(false);
    expect(c.reason).toContain("no audio reaches this system");
    expect(c.remedy).toContain("TELEPHONY_PROVIDER");
  });

  it("keys ingest on the provider's own id so retries cannot duplicate", () => {
    const key = idempotencyKeyFor({ providerCallSid: "CA1", providerRecordingSid: "RE1", status: "completed" });
    expect(key).toBe("telephony:RE1");
    expect(idempotencyKeyFor({ providerCallSid: "CA1", status: "completed" })).toBe("telephony:CA1");
  });
});

describe("speaker labelling admits uncertainty", () => {
  it("accepts a confident label", () => {
    expect(resolveSpeaker("caller", 0.95)).toEqual({ speaker: "caller", uncertain: false });
  });

  it("downgrades a low-confidence label to unknown rather than guessing", () => {
    const r = resolveSpeaker("prospect", 0.4);
    expect(r.speaker).toBe("unknown");
    expect(r.uncertain).toBe(true);
  });

  it("treats an unrecognised label as unknown", () => {
    expect(resolveSpeaker("agent", 0.99).speaker).toBe("unknown");
    expect(resolveSpeaker(null, null).speaker).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */
/* what is work, and what is just how the system is set up                    */
/* -------------------------------------------------------------------------- */

describe("A REASON THAT DESCRIBES THE SETUP IS NOT A JOB FOR ANYBODY", () => {
  /*
   * This reached production. With recording off — the normal state, and the
   * only lawful one in the fourteen all-party consent states — every call has
   * no transcript. "no_transcript" was a review reason, so every call ever
   * made landed in the queue saying "there was nothing to read" and offering a
   * human the choice of "read it right" or "got it wrong" about a reading that
   * was never made. Thirty in a day.
   */
  it("no_transcript on its own does not need a person", () => {
    expect(needsAPerson(["no_transcript"])).toBe(false);
    expect(needsAPerson([])).toBe(false);
  });

  it("but anything real does", () => {
    for (const reason of [
      "low_confidence",
      "material_disagreement",
      "do_not_call_heard",
      "dnc_reversal_attempted",
      "complaint_heard",
      "spot_check",
    ]) {
      expect(needsAPerson([reason]), reason).toBe(true);
    }
  });

  it("and a real reason ALONGSIDE no_transcript still needs a person", () => {
    // The dangerous over-correction: filtering the row out because it mentions
    // no_transcript would hide a genuine escalation.
    expect(needsAPerson(["no_transcript", "do_not_call_heard"])).toBe(true);
    expect(needsAPerson(["no_transcript", "spot_check"])).toBe(true);
  });

  it("the reason is still recorded — it explains where the reading came from", () => {
    // Dropping it entirely would lose the answer to "why is this from the
    // form rather than the recording".
    expect(ESCALATION_LABEL.no_transcript).toBeTruthy();
    expect(SYSTEM_STATE_REASONS).toContain("no_transcript");
  });

  it("actionableReasons strips only the system-state ones", () => {
    expect(actionableReasons(["no_transcript", "low_confidence"])).toEqual(["low_confidence"]);
    expect(actionableReasons(["no_transcript"])).toEqual([]);
  });

  it("an unknown future reason is treated as real, not silently dropped", () => {
    // Fail toward showing a person too much rather than too little.
    expect(needsAPerson(["some_reason_added_later"])).toBe(true);
  });
});
