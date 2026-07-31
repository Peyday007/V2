import { describe, it, expect } from "vitest";
import {
  buildBriefing,
  activitySection,
  attentionSection,
  learnedSection,
  observationsSection,
  horizonSection,
  targetsSection,
  callsSince,
  MIN_FOR_OBSERVATION,
  type BriefingInput,
} from "../src/lib/briefing";
import type { CallFact } from "../src/lib/analytics";

const NOW = new Date("2026-07-28T15:00:00Z");

function call(over: Partial<CallFact> = {}): CallFact {
  return {
    outcome: "no_answer",
    reached_dm: false,
    caller_name: "Jack",
    lead_industry: "roofing",
    lead_state: "MI",
    dialed_hour: 9,
    dialed_dow: 2,
    attempt_number: 1,
    duration_seconds: 40,
    owner_known_before: false,
    created_at: NOW.toISOString(),
    ...over,
  };
}

function won(over: Partial<CallFact> = {}): CallFact {
  return call({ reached_dm: true, outcome: "dm_conversation", ...over });
}

function input(over: Partial<BriefingInput> = {}): BriefingInput {
  return {
    calls: [],
    objections: [],
    appointments: [],
    callbacks: [],
    learned: {
      ownerNames: 0,
      bestCallTimes: 0,
      directNumbers: 0,
      answeringSetups: 0,
      existingProviders: 0,
      gatekeeperNames: 0,
      totalLeadsTouched: 0,
    },
    readyToCall: 0,
    pendingInPackets: 100,
    now: NOW,
    ...over,
  };
}

describe("the briefing always says something true", () => {
  it("handles a completely empty system without throwing", () => {
    const b = buildBriefing(input());
    expect(b.headline).toBe("No calls logged yet");
    expect(b.sections.length).toBeGreaterThan(0);
  });

  it("every section has a title and an empty message, so none render blank", () => {
    const b = buildBriefing(input());
    for (const s of b.sections) {
      expect(s.title.length, s.key).toBeGreaterThan(0);
      expect(s.emptyText.length, s.key).toBeGreaterThan(0);
    }
  });

  it("leads with appointments when there are any", () => {
    const b = buildBriefing(
      input({ calls: [won({ outcome: "appointment_set" }), call(), call()] })
    );
    expect(b.headline).toContain("1 appointment");
  });

  it("says plainly when no owner has been reached", () => {
    const b = buildBriefing(input({ calls: [call(), call()] }));
    expect(b.headline).toContain("no owner reached yet");
  });

  it("singularises, so it never reads '1 calls'", () => {
    const b = buildBriefing(input({ calls: [call()] }));
    expect(b.headline).toContain("1 call ");
    expect(b.headline).not.toContain("1 calls");
  });
});

describe("callsSince", () => {
  it("keeps only calls inside the window", () => {
    const old = call({ created_at: "2026-07-01T10:00:00Z" });
    const fresh = call({ created_at: "2026-07-28T09:00:00Z" });
    expect(callsSince([old, fresh], 1, NOW)).toEqual([fresh]);
  });

  it("ignores an unparseable timestamp instead of crashing", () => {
    expect(callsSince([call({ created_at: "not a date" })], 7, NOW)).toEqual([]);
  });
});

describe("activity reports what happened, per caller", () => {
  it("counts calls, connects and owner conversations", () => {
    const s = activitySection([won(), call(), call({ outcome: "voicemail" })], NOW);
    const text = s.lines.map((l) => l.text).join(" | ");
    expect(text).toContain("3 calls");
    expect(text).toContain("1 owner conversation");
  });

  it("breaks the week down by caller", () => {
    const s = activitySection([won({ caller_name: "Jack" }), call({ caller_name: "Sam" })], NOW);
    const text = s.lines.map((l) => l.text).join(" | ");
    expect(text).toContain("Jack made 1 call");
    expect(text).toContain("Sam made 1 call");
  });

  it("reports time on the phone only from timed calls", () => {
    const s = activitySection(
      [call({ duration_seconds: 120 }), call({ duration_seconds: null })],
      NOW
    );
    const line = s.lines.find((l) => l.text.includes("minutes on the phone"));
    expect(line?.text).toContain("1 timed call");
  });

  it("says nothing about duration when nothing was timed", () => {
    const s = activitySection([call({ duration_seconds: null })], NOW);
    expect(s.lines.some((l) => l.text.includes("minutes on the phone"))).toBe(false);
  });
});

