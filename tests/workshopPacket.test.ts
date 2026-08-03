// The packet an owner receives, and the gatekeeper script test.
//
// Two things get most of the attention here, because they are the two that
// cost something real when they go wrong:
//
//   A status that goes backwards. The public page marks "opened" on every
//   load, so a refresh after agreeing would destroy the only state anybody
//   cares about.
//
//   A gap bullet that was never computed. The page is read by a stranger who
//   just took a cold call; a confident claim about their business that nobody
//   checked is how the call that earned the click gets lost.

import { describe, it, expect } from "vitest";

import {
  PACKET_STATUSES,
  PACKET_STATUS_RANK,
  advanceStatus,
  needsAttention,
  canSend,
  canGenerateLink,
  buildRecommendations,
  computeGaps,
  gapsAreThin,
  renderMessage,
  packetUrl,
  segmentCount,
  looksLikeToken,
  BUSY_REVIEW_COUNT,
  type PacketStatus,
} from "../src/lib/workshopPacket";

import {
  SCRIPT_VERSIONS,
  buildScript,
  applyScript,
  isScriptVersion,
} from "../src/lib/gatekeeperScripts";

import {
  buildScriptStats,
  flagsFor,
  leaderNote,
  connected,
  reachedOwner,
  dmConversation,
  MIN_CALLS,
  REVIEW_AFTER_CALLS,
  type ScriptCall,
} from "../src/lib/scriptStats";

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

