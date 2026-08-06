import { describe, it, expect } from "vitest";
import {
  decideGate,
  whatIsMissing,
  repeatedNotes,
  stillAllowed,
  CONSECUTIVE_LIMIT,
  TOTAL_LIMIT,
  MIN_SHIFT_SAMPLE,
  type CallRecord,
} from "../src/lib/callGate";

/*
 * The brief: "Never permit a situation where 80 calls have zero captured
 * information. The workflow should have stopped after the first few failures."
 */

let n = 0;
const call = (over: Partial<CallRecord> = {}): CallRecord => ({
  id: `c${++n}`,
  outcome: "dm_conversation",
  notes: "Spoke to the owner, they use an answering service already.",
  nextStep: null,
  durationSeconds: 120,
  createdAt: new Date().toISOString(),
  ...over,
});

const bad = (over: Partial<CallRecord> = {}) => call({ notes: "", ...over });
const gate = (calls: CallRecord[]) => decideGate({ calls, enabled: true });

describe("EIGHTY EMPTY CALLS IS NOW IMPOSSIBLE", () => {
  it("stops dialling long before it gets near eighty", () => {
    const many = Array.from({ length: 80 }, () => bad());
    // The gate is consulted after every call, so the real question is what it
    // says at call two — not what it would say at eighty.
    expect(gate(many.slice(0, 2)).mayDial).toBe(false);
  });

  it("prompts on the very first incomplete call, without blocking", () => {
    const d = gate([bad()]);
    expect(d.level).toBe("require_correction");
    expect(d.mayDial).toBe(false);
    expect(d.message).toMatch(/no notes/);
    expect(d.liftedBy).toBe("caller");
  });

  it("pauses dialling at two in a row", () => {
    const d = gate([bad(), bad()]);
    expect(d.level).toBe("pause_dialling");
    expect(d.callIds).toHaveLength(CONSECUTIVE_LIMIT);
  });

  it("pauses on the total too, even when they are not consecutive", () => {
    const d = gate([bad(), call(), bad(), call(), bad()]);
    expect(d.level).toBe("pause_dialling");
    expect(d.callIds).toHaveLength(TOTAL_LIMIT);
  });

  it("says what happens next before it happens", () => {
    expect(gate([bad()]).next).toMatch(/pauses/);
  });
});

describe("A SYSTEM FAILURE IS NEVER THE CALLER'S FAULT", () => {
  it("does not count a failed save as an incomplete record", () => {
    expect(whatIsMissing(bad({ saveFailed: true }))).toBeNull();
  });

  it("escalates repeated save failures WITHOUT stopping the phone", () => {
    const d = gate([bad({ saveFailed: true }), bad({ saveFailed: true })]);
    expect(d.systemFault).toBe(true);
    expect(d.mayDial).toBe(true);
    expect(d.message).toMatch(/not something you did/);
    expect(d.liftedBy).toBe("manager");
  });

  it("checks the system's own failures BEFORE blaming anybody", () => {
    // Enough failed saves to trip the share rule, if they counted.
    const calls = Array.from({ length: 20 }, () => bad({ saveFailed: true }));
    expect(gate(calls).systemFault).toBe(true);
    expect(gate(calls).mayDial).toBe(true);
  });

  it("offers the fault route in the blocking message itself", () => {
    expect(gate([bad(), bad()]).message).toMatch(/Report a problem/);
  });

  it("WHEN BOTH ARE TRUE, THE SYSTEM'S FAULT IS THE ONE REPORTED", () => {
    /*
     * A shift where saves are failing AND records are thin trips both rules.
     * Order decides which a caller is told, and telling somebody their notes
     * are inadequate while the app is silently dropping them is the worst
     * possible version of this feature. The system's failure is checked first,
     * and its verdict wins.
     */
    const calls = [
      bad({ saveFailed: true }),
      bad({ saveFailed: true }),
      bad(),
      bad(),
      bad(),
    ];
    const d = gate(calls);
    expect(d.systemFault).toBe(true);
    expect(d.mayDial).toBe(true);
    expect(d.message).toMatch(/not something you did/);
    // And it never names the caller's records as the problem.
    expect(d.callIds).toEqual(["c" + (n - 4), "c" + (n - 3)]);
  });
});

