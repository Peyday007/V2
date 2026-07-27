import { describe, it, expect } from "vitest";
import {
  summarizeCounts,
  nextAction,
  campaignStatusText,
  plainDiscardReason,
  type PipelineInput,
} from "../src/lib/pipelineState";

/**
 * The Sourcing page was unreadable: twelve machine statuses, job queues and API
 * budgets, with no answer to "what do I do now". These tests pin the answer.
 */

function input(over: Partial<PipelineInput> = {}): PipelineInput {
  return {
    placesKeyConfigured: true,
    callerSecretConfigured: true,
    activeCallers: 1,
    counts: {
      readyToCall: 0,
      beingResearched: 0,
      withCallers: 0,
      called: 0,
      notUsable: 0,
      total: 0,
    },
    pendingInPackets: 0,
    campaignRunning: false,
    ...over,
  };
}

describe("summarizeCounts collapses twelve statuses into four numbers", () => {
  it("counts everything mid-processing as being researched", () => {
    const c = summarizeCounts({
      discovered: 3,
      normalized: 2,
      enrichment_queued: 16,
      enriching: 1,
      decision_maker_found: 4,
      role_only_found: 2,
    });
    expect(c.beingResearched).toBe(28);
    expect(c.readyToCall).toBe(0);
  });

  it("separates ready, handed out, called and discarded", () => {
    const c = summarizeCounts({
      ready_for_calling: 12,
      assigned_to_packet: 50,
      contacted: 7,
      enrichment_failed: 79,
      archived: 3,
    });
    expect(c.readyToCall).toBe(12);
    expect(c.withCallers).toBe(50);
    expect(c.called).toBe(7);
    expect(c.notUsable).toBe(82);
  });

  it("totals every lead, so nothing is silently dropped from the display", () => {
    const byStatus = { ready_for_calling: 2, enrichment_failed: 5, something_new: 1 };
    expect(summarizeCounts(byStatus).total).toBe(8);
  });

  it("an empty database is all zeros, not NaN", () => {
    const c = summarizeCounts({});
    expect(c).toEqual({
      readyToCall: 0,
      beingResearched: 0,
      withCallers: 0,
      called: 0,
      notUsable: 0,
      total: 0,
    });
  });
});

describe("nextAction gives exactly one instruction, in priority order", () => {
  it("a missing Google key blocks everything else", () => {
    const a = nextAction(
      input({ placesKeyConfigured: false, counts: { ...input().counts, readyToCall: 40 } })
    );
    expect(a.key).toBe("fix_places_key");
    expect(a.tone).toBe("blocked");
    expect(a.detail).toContain("redeploy");
  });

  it("a missing caller secret outranks everything except the Google key", () => {
    expect(nextAction(input({ callerSecretConfigured: false })).key).toBe(
      "fix_caller_secret"
    );
  });

  it("with no callers, adding one comes before assigning anything", () => {
    const a = nextAction(
      input({ activeCallers: 0, counts: { ...input().counts, readyToCall: 100 } })
    );
    expect(a.key).toBe("add_caller");
    expect(a.cta?.goes).toBe("/admin/callers");
  });

  it("says there is nothing to do while callers still have leads", () => {
    const a = nextAction(input({ pendingInPackets: 43 }));
    expect(a.key).toBe("callers_are_working");
    expect(a.tone).toBe("good");
    expect(a.headline).toContain("43");
  });

  it("asks for an assignment when leads are ready and nobody has them", () => {
    const a = nextAction(input({ counts: { ...input().counts, readyToCall: 12 } }));
    expect(a.key).toBe("assign_packet");
    expect(a.headline).toContain("12");
    expect(a.cta?.goes).toBe("#assign");
  });

  it("tells you to wait, with no button, while the engine runs", () => {
    const a = nextAction(
      input({ campaignRunning: true, counts: { ...input().counts, beingResearched: 57 } })
    );
    expect(a.key).toBe("wait_for_engine");
    expect(a.cta).toBeNull();
    expect(a.tone).toBe("waiting");
  });

  it("offers to push stalled leads along when nothing is running", () => {
    const a = nextAction(input({ counts: { ...input().counts, beingResearched: 16 } }));
    expect(a.key).toBe("push_engine");
    expect(a.cta?.goes).toBe("#push");
    expect(a.detail).toContain("cannot lose or duplicate");
  });

  it("asks for a first batch when the database is empty", () => {
    expect(nextAction(input()).key).toBe("generate_first");
  });

  it("asks for more once everything has been processed and handed out", () => {
    const a = nextAction(
      input({
        pendingInPackets: 0,
        counts: {
          readyToCall: 0,
          beingResearched: 0,
          withCallers: 0,
          called: 120,
          notUsable: 79,
          total: 199,
        },
      })
    );
    expect(a.key).toBe("generate_more");
  });

  it("always returns a headline and a detail — never an empty card", () => {
    const cases = [
      input({ placesKeyConfigured: false }),
      input({ activeCallers: 0 }),
      input({ pendingInPackets: 5 }),
      input({ counts: { ...input().counts, readyToCall: 5 } }),
      input({ campaignRunning: true }),
      input(),
    ];
    for (const c of cases) {
      const a = nextAction(c);
      expect(a.headline.length, a.key).toBeGreaterThan(0);
      expect(a.detail.length, a.key).toBeGreaterThan(0);
    }
  });

  it("singularises so the copy never reads '1 leads'", () => {
    expect(nextAction(input({ pendingInPackets: 1 })).headline).toContain("1 lead waiting");
    expect(
      nextAction(input({ counts: { ...input().counts, readyToCall: 1 } })).headline
    ).toContain("1 lead is ready");
  });
});

describe("plain wording", () => {
  it("translates raw campaign statuses", () => {
    expect(campaignStatusText("running")).toBe("Running now");
    expect(campaignStatusText("completed")).toBe("Finished");
    expect(campaignStatusText("draft")).toBe("Not started");
  });

  it("passes through an unexpected status rather than hiding it", () => {
    expect(campaignStatusText("weird_new_state")).toBe("weird_new_state");
  });

  it("explains discard reasons in words an operator recognises", () => {
    expect(plainDiscardReason("no usable main phone")).toBe("No phone number we could call");
    expect(plainDiscardReason("too many reviews (31402)")).toContain("Too big");
  });

  it("shows the original reason when there is no translation, instead of a shrug", () => {
    expect(plainDiscardReason("something unexpected")).toBe("something unexpected");
  });

  it("handles a missing reason", () => {
    expect(plainDiscardReason(null)).toBe("Did not meet the criteria");
  });
});