describe("the packet status only moves forward", () => {
  it("advances through the normal path", () => {
    expect(advanceStatus("not_sent", "sent")).toBe("sent");
    expect(advanceStatus("sent", "opened")).toBe("opened");
    expect(advanceStatus("opened", "trial_requested")).toBe("trial_requested");
  });

  it("THE REFRESH BUG: opening the page again cannot undo a trial request", () => {
    // The public route marks "opened" on every single load. Without this the
    // owner agreeing and then refreshing would wipe the agreement.
    expect(advanceStatus("trial_requested", "opened")).toBe("trial_requested");
  });

  it("a second send does not knock an opened packet back to sent", () => {
    expect(advanceStatus("opened", "sent")).toBe("opened");
  });

  it("staying put is not an error", () => {
    for (const s of PACKET_STATUSES) {
      expect(advanceStatus(s, s)).toBe(s);
    }
  });

  it("the ranks are strictly increasing, which is what makes the rule work", () => {
    const ranks = PACKET_STATUSES.map((s) => PACKET_STATUS_RANK[s]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("what is waiting on a person", () => {
  it("an unacknowledged trial request, and only that", () => {
    expect(needsAttention("trial_requested", null)).toBe(true);
    expect(needsAttention("trial_requested", "2026-08-01T10:00:00Z")).toBe(false);
    expect(needsAttention("opened", null)).toBe(false);
    expect(needsAttention("sent", null)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the send gate                                                              */
/* -------------------------------------------------------------------------- */

describe("whether a packet may be sent at all", () => {
  const ok = { ownerName: "Maria Rivera", ownerPhone: "+13134820199" };

  it("allows a named owner with a number", () => {
    expect(canSend(ok).allowed).toBe(true);
  });

  it("A TEXT IS A CONTACT — do-not-call blocks it, same as a call would be", () => {
    const v = canSend({ ...ok, doNotCall: true });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/do-not-call/i);
  });

  it("blocks a number already marked uncallable", () => {
    expect(canSend({ ...ok, phoneInvalid: true }).allowed).toBe(false);
  });

  it("refuses without a name, because the message is addressed to them", () => {
    const v = canSend({ ...ok, ownerName: "  " });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/owner's name/i);
  });

  it("refuses without a number", () => {
    expect(canSend({ ...ok, ownerPhone: null }).allowed).toBe(false);
  });

  it("suppression outranks a missing name — the most decisive reason wins", () => {
    const v = canSend({ ownerName: "", ownerPhone: "", doNotCall: true });
    expect(v.reason).toMatch(/do-not-call/i);
  });
});

describe("copying the link is a weaker bar than texting it", () => {
  it("THE BUG: a link needs no owner name and no mobile", () => {
    // Copy Link shared the send gate, so on every lead with no discovered
    // mobile — all of them, until a contact provider is configured — the
    // button was disabled and pressing it did nothing at all.
    expect(canGenerateLink({}).allowed).toBe(true);
    expect(canSend({ ownerName: "", ownerPhone: "" }).allowed).toBe(false);
  });

  it("but suppression still blocks both routes", () => {
    expect(canGenerateLink({ doNotCall: true }).allowed).toBe(false);
    expect(canGenerateLink({ phoneInvalid: true }).allowed).toBe(false);
  });

  it("a pasted link is still a pitch, so do-not-call is the reason given", () => {
    expect(canGenerateLink({ doNotCall: true }).reason).toMatch(/do-not-call/i);
  });
});

describe("the recommendations on the owner's page", () => {
  it("always offers something, even on a bare record", () => {
    const recs = buildRecommendations({ businessName: "Rivera Plumbing" });
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(4);
    expect(recs.every((r) => !!r.title && !!r.detail)).toBe(true);
  });

  it("tailors the wording when the review count supports it", () => {
    const recs = buildRecommendations({ businessName: "Rivera Plumbing", reviewCount: 140 });
    expect(recs[0].detail).toMatch(/140 reviews/);
    expect(recs[0].basis).toBe("review_count");
  });

  it("SAYS NOTHING SPECIFIC when the record is empty", () => {
    const recs = buildRecommendations({ businessName: "Rivera Plumbing", reviewCount: null });
    const text = recs.map((r) => r.detail).join(" ");
    expect(text).not.toMatch(/\d+ reviews/);
    expect(text).not.toMatch(/undefined|null|NaN/);
    expect(recs[0].basis).toBe("general");
  });

  it("adds the no-website point only when there is genuinely no website", () => {
    const without = buildRecommendations({ businessName: "X" });
    const withSite = buildRecommendations({ businessName: "X", website: "https://x.com" });
    expect(without.some((r) => r.key === "no_website_capture")).toBe(true);
    expect(withSite.some((r) => r.key === "no_website_capture")).toBe(false);
  });

  it("quotes the owner back to themselves when a caller recorded it", () => {
    const recs = buildRecommendations({
      businessName: "X",
      website: "https://x.com",
      reviewCount: 90,
      answeringSetup: "Voicemail, and I never check it.",
    });
    const said = recs.find((r) => r.key === "stated_setup");
    expect(said?.detail).toMatch(/Voicemail, and I never check it\./);
  });

  it("these are an offer, not a claim about how they run today", () => {
    // The distinction that keeps the page honest on a thin record: promising
    // to answer after-hours calls is fair to say to anybody; asserting they
    // ARE missing calls needs evidence we may not have.
    const recs = buildRecommendations({ businessName: "X", website: "https://x.com" });
    const text = recs.map((r) => `${r.title} ${r.detail}`).join(" ").toLowerCase();
    expect(text).not.toMatch(/you are currently missing|you have missed \d/);
  });
});

/* -------------------------------------------------------------------------- */
/* the gaps                                                                   */
/* -------------------------------------------------------------------------- */

describe("what the owner's page is allowed to say", () => {
  it("uses the review count when there is one", () => {
    const gaps = computeGaps({ businessName: "Rivera Plumbing", reviewCount: 140, website: "x.com" });
    expect(gaps[0].headline).toMatch(/140 reviews/);
    expect(gaps[0].basis).toBe("review_count");
  });

  it("SAYS NOTHING ABOUT REVIEWS WHEN THE COUNT IS NULL", () => {
    // The failure this guards: rendering "0 reviews and no way to reach you"
    // at a business nobody ever counted reviews for.
    const gaps = computeGaps({ businessName: "Rivera Plumbing", reviewCount: null, website: "x.com" });
    expect(gaps.every((g) => g.basis !== "review_count")).toBe(true);
  });

  it("does not call a quiet business busy", () => {
    const gaps = computeGaps({
      businessName: "Rivera Plumbing",
      reviewCount: BUSY_REVIEW_COUNT - 1,
      website: "x.com",
    });
    expect(gaps.every((g) => g.key !== "busy_no_after_hours")).toBe(true);
  });

  it("no website on the listing is a fact, and is used", () => {
    const gaps = computeGaps({ businessName: "Rivera Plumbing", website: null });
    expect(gaps.some((g) => g.key === "no_website")).toBe(true);
  });

  it("HAVING a website produces no claim either way", () => {
    // Nobody checked what is on it. Silence is the only honest answer.
    const gaps = computeGaps({ businessName: "Rivera Plumbing", website: "https://rivera.com" });
    expect(gaps.every((g) => g.key !== "no_website")).toBe(true);
  });

  it("repeats what the owner themselves said, when a caller recorded it", () => {
    const gaps = computeGaps({
      businessName: "Rivera Plumbing",
      website: "x.com",
      answeringSetup: "Calls roll to my mobile and I miss them on jobs.",
    });
    const said = gaps.find((g) => g.key === "stated_setup")!;
    expect(said.detail).toMatch(/roll to my mobile/);
    expect(said.basis).toBe("answering_setup");
  });

  it("never shows more than three, because a wall of bullets reads as a template", () => {
    const gaps = computeGaps({
      businessName: "Rivera Plumbing",
      website: null,
      reviewCount: 300,
      rating: 4.9,
      answeringSetup: "Voicemail, mostly.",
    });
    expect(gaps.length).toBe(3);
  });

  it("an empty record produces no bullets at all, and says so", () => {
    const gaps = computeGaps({ businessName: "Rivera Plumbing", website: "x.com" });
    expect(gaps).toEqual([]);
    expect(gapsAreThin(gaps)).toBe(true);
  });

  it("every bullet names the field it came from, so a claim can be traced", () => {
    const gaps = computeGaps({
      businessName: "Rivera Plumbing",
      website: null,
      reviewCount: 90,
      rating: 4.8,
    });
    expect(gaps.every((g) => !!g.basis)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* the message                                                                */
/* -------------------------------------------------------------------------- */

describe("the text that gets sent", () => {
  const base = {
    ownerName: "Maria Rivera",
    vaName: "Sam",
    companyName: "Ridgeline",
    businessName: "Rivera Plumbing",
    link: "https://board.example/workshop/abc",
  };

  it("uses the first name only", () => {
    // "Hi Maria Rivera" from someone who just spoke to her reads as a merge.
    expect(renderMessage(base)).toBe(
      "Hi Maria, this is Sam with Ridgeline. Here's what we found for Rivera Plumbing: https://board.example/workshop/abc"
    );
  });

  it("DROPS THE COMPANY CLAUSE rather than printing a placeholder", () => {
    // COMPANY_NAME unset must never reach a prospect's phone as "undefined".
    const msg = renderMessage({ ...base, companyName: "" });
    expect(msg).toBe(
      "Hi Maria, this is Sam. Here's what we found for Rivera Plumbing: https://board.example/workshop/abc"
    );
    expect(msg).not.toMatch(/undefined|null|with \./);
  });

  it("copes with a single-word name", () => {
    expect(renderMessage({ ...base, ownerName: "Mo" })).toMatch(/^Hi Mo, /);
  });

  it("warns when it will be billed as more than one segment", () => {
    expect(segmentCount("short")).toBe(1);
    expect(segmentCount("x".repeat(200))).toBeGreaterThan(1);
  });

  it("builds the link without doubling the slash", () => {
    expect(packetUrl("https://board.example/", "abc")).toBe("https://board.example/workshop/abc");
    expect(packetUrl("https://board.example", "abc")).toBe("https://board.example/workshop/abc");
  });
});

describe("token shape", () => {
  it("accepts what the server generates — 16 random bytes as hex", () => {
    expect(looksLikeToken("a".repeat(32))).toBe(true);
    expect(looksLikeToken("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("REJECTS ANYTHING ELSE BEFORE IT REACHES THE DATABASE", () => {
    expect(looksLikeToken("abc")).toBe(false);
    expect(looksLikeToken("A".repeat(32))).toBe(false); // uppercase is not what we mint
    expect(looksLikeToken("' or 1=1 --")).toBe(false);
    expect(looksLikeToken(null)).toBe(false);
    expect(looksLikeToken("")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* the three scripts                                                          */
/* -------------------------------------------------------------------------- */

describe("the gatekeeper scripts", () => {
  const fill = { businessName: "Rivera Plumbing", ownerName: "Maria Rivera", callerName: "Sam" };

  it("A states the reason and asks for the owner by name", () => {
    const s = buildScript("A", fill);
    expect(s.opener).toMatch(/missed calls turning into missed jobs/);
    expect(s.opener).toMatch(/Maria Rivera/);
    expect(s.ifPushed).toMatch(/Rivera Plumbing/);
  });

  it("B gives no reason at all — that is the whole variable", () => {
    const s = buildScript("B", fill);
    expect(s.opener).toMatch(/this is Sam/);
    expect(s.opener).not.toMatch(/missed calls/);
  });

  it("C leads with the review count when it is known", () => {
    const s = buildScript("C", { ...fill, reviewCount: 140 });
    expect(s.opener).toMatch(/140 reviews/);
  });

  it("C DOES NOT INVENT A REVIEW COUNT it was never given", () => {
    const s = buildScript("C", fill);
    expect(s.opener).toMatch(/a lot of reviews/);
    expect(s.opener).not.toMatch(/\d+ reviews/);
    expect(buildScript("C", { ...fill, reviewCount: null }).opener).toMatch(/a lot of reviews/);
  });

  it("falls back to 'the owner' rather than guessing a name", () => {
    for (const v of SCRIPT_VERSIONS) {
      const s = buildScript(v, { businessName: "Rivera Plumbing" });
      expect(s.opener).not.toMatch(/null|undefined/);
    }
    expect(buildScript("A", { businessName: "X" }).opener).toMatch(/the owner/);
  });

  it("never guesses he or she from a name", () => {
    for (const v of SCRIPT_VERSIONS) {
      const s = buildScript(v, fill);
      expect(`${s.opener} ${s.ifPushed}`).not.toMatch(/\b(he|she|him|her)\b/i);
    }
  });

  it("validates the version rather than trusting a request body", () => {
    expect(isScriptVersion("A")).toBe(true);
    expect(isScriptVersion("D")).toBe(false);
    expect(isScriptVersion("")).toBe(false);
    expect(isScriptVersion(null)).toBe(false);
    expect(isScriptVersion(1)).toBe(false);
  });
});

describe("putting the script into the dialer's lines", () => {
  const lines = [
    { heading: "Open", line: "original open" },
    { heading: "If asked", line: "original pushback" },
    { heading: "Voicemail", line: "original voicemail" },
  ];

  it("replaces the opener and the pushback, keeping everything after", () => {
    const out = applyScript(lines, buildScript("A", { businessName: "X" }), false);
    expect(out[0].heading).toMatch(/Script A/);
    expect(out[1].heading).toBe("If they push back");
    expect(out[2]).toEqual(lines[2]);
  });

  it("ONLY SWAPS THE OPENER — the pitch to the owner is identical across versions", () => {
    // If the pitch changed too, a difference in the numbers could not be
    // attributed to the gatekeeper opener, which is the entire experiment.
    const out = applyScript(lines, buildScript("C", { businessName: "X" }), true);
    expect(out).toEqual(lines);
  });

  it("leaves the lines alone when nobody opted into the test", () => {
    expect(applyScript(lines, null, false)).toEqual(lines);
  });
});

/* -------------------------------------------------------------------------- */
/* the stats                                                                  */
/* -------------------------------------------------------------------------- */

const call = (o: Partial<ScriptCall> & { outcome: string }): ScriptCall => ({ ...o });

describe("what counts as what", () => {
  it("a live answer, from the outcome or the recorded role", () => {
    expect(connected(call({ outcome: "gatekeeper" }))).toBe(true);
    expect(connected(call({ outcome: "no_answer" }))).toBe(false);
    expect(connected(call({ outcome: "voicemail" }))).toBe(false);
    expect(connected(call({ outcome: "bad_number" }))).toBe(false);
  });

  it("THE OUTCOME CHIP ALONE IS NOT AN OWNER REACH", () => {
    // dm_conversation is a button a caller can press optimistically, and this
    // is the number the whole test turns on.
    expect(reachedOwner(call({ outcome: "dm_conversation" }))).toBe(false);
    expect(reachedOwner(call({ outcome: "dm_conversation", reached_dm: true }))).toBe(true);
    expect(reachedOwner(call({ outcome: "callback", spoke_with_role: "owner" }))).toBe(true);
  });

  it("a conversation is reaching them AND actually talking", () => {
    expect(dmConversation(call({ outcome: "dm_conversation", reached_dm: true }))).toBe(true);
    expect(dmConversation(call({ outcome: "appointment_set", reached_dm: true }))).toBe(true);
    // Reached them, but they hung up before it was a conversation.
    expect(dmConversation(call({ outcome: "no_answer", reached_dm: true }))).toBe(false);
  });
});

describe("the checkpoint flags", () => {
  const base = {
    dials: 0,
    connects: 0,
    ownerReaches: 0,
    dmConversations: 0,
    trialsRequested: 0,
    connectRate: null,
    gatekeeperPassRate: null,
    dmConversationRate: null,
    trialRate: null,
  };

  it("under the minimum, it says keep testing and NOTHING ELSE", () => {
    const flags = flagsFor({ ...base, dials: 10, connects: 10, ownerReaches: 0, gatekeeperPassRate: 0 });
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe("yellow");
    expect(flags[0].message).toMatch(/Insufficient data/);
    // A 0% pass rate off ten calls must not fire a red flag. That is how a
    // script gets retired before it ever had a chance.
    expect(flags.some((f) => f.level === "red")).toBe(false);
  });

  it("flags a low gatekeeper pass rate once there are 50 calls", () => {
    const flags = flagsFor({
      ...base,
      dials: REVIEW_AFTER_CALLS,
      connects: 40,
      ownerReaches: 4,
      gatekeeperPassRate: 0.1,
    });
    expect(flags.some((f) => f.level === "red" && /high failure at gatekeeper/.test(f.message))).toBe(
      true
    );
  });

  it("does not flag a pass rate that clears the bar", () => {
    const flags = flagsFor({
      ...base,
      dials: 80,
      connects: 40,
      ownerReaches: 12,
      gatekeeperPassRate: 0.3,
      dmConversations: 6,
      dmConversationRate: 0.5,
    });
    expect(flags.every((f) => f.level !== "red")).toBe(true);
  });

  it("flags low conversion once past the gatekeeper", () => {
    const flags = flagsFor({
      ...base,
      dials: 60,
      connects: 40,
      ownerReaches: 20,
      gatekeeperPassRate: 0.5,
      dmConversations: 2,
      dmConversationRate: 0.1,
    });
    expect(flags.some((f) => /low conversion once past gatekeeper/.test(f.message))).toBe(true);
  });

  it("flags the close only once there are 10 owner conversations", () => {
    const thin = flagsFor({ ...base, dials: 60, connects: 40, ownerReaches: 20, gatekeeperPassRate: 0.5, dmConversations: 9, dmConversationRate: 0.45, trialsRequested: 0 });
    expect(thin.some((f) => /Review offer\/close/.test(f.message))).toBe(false);

    const enough = flagsFor({ ...base, dials: 60, connects: 40, ownerReaches: 20, gatekeeperPassRate: 0.5, dmConversations: 25, dmConversationRate: 0.5, trialsRequested: 0 });
    expect(enough.some((f) => /Review offer\/close/.test(f.message))).toBe(true);
  });

  it("1 trial in 20 conversations clears the bar", () => {
    const flags = flagsFor({ ...base, dials: 60, connects: 40, ownerReaches: 20, gatekeeperPassRate: 0.5, dmConversations: 20, dmConversationRate: 0.5, trialsRequested: 1 });
    expect(flags.some((f) => /Review offer\/close/.test(f.message))).toBe(false);
  });

  it("says something reassuring rather than nothing when all is well", () => {
    const flags = flagsFor({ ...base, dials: 30, connects: 20, ownerReaches: 10, gatekeeperPassRate: 0.5, dmConversations: 5, dmConversationRate: 0.5 });
    expect(flags).toHaveLength(1);
    expect(flags[0].level).toBe("green");
  });
});

describe("building the whole table", () => {
  function dials(version: string, n: number, opts: { owner?: number; lead?: string } = {}) {
    return Array.from({ length: n }, (_, i) =>
      call({
        script_version: version,
        outcome: i < (opts.owner ?? 0) ? "dm_conversation" : "gatekeeper",
        reached_dm: i < (opts.owner ?? 0),
        lead_id: opts.lead ?? `lead-${version}`,
      })
    );
  }

  it("counts each version separately", () => {
    const rows = buildScriptStats({
      calls: [...dials("A", 40, { owner: 10 }), ...dials("B", 20, { owner: 1 })],
      trialLeadIds: [],
    });
    const a = rows.find((r) => r.version === "A")!;
    expect(a.dials).toBe(40);
    expect(a.connects).toBe(40);
    expect(a.ownerReaches).toBe(10);
    expect(a.gatekeeperPassRate).toBe(0.25);

    const c = rows.find((r) => r.version === "C")!;
    expect(c.dials).toBe(0);
    expect(c.gatekeeperPassRate).toBeNull();
  });

  it("UNTAGGED CALLS ARE NOT A FOURTH VARIANT", () => {
    const rows = buildScriptStats({
      calls: [...dials("A", 5, { owner: 5 }), call({ outcome: "dm_conversation", reached_dm: true })],
      trialLeadIds: [],
    });
    expect(rows.reduce((n, r) => n + r.dials, 0)).toBe(5);
  });

  it("credits a trial to the version that actually reached the owner", () => {
    const rows = buildScriptStats({
      calls: [
        ...dials("A", 30, { owner: 30, lead: "lead-1" }),
        // B called the same business but never got past reception.
        ...dials("B", 30, { owner: 0, lead: "lead-1" }),
      ],
      trialLeadIds: ["lead-1"],
    });
    expect(rows.find((r) => r.version === "A")!.trialsRequested).toBe(1);
    expect(rows.find((r) => r.version === "B")!.trialsRequested).toBe(0);
  });

  it("always returns all three versions, so a missing one is visible as zero", () => {
    const rows = buildScriptStats({ calls: [], trialLeadIds: [] });
    expect(rows.map((r) => r.version)).toEqual(["A", "B", "C"]);
    expect(rows.every((r) => r.dials === 0)).toBe(true);
  });
});

describe("declaring a leader", () => {
  const row = (version: string, dials: number, pass: number) => ({
    calls: Array.from({ length: dials }, (_, i) =>
      call({
        script_version: version,
        outcome: "gatekeeper",
        reached_dm: i < Math.round(dials * pass),
        lead_id: `l-${version}-${i}`,
      })
    ),
  });

  it("REFUSES to compare until two versions have cleared the minimum", () => {
    const rows = buildScriptStats({ calls: row("A", 60, 0.4).calls, trialLeadIds: [] });
    expect(leaderNote(rows)).toMatch(/Keep testing before comparing/);
  });

  it("names the leader, and says out loud that it is not a significance test", () => {
    const rows = buildScriptStats({
      calls: [...row("A", 60, 0.4).calls, ...row("B", 60, 0.1).calls],
      trialLeadIds: [],
    });
    const note = leaderNote(rows);
    expect(note).toMatch(/^A is ahead/);
    expect(note).toMatch(/not a significance test/);
  });

  it("the minimum is a stated constant", () => {
    expect(MIN_CALLS).toBeGreaterThanOrEqual(20);
    expect(REVIEW_AFTER_CALLS).toBeGreaterThan(MIN_CALLS);
  });
});