describe("attention surfaces what is actually waiting", () => {
  it("flags overdue callbacks", () => {
    const s = attentionSection(
      input({
        callbacks: [
          { scheduled_for: "2026-07-27T10:00:00Z", status: "pending", business_name: "Ace Roofing" },
        ],
      })
    );
    expect(s.lines[0].text).toContain("1 callback overdue");
    expect(s.lines[0].tone).toBe("warn");
    expect(s.lines[0].detail).toContain("Ace Roofing");
  });

  it("ignores callbacks that are already done", () => {
    const s = attentionSection(
      input({
        callbacks: [{ scheduled_for: "2026-07-01T10:00:00Z", status: "done" }],
      })
    );
    expect(s.lines.some((l) => l.text.includes("overdue"))).toBe(false);
  });

  it("chases appointments that happened but were never marked", () => {
    const s = attentionSection(
      input({
        appointments: [
          { scheduled_for: "2026-07-27T10:00:00Z", attendance_status: "scheduled" },
        ],
      })
    );
    const line = s.lines.find((l) => l.text.includes("not been marked"));
    expect(line).toBeTruthy();
    expect(line?.detail).toContain("Show rate");
  });

  it("does not chase an appointment already marked held", () => {
    const s = attentionSection(
      input({
        appointments: [{ scheduled_for: "2026-07-27T10:00:00Z", attendance_status: "held" }],
      })
    );
    expect(s.lines.some((l) => l.text.includes("not been marked"))).toBe(false);
  });

  it("warns when the callers have run dry but leads are waiting", () => {
    const s = attentionSection(input({ pendingInPackets: 0, readyToCall: 40 }));
    expect(s.lines.some((l) => l.text.includes("run out"))).toBe(true);
  });

  it("warns when packets are nearly empty", () => {
    const s = attentionSection(input({ pendingInPackets: 4 }));
    expect(s.lines.some((l) => l.text.includes("4 leads left"))).toBe(true);
  });

  it("calls out a bad-number rate high enough to blame the lead source", () => {
    const calls = [
      ...Array.from({ length: 4 }, () => call({ outcome: "bad_number" })),
      ...Array.from({ length: 6 }, () => call()),
    ];
    const s = attentionSection(input({ calls }));
    const line = s.lines.find((l) => l.text.includes("bad number"));
    expect(line?.tone).toBe("warn");
    expect(line?.detail).toContain("lead source");
  });

  it("stays quiet about one or two bad numbers", () => {
    const s = attentionSection(input({ calls: [call({ outcome: "bad_number" })] }));
    expect(s.lines.some((l) => l.text.includes("bad number"))).toBe(false);
  });
});

describe("what the calls taught us", () => {
  it("reports durable intelligence captured", () => {
    const s = learnedSection(
      input({
        learned: {
          ownerNames: 7,
          bestCallTimes: 3,
          directNumbers: 2,
          answeringSetups: 5,
          existingProviders: 1,
          gatekeeperNames: 4,
          totalLeadsTouched: 20,
        },
      })
    );
    const text = s.lines.map((l) => l.text).join(" | ");
    expect(text).toContain("7 owners now identified");
    expect(text).toContain("3 leads with a best time");
    expect(text).toContain("1 business already using a competitor");
  });

  it("lists the objections that actually came up, by count", () => {
    const s = learnedSection(
      input({
        objections: [
          { objection_key: "cost", objection_label: "How much?", outcome: null, reached_dm: null },
          { objection_key: "cost", objection_label: "How much?", outcome: null, reached_dm: null },
          { objection_key: "info", objection_label: "Send info", outcome: null, reached_dm: null },
        ],
      })
    );
    const text = s.lines.map((l) => l.text).join(" | ");
    expect(text).toContain('"How much?" came up 2 times');
    expect(text).toContain('"Send info" came up 1 time');
  });

  it("explains itself when nothing has been captured", () => {
    expect(learnedSection(input()).lines).toHaveLength(0);
    expect(learnedSection(input()).emptyText).toContain("saved here permanently");
  });
});

describe("observations are never dressed up as conclusions", () => {
  it("says nothing at all below the minimum", () => {
    const s = observationsSection(Array.from({ length: MIN_FOR_OBSERVATION - 1 }, () => call()));
    expect(s.lines).toHaveLength(0);
  });

  it("reports the best hours with raw counts and a caveat", () => {
    const calls = [
      ...Array.from({ length: 4 }, () => won({ dialed_hour: 8 })),
      ...Array.from({ length: 4 }, () => call({ dialed_hour: 16 })),
    ];
    const line = observationsSection(calls).lines.find((l) => l.text.includes("Best hours"));
    expect(line?.text).toContain("4 of 4 calls reached an owner");
    expect(line?.detail).toContain("Too few calls to call this a pattern");
  });

  it("never uses the words that would imply proof", () => {
    const calls = [
      ...Array.from({ length: 5 }, () => won({ dialed_hour: 8 })),
      ...Array.from({ length: 5 }, () => call({ dialed_hour: 16 })),
    ];
    const all = observationsSection(calls)
      .lines.map((l) => `${l.text} ${l.detail || ""}`)
      .join(" ")
      .toLowerCase();
    for (const banned of ["proves", "significant", "because", "always", "guaranteed"]) {
      expect(all, banned).not.toContain(banned);
    }
  });

  it("compares first and repeat attempts once both have enough calls", () => {
    const calls = [
      ...Array.from({ length: 3 }, () => won({ attempt_number: 1 })),
      ...Array.from({ length: 3 }, () => call({ attempt_number: 3 })),
    ];
    expect(
      observationsSection(calls).lines.some((l) => l.text.includes("First attempts"))
    ).toBe(true);
  });

  it("skips the attempt comparison when one side is too thin", () => {
    const calls = [
      ...Array.from({ length: 6 }, () => call({ attempt_number: 1 })),
      call({ attempt_number: 2 }),
    ];
    expect(
      observationsSection(calls).lines.some((l) => l.text.includes("First attempts"))
    ).toBe(false);
  });

  it("reports whether knowing the owner's name helped, once measurable", () => {
    const calls = [
      ...Array.from({ length: 3 }, () => won({ owner_known_before: true })),
      ...Array.from({ length: 3 }, () => call({ owner_known_before: false })),
    ];
    const line = observationsSection(calls).lines.find((l) =>
      l.text.includes("already known")
    );
    expect(line?.detail).toContain("enrichment pays for itself");
  });
});

