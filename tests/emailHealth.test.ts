import { describe, it, expect } from "vitest";
import {
  emailHealth,
  campaignStatusLabel,
  campaignIsSending,
  WORKER_STALE_MINUTES,
  type HealthFacts,
} from "../src/lib/emailHealth";

/*
 * The campaign selector read "AI Dispatch — 3" while Instantly's own screen
 * said Completed with a Resume button. Three is a status code, and a completed
 * campaign sends nothing to anybody — so leads could be pushed into it all day
 * and every panel on the page would look healthy.
 */

const healthy: HealthFacts = {
  connected: true,
  connectionReason: "",
  programmeOn: true,
  campaignId: "c1",
  campaignName: "AI Dispatch",
  campaignStatus: "1",
  campaignReadable: true,
  hasActiveSequence: true,
  sendable: 92,
  pushedTotal: 40,
  workerMinutesAgo: 1,
  autoPushOn: true,
  sentLast24h: 12,
  repliesLast7d: 3,
};

describe("A STOPPED CAMPAIGN IS THE HEADLINE, NOT A STATUS CODE", () => {
  it("reads the codes as words", () => {
    expect(campaignStatusLabel("3")).toBe("Completed");
    expect(campaignStatusLabel("2")).toBe("Paused");
    expect(campaignStatusLabel("1")).toBe("Active");
  });

  it("never guesses at a code it does not know", () => {
    // Only "3" is confirmed against a live account. An invented label on an
    // unknown code would be a claim about somebody's campaign we cannot make.
    expect(campaignStatusLabel("99")).toBe('status "99"');
    expect(campaignStatusLabel(null)).toBe("unknown");
  });

  it("only 1 and 4 actually send", () => {
    expect(campaignIsSending("1")).toBe(true);
    expect(campaignIsSending("4")).toBe(true);
    for (const s of ["0", "2", "3", "99", null, ""]) {
      expect(campaignIsSending(s), String(s)).toBe(false);
    }
  });

  it("says so plainly when the campaign is Completed", () => {
    const h = emailHealth({ ...healthy, campaignStatus: "3", sentLast24h: 0 });
    expect(h.sending).toBe(false);
    expect(h.headline).toMatch(/Completed/);
    expect(h.headline).toMatch(/nothing will send/);
    const step = h.steps.find((s) => s.label.includes("running in Instantly"))!;
    expect(step.state).toBe("stopped");
    expect(step.detail).toMatch(/cannot start it for you/);
  });

  it("does not pretend to know when Instantly would not tell us", () => {
    const h = emailHealth({
      ...healthy,
      campaignReadable: false,
      campaignStatus: null,
      sentLast24h: 0,
    });
    const step = h.steps.find((s) => s.label.includes("Campaign"))!;
    expect(step.state).toBe("unknown");
    // Unknown is not a blocker — it must not claim a stop it cannot prove.
    expect(h.blocker).toBeNull();
  });
});

describe("ONLY A SEND PROVES IT IS SENDING", () => {
  it("says it is running when Instantly reported sends", () => {
    const h = emailHealth(healthy);
    expect(h.sending).toBe(true);
    expect(h.headline).toMatch(/Emails are going out — 12 in the last 24 hours/);
    expect(h.blocker).toBeNull();
  });

  it("everything green but nothing sent is NOT 'running'", () => {
    const h = emailHealth({ ...healthy, sentLast24h: 0 });
    expect(h.sending).toBe(false);
    expect(h.headline).toMatch(/nothing here is obviously broken/);
  });

  it("reports nothing pushed as the reason when nothing was pushed", () => {
    const h = emailHealth({ ...healthy, sentLast24h: 0, pushedTotal: 0, sendable: 0 });
    const step = h.steps.find((s) => s.label === "Emails actually sent")!;
    expect(step.detail).toMatch(/Nothing has been pushed/);
  });
});

describe("the first thing that is broken is the thing it reports", () => {
  it("a disconnected adapter outranks everything after it", () => {
    const h = emailHealth({
      ...healthy,
      connected: false,
      connectionReason: "Set INSTANTLY_API_KEY.",
      campaignStatus: "3",
      sentLast24h: 0,
    });
    expect(h.headline).toMatch(/Set INSTANTLY_API_KEY/);
  });

  it("the programme switch outranks the campaign", () => {
    const h = emailHealth({ ...healthy, programmeOn: false, campaignStatus: "3", sentLast24h: 0 });
    expect(h.headline).toMatch(/switched off/);
  });

  it("no addresses is a stop with somewhere to go", () => {
    const h = emailHealth({ ...healthy, sendable: 0, pushedTotal: 0, sentLast24h: 0 });
    expect(h.headline).toMatch(/No lead has an email address yet/);
    const step = h.steps.find((s) => s.label === "Somebody to email")!;
    expect(step.detail).toMatch(/Re-enrich on the Enrichment page/);
  });

  it("everyone already pushed is waiting, not broken", () => {
    const h = emailHealth({ ...healthy, sendable: 0, pushedTotal: 92 });
    const step = h.steps.find((s) => s.label === "Somebody to email")!;
    expect(step.state).toBe("waiting");
    expect(h.blocker).toBeNull();
  });
});

describe("the worker only blocks when something depends on it", () => {
  it("a dead worker is a stop when auto-push is on", () => {
    const h = emailHealth({
      ...healthy,
      workerMinutesAgo: null,
      autoPushOn: true,
      sentLast24h: 0,
    });
    expect(h.headline).toMatch(/never run/);
  });

  it("a dead worker is only a note when nothing depends on it", () => {
    const h = emailHealth({
      ...healthy,
      workerMinutesAgo: null,
      autoPushOn: false,
      sentLast24h: 0,
    });
    const step = h.steps.find((s) => s.label === "Worker running")!;
    expect(step.state).toBe("waiting");
    expect(h.blocker).toBeNull();
  });

  it("counts stale from the threshold, not from any gap", () => {
    const fresh = emailHealth({ ...healthy, workerMinutesAgo: WORKER_STALE_MINUTES - 1 });
    expect(fresh.steps.find((s) => s.label === "Worker running")!.state).toBe("ok");
    const stale = emailHealth({
      ...healthy,
      workerMinutesAgo: WORKER_STALE_MINUTES + 1,
      sentLast24h: 0,
    });
    expect(stale.steps.find((s) => s.label === "Worker running")!.state).toBe("stopped");
  });
});

/*
 * Found by the real thing, not by imagination: with the campaign resumed, the
 * worker alive and 92 addresses ready, nothing was blocked and nothing had
 * been pushed — and the headline said to go and check the schedule in
 * Instantly. The schedule was fine. The campaign was empty.
 */
describe("AN EMPTY CAMPAIGN IS NOT A BROKEN ONE", () => {
  it("says the campaign is empty, and what to press", () => {
    const h = emailHealth({ ...healthy, sentLast24h: 0, pushedTotal: 0, sendable: 92 });
    expect(h.blocker).toBeNull();
    expect(h.headline).toMatch(/the campaign is empty/);
    expect(h.headline).toMatch(/Push up to 92/);
    expect(h.headline).not.toMatch(/schedule/);
  });

  it("still points at the schedule when leads ARE in there and nothing sent", () => {
    const h = emailHealth({ ...healthy, sentLast24h: 0, pushedTotal: 40 });
    expect(h.headline).toMatch(/schedule/);
  });

  it("does not claim it is ready when there is nobody to push", () => {
    const h = emailHealth({ ...healthy, sentLast24h: 0, pushedTotal: 0, sendable: 0 });
    expect(h.headline).toMatch(/No lead has an email address yet/);
  });
});
