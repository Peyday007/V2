import { describe, it, expect } from "vitest";
import {
  OUTCOME_FORM_MAP,
  missingRequired,
  fieldVisible,
  DM_REACHED_OUTCOMES,
} from "../src/lib/outcomeForms";
import { whoToAskFor, callObjective, callScript, OBJECTIONS } from "../src/lib/callGuidance";
import {
  nextAttemptAt,
  windowForAttempt,
  CALL_WINDOWS,
  localHourParts,
} from "../src/lib/callWindows";

const BASE = {
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
};

describe("who to ask for — owner is always first", () => {
  it("asks for the owner by name when known", () => {
    const r = whoToAskFor({ ...BASE, owner_name: "Mike Reynolds", owner_title: "Owner" });
    expect(r.text).toContain("Ask for Mike Reynolds, the owner");
    expect(r.text).toContain("best day and time");
  });

  it("asks who the owner is when unknown", () => {
    const r = whoToAskFor(BASE);
    expect(r.text).toContain("Ask whether the owner is available");
    expect(r.text).toContain("get the owner's name");
  });

  it("surfaces extension, direct line and callback timing", () => {
    const r = whoToAskFor({
      ...BASE,
      owner_name: "Mike",
      extension: "12",
      direct_number: "313-555-0100",
      best_call_day: "Weekdays",
      best_call_time: "before 9am",
    });
    expect(r.detail.join(" ")).toContain("Extension 12");
    expect(r.detail.join(" ")).toContain("313-555-0100");
    expect(r.detail.join(" ")).toContain("before 9am");
  });

  it("mentions a confirmed alternative decision-maker without displacing the owner", () => {
    const r = whoToAskFor({ ...BASE, other_decision_maker: "Dana, office manager" });
    expect(r.text).toContain("Ask whether the owner is available");
    expect(r.detail.join(" ")).toContain("Dana");
  });
});

describe("call objective adapts to what we know", () => {
  it("targets identifying the owner first", () => {
    expect(callObjective(BASE)).toContain("Identify the owner");
  });

  it("targets reaching a known owner", () => {
    expect(callObjective({ ...BASE, owner_name: "Mike" })).toContain("Reach Mike");
  });

  it("continues a prior conversation once the owner was reached", () => {
    const o = callObjective({
      ...BASE,
      owner_name: "Mike",
      owner_reached: true,
      last_next_step: "send pricing",
    });
    expect(o).toContain("Continue the previous conversation");
    expect(o).toContain("send pricing");
  });
});

describe("script shows one line at a time", () => {
  it("uses the owner's name in the opening when known", () => {
    expect(callScript({ ...BASE, owner_name: "Mike" })[0].line).toContain("Mike");
  });

  it("asks for the owner generically otherwise", () => {
    expect(callScript(BASE)[0].line).toContain("the owner");
  });

  it("has exactly three short sections", () => {
    const s = callScript(BASE);
    expect(s).toHaveLength(3);
    for (const sec of s) expect(sec.line.length).toBeLessThan(320);
  });
});

describe("outcome forms enforce what matters", () => {
  it("a callback requires a date and a time", () => {
    const missing = missingRequired("callback", {
      requested_by_name: "Dana",
      requested_by_role: "Gatekeeper",
      reason: "owner out",
    });
    expect(missing).toContain("Callback date");
    expect(missing).toContain("Callback time");
  });

  it("an appointment requires a decision-maker, date and time", () => {
    const missing = missingRequired("appointment_set", {});
    expect(missing).toContain("Decision-maker name");
    expect(missing).toContain("Appointment date");
    expect(missing).toContain("Appointment time");
  });

  it("an appointment demands an explicit confirmation", () => {
    expect(OUTCOME_FORM_MAP.appointment_set.confirmation).toContain(
      "agreed to a specific meeting date and time"
    );
  });

  it("a decision-maker conversation demands confirmation too", () => {
    expect(OUTCOME_FORM_MAP.dm_conversation.confirmation).toBeTruthy();
  });

  it("gatekeeper capture asks for the owner name once identified", () => {
    const values = { owner_identified: "Yes" };
    const ownerField = OUTCOME_FORM_MAP.gatekeeper.fields.find(
      (f) => f.name === "owner_name"
    )!;
    expect(fieldVisible(ownerField, values)).toBe(true);
    expect(fieldVisible(ownerField, { owner_identified: "No" })).toBe(false);
  });

  it("not-interested distinguishes owner from gatekeeper", () => {
    const roleField = OUTCOME_FORM_MAP.not_interested.fields.find(
      (f) => f.name === "said_by_role"
    )!;
    expect(roleField.options).toContain("Owner / decision-maker");
    expect(roleField.options).toContain("Gatekeeper");

    const authority = OUTCOME_FORM_MAP.not_interested.fields.find(
      (f) => f.name === "gatekeeper_has_authority"
    )!;
    expect(fieldVisible(authority, { said_by_role: "Gatekeeper" })).toBe(true);
    expect(fieldVisible(authority, { said_by_role: "Owner / decision-maker" })).toBe(false);
  });

  it("do-not-call requires confirmation before it can be saved", () => {
    expect(OUTCOME_FORM_MAP.do_not_call.confirmation).toBeTruthy();
  });

  it("only real conversations count as reaching a decision-maker", () => {
    expect(DM_REACHED_OUTCOMES).toEqual(["dm_conversation", "appointment_set"]);
    expect(DM_REACHED_OUTCOMES).not.toContain("callback");
    expect(DM_REACHED_OUTCOMES).not.toContain("gatekeeper");
  });

  it("every outcome has a form", () => {
    for (const key of [
      "no_answer", "voicemail", "gatekeeper", "transferred", "dm_conversation",
      "callback", "appointment_set", "not_interested", "bad_number", "do_not_call",
    ]) {
      expect(OUTCOME_FORM_MAP[key], key).toBeDefined();
    }
  });
});