describe("horizon tells you how far off an answer is", () => {
  it("reports how many more calls a question needs", () => {
    const calls = [
      ...Array.from({ length: 6 }, () => won({ dialed_hour: 8 })),
      ...Array.from({ length: 6 }, () => call({ dialed_hour: 16 })),
    ];
    const s = horizonSection(calls);
    expect(s.lines.length).toBeGreaterThan(0);
    expect(s.lines.some((l) => /more call|before any signal/.test(l.text))).toBe(true);
  });

  it("promotes a dimension to a real finding once the data supports it", () => {
    const calls = [
      ...Array.from({ length: 300 }, (_, i) =>
        i < 120 ? won({ lead_industry: "roofing" }) : call({ lead_industry: "roofing" })
      ),
      ...Array.from({ length: 300 }, (_, i) =>
        i < 20 ? won({ lead_industry: "hvac" }) : call({ lead_industry: "hvac" })
      ),
    ];
    const s = horizonSection(calls);
    expect(s.lines.some((l) => l.tone === "good")).toBe(true);
  });

  it("says nothing about dimensions with no data at all", () => {
    const s = horizonSection([]);
    expect(s.lines).toHaveLength(0);
  });

  it("stays short enough to read", () => {
    const calls = Array.from({ length: 40 }, (_, i) =>
      call({ dialed_hour: i % 12 + 7, lead_industry: `trade${i % 5}`, caller_name: `c${i % 3}` })
    );
    expect(horizonSection(calls).lines.length).toBeLessThanOrEqual(8);
  });
});

/**
 * The gap this closes: the whole briefing was counts and team-relative reads.
 * Neither can answer "is any of this good".
 */
describe("against your targets", () => {
  const bar = (metric: string, value: number, source = "set_by_operator") => ({
    metric: metric as never,
    target: value,
    source,
    minimumSample: 30,
  });

  it("says plainly that nothing can be judged when no target is set", () => {
    const s = targetsSection([call(), call(), won()], []);
    const line = s.lines.find((l) => /No targets are set/.test(l.text));
    expect(line).toBeTruthy();
    expect(line!.tone).toBe("action");
    expect(line!.detail).toContain("who is stronger, not whether anyone is good enough");
  });

  it("reports a miss as a warning", () => {
    const calls = [...Array(90)].map((_, i) => (i < 9 ? won() : call()));
    const s = targetsSection(calls, [bar("owner_reach_rate", 0.3)]);
    const line = s.lines.find((l) => /Owner-reached rate/.test(l.text))!;
    expect(line.text).toContain("below your target");
    expect(line.tone).toBe("warn");
  });

  it("reports a clean pass as good", () => {
    const calls = [...Array(90)].map((_, i) => (i < 45 ? won() : call()));
    const s = targetsSection(calls, [bar("owner_reach_rate", 0.3)]);
    const line = s.lines.find((l) => /Owner-reached rate/.test(l.text))!;
    expect(line.tone).toBe("good");
  });

  it("flags a borrowed bar as borrowed", () => {
    const calls = [...Array(90)].map((_, i) => (i < 9 ? won() : call()));
    const s = targetsSection(calls, [
      bar("owner_reach_rate", 0.3, "starting benchmark — general cold calling, not your data"),
    ]);
    expect(s.lines.some((l) => /borrowed starting figures/.test(l.text))).toBe(true);
  });

  it("does not claim a borrowed caveat on a target you set", () => {
    const calls = [...Array(90)].map((_, i) => (i < 9 ? won() : call()));
    const s = targetsSection(calls, [bar("owner_reach_rate", 0.3)]);
    expect(s.lines.some((l) => /borrowed/.test(l.text))).toBe(false);
  });

  it("names how many metrics still have no bar", () => {
    const calls = [...Array(90)].map(() => call());
    const s = targetsSection(calls, [bar("owner_reach_rate", 0.3)]);
    expect(s.lines.some((l) => /still have no target/.test(l.text))).toBe(true);
  });

  it("says nothing at all before the first call", () => {
    const s = targetsSection([], [bar("owner_reach_rate", 0.3)]);
    expect(s.lines).toEqual([]);
    expect(s.emptyText).toContain("No calls logged yet");
  });

  it("appears in the assembled briefing", () => {
    const b = buildBriefing(input({ calls: [call(), won()] }));
    expect(b.sections.map((s) => s.key)).toContain("targets");
  });
});