describe("THE SMALLEST CAPABILITY, AND NEVER THE ONE THAT FIXES IT", () => {
  it("leaves correction, callbacks and messaging open whenever it blocks", () => {
    for (const calls of [[bad()], [bad(), bad()], Array.from({ length: 20 }, () => bad())]) {
      const d = gate(calls);
      expect(d.mayDial).toBe(false);
      expect(stillAllowed(d)).toEqual([
        "finish call records",
        "take scheduled callbacks",
        "message a manager",
      ]);
    }
  });

  it("adds dialling back when nothing is wrong", () => {
    expect(stillAllowed(gate([call()]))).toContain("open new leads");
  });
});

describe("what a finished call has to carry", () => {
  it("asks nothing of a no-answer beyond the outcome", () => {
    expect(whatIsMissing(call({ outcome: "no_answer", notes: "" }))).toBeNull();
  });

  it("requires notes on a call that claims a conversation", () => {
    expect(whatIsMissing(call({ outcome: "dm_conversation", notes: "" }))).toBe("no notes");
    expect(whatIsMissing(call({ outcome: "gatekeeper", notes: "." }))).toMatch(/too thin/);
  });

  it("requires a time on a callback — the promise is the point", () => {
    expect(whatIsMissing(call({ outcome: "callback", nextStep: null }))).toMatch(/no time agreed/);
    expect(whatIsMissing(call({ outcome: "callback", nextStep: "Tue 2pm" }))).toBeNull();
  });

  it("treats a missing outcome as incomplete whatever else is there", () => {
    expect(whatIsMissing(call({ outcome: null }))).toBe("no outcome chosen");
  });
});

describe("notes pasted from the last call are not notes", () => {
  it("catches the same text on three calls", () => {
    const same = "Left a message with reception, will try again";
    const ids = repeatedNotes([call({ notes: same }), call({ notes: same }), call({ notes: same })]);
    expect(ids).toHaveLength(3);
  });

  it("does not punish two, which is a coincidence", () => {
    const same = "Left a message with reception, will try again";
    expect(repeatedNotes([call({ notes: same }), call({ notes: same })])).toEqual([]);
  });

  it("pauses dialling and explains why it matters to the next person", () => {
    const same = "Left a message with reception, will try again";
    const d = gate([call({ notes: same }), call({ notes: same }), call({ notes: same })]);
    expect(d.level).toBe("pause_dialling");
    expect(d.message).toMatch(/what the next person\s+reads/);
  });
});

describe("it does not escalate on a sample too small to mean anything", () => {
  it("ignores the shift share below the minimum sample", () => {
    // 1 bad out of 4 is 25%, over the threshold, but four calls prove nothing.
    const d = gate([bad(), call(), call(), call()]);
    expect(d.level).not.toBe("manager_review");
  });

  it("escalates to a person once the sample is real", () => {
    const calls = [
      ...Array.from({ length: 2 }, () => bad()),
      ...Array.from({ length: MIN_SHIFT_SAMPLE }, () => call()),
    ];
    const d = decideGate({ calls, enabled: true });
    expect(d.level).toBe("manager_review");
    expect(d.liftedBy).toBe("manager");
  });
});

describe("EVERY DECISION CARRIES ITS EVIDENCE", () => {
  it("names the exact records, never a bare accusation", () => {
    for (const calls of [[bad()], [bad(), bad()], [bad(), call(), bad(), call(), bad()]]) {
      const d = gate(calls);
      expect(d.callIds.length).toBeGreaterThan(0);
      expect(d.message.length).toBeGreaterThan(20);
    }
  });

  it("says who can lift it whenever something is blocked", () => {
    expect(gate([bad(), bad()]).liftedBy).toBe("caller");
    expect(gate(Array.from({ length: 20 }, () => bad())).liftedBy).toBe("manager");
  });

  it("does nothing at all when switched off", () => {
    const d = decideGate({ calls: Array.from({ length: 50 }, () => bad()), enabled: false });
    expect(d.level).toBe("clear");
    expect(d.mayDial).toBe(true);
  });

  it("says nothing when there is nothing to say", () => {
    // Distinct notes: three identical ones on real conversations is the
    // copy-paste signal, and is tested for on its own above.
    const good = [
      call({ notes: "Owner is Maria, back Thursday afternoon" }),
      call({ notes: "Reception would not put me through, asked me to email" }),
      call({ notes: "Spoke to the owner, already has a service, not interested" }),
    ];
    expect(gate(good).level).toBe("clear");
    expect(gate([]).level).toBe("clear");
  });

  it("does not treat honest repetition on non-conversations as copy-paste", () => {
    // Three voicemails accurately described the same way is the truth.
    const vm = Array.from({ length: 3 }, () =>
      call({ outcome: "voicemail", notes: "Left a voicemail asking for the owner" })
    );
    expect(gate(vm).level).toBe("clear");
  });
});