describe("retry scheduling rotates calling windows", () => {
  it("uses a different window on each successive attempt", () => {
    const windows = [0, 1, 2, 3].map((n) => windowForAttempt(n).key);
    expect(new Set(windows).size).toBe(CALL_WINDOWS.length);
  });

  it("schedules a retry after no answer", () => {
    const r = nextAttemptAt({ outcome: "no_answer", attemptCount: 0 });
    expect(r).not.toBeNull();
    expect(r!.at.getTime()).toBeGreaterThan(Date.now());
  });

  it("never schedules onto a weekend", () => {
    for (let i = 0; i < 8; i++) {
      const r = nextAttemptAt({ outcome: "no_answer", attemptCount: i });
      expect([0, 6]).not.toContain(r!.at.getDay());
    }
  });

  it("an agreed callback time overrides the retry schedule", () => {
    const when = new Date(Date.now() + 3 * 86400_000);
    const r = nextAttemptAt({ outcome: "callback", attemptCount: 2, explicitTime: when });
    expect(r!.at.toISOString()).toBe(when.toISOString());
    expect(r!.window).toBe("requested callback");
  });

  it("does not reschedule terminal outcomes", () => {
    expect(nextAttemptAt({ outcome: "do_not_call", attemptCount: 0 })).toBeNull();
    expect(nextAttemptAt({ outcome: "appointment_set", attemptCount: 0 })).toBeNull();
    expect(nextAttemptAt({ outcome: "bad_number", attemptCount: 0 })).toBeNull();
  });
});

describe("objection help stays short", () => {
  it("gives a response, a follow-up and a suggested outcome", () => {
    for (const o of OBJECTIONS) {
      expect(o.response.length).toBeGreaterThan(0);
      expect(o.response.length).toBeLessThan(220);
      expect(o.followUp.length).toBeLessThan(160);
      expect(OUTCOME_FORM_MAP[o.suggestedOutcome], o.key).toBeDefined();
    }
  });

  it("covers the common brush-offs", () => {
    const labels = OBJECTIONS.map((o) => o.label.toLowerCase()).join(" | ");
    expect(labels).toContain("answering service");
    expect(labels).toContain("owner is unavailable");
    expect(labels).toContain("send some information");
    expect(labels).toContain("how much does it cost");
  });
});

describe("localHourParts records the hour AT THE BUSINESS", () => {
  // 16:00 UTC on Wednesday 1 July 2026.
  const when = new Date("2026-07-01T16:00:00Z");

  it("converts to the business's own clock, not the caller's", () => {
    expect(localHourParts(when, "America/New_York").hour).toBe(12);
    expect(localHourParts(when, "America/Los_Angeles").hour).toBe(9);
  });

  it("reports the day of week in that zone", () => {
    expect(localHourParts(when, "America/New_York").dayOfWeek).toBe(3);
  });

  it("rolls the day back when the zone is behind midnight UTC", () => {
    const justAfterMidnightUtc = new Date("2026-07-02T03:00:00Z");
    const la = localHourParts(justAfterMidnightUtc, "America/Los_Angeles");
    expect(la.hour).toBe(20);
    expect(la.dayOfWeek).toBe(3); // still Wednesday in California
  });

  it("says which zone it used, so unknown zones are not passed off as local", () => {
    expect(localHourParts(when, "America/Denver").timezone).toBe("America/Denver");
    expect(localHourParts(when, null).timezone).toBeNull();
  });

  it("falls back to UTC rather than throwing on a bad zone", () => {
    const r = localHourParts(when, "Not/AZone");
    expect(r.hour).toBe(16);
    expect(r.timezone).toBeNull();
  });

  it("never returns 24 for midnight", () => {
    const midnight = new Date("2026-07-02T04:00:00Z"); // 00:00 in New York
    expect(localHourParts(midnight, "America/New_York").hour).toBe(0);
  });
});
