import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
  refillNote: null,
  refillCheckedMinutesAgo: null,
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

/*
 * The silence that kept the campaign empty.
 *
 * refillEmailCampaign runs every tick and almost always decides to do nothing
 * — correctly. But "nothing" went to a server log and nowhere else, so a
 * top-up declining sixty times an hour told nobody. The campaign was Active,
 * 92 leads had addresses, auto-push was on, the worker was alive, and there
 * was no way to find out why.
 */
describe("THE AUTOMATIC TOP-UP SAYS WHAT IT DECIDED", () => {
  const CANNOT_READ =
    "Could not read how many leads are in the campaign, so nothing was pushed. " +
    "Pushing blind is how a campaign gets double-filled.";

  it("treats an unreadable campaign count as a real stop", () => {
    const h = emailHealth({
      ...healthy,
      sentLast24h: 0,
      pushedTotal: 0,
      refillNote: CANNOT_READ,
      refillCheckedMinutesAgo: 1,
    });
    expect(h.headline).toMatch(/cannot read how many leads are in the campaign/);
    expect(h.headline).toMatch(/Push by hand/);
    const step = h.steps.find((s) => s.label === "Automatic top-up")!;
    expect(step.state).toBe("waiting");
    expect(step.detail).toMatch(/checked 1 minute ago/);
  });

  it("a quiet, ordinary decision is not a fault", () => {
    const h = emailHealth({
      ...healthy,
      refillNote: "The campaign already holds 1000 of a target 1000.",
      refillCheckedMinutesAgo: 2,
    });
    expect(h.blocker).toBeNull();
    expect(h.steps.find((s) => s.label === "Automatic top-up")!.state).toBe("waiting");
  });

  it("reads a live push as working", () => {
    const h = emailHealth({
      ...healthy,
      refillNote: "Pushing 49 — limited by the per-run cap.",
      refillCheckedMinutesAgo: 1,
    });
    expect(h.steps.find((s) => s.label === "Automatic top-up")!.state).toBe("ok");
  });

  it("says nothing at all when the top-up is switched off", () => {
    const h = emailHealth({ ...healthy, autoPushOn: false, refillNote: CANNOT_READ });
    expect(h.steps.find((s) => s.label === "Automatic top-up")).toBeUndefined();
    expect(h.blocker).toBeNull();
  });

  it("says nothing before 0037 has run or the worker has reached it", () => {
    const h = emailHealth({ ...healthy, refillNote: null });
    expect(h.steps.find((s) => s.label === "Automatic top-up")).toBeUndefined();
  });
});

/*
 * The handler must WRITE the decision down, not log it.
 *
 * Reverting to `console.log(reason); return;` passes every behavioural test in
 * this file — the pure logic is fine, it just never receives a note. That is
 * precisely how the silence lasted: nothing was wrong with the reasoning, only
 * with where the reasoning went.
 */
describe("THE DECISION IS RECORDED, NOT LOGGED", () => {
  const handlers = readFileSync(
    new URL("../src/lib/jobHandlers.ts", import.meta.url),
    "utf8"
  );
  // The refill handler, up to the end of its early return.
  const refill = handlers.slice(
    handlers.indexOf("const refillEmailCampaign"),
    handlers.indexOf("const syncSendingAccountsJob")
  );

  it("writes the reason to instantly_settings on every decision", () => {
    expect(refill).toMatch(/last_refill_note:\s*decision\.reason/);
    expect(refill).toMatch(/last_refill_checked_at/);
  });

  it("records the count it read, so an unreadable campaign is visible as null", () => {
    expect(refill).toMatch(/last_refill_active_count:\s*active/);
  });

  it("records BEFORE the early return, or a declined top-up stays silent", () => {
    const write = refill.indexOf("last_refill_note");
    const earlyReturn = refill.indexOf("if (decision.count === 0)");
    expect(write).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(write).toBeLessThan(earlyReturn);
  });
});
