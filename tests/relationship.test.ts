import { describe, it, expect } from "vitest";
import { buildDossier, dossierPrompt, type DossierInput } from "../src/lib/relationship";

function input(over: Partial<DossierInput> = {}): DossierInput {
  return { lead: {}, calls: [], appointments: [], callbacks: [], objections: [], ...over };
}

const call = (over: Partial<DossierInput["calls"][number]> = {}) => ({
  outcome: "no_answer",
  created_at: "2026-07-20T14:00:00Z",
  ...over,
});

describe("status reads the record honestly", () => {
  it("says so when nobody has called", () => {
    expect(buildDossier(input()).status).toBe("Never called.");
    expect(buildDossier(input()).hasSubstance).toBe(false);
  });

  it("distinguishes never answering from only reaching the gatekeeper", () => {
    const dead = buildDossier(
      input({ lead: { attempt_count: 3 }, calls: [call(), call(), call()] })
    );
    expect(dead.status).toContain("nobody has picked up");

    const gk = buildDossier(
      input({ lead: { attempt_count: 2 }, calls: [call({ outcome: "gatekeeper" }), call()] })
    );
    expect(gk.status).toContain("only ever reached the gatekeeper");
  });

  it("recognises a real conversation with the owner", () => {
    const d = buildDossier(
      input({
        lead: { attempt_count: 2 },
        calls: [call({ outcome: "dm_conversation", reached_dm: true })],
      })
    );
    expect(d.status).toContain("Spoken with the decision maker");
    expect(d.hasSubstance).toBe(true);
  });

  it("leads with the meeting once one is booked, and with the outcome once known", () => {
    const booked = buildDossier(
      input({ appointments: [{ scheduled_for: "2026-08-01T15:00:00Z" }] })
    );
    expect(booked.status).toContain("Meeting booked for");

    const held = buildDossier(
      input({
        appointments: [{ scheduled_for: "2026-07-01T15:00:00Z", attendance_status: "held" }],
      })
    );
    expect(held.status).toContain("live opportunity");

    const missed = buildDossier(
      input({
        appointments: [{ scheduled_for: "2026-07-01T15:00:00Z", attendance_status: "no_show" }],
      })
    );
    expect(missed.status).toContain("did not show");
  });
});

describe("it assembles only what is in the record", () => {
  it("names the people we actually spoke to", () => {
    const d = buildDossier(
      input({
        lead: { owner_name: "Mike Reynolds", owner_title: "Owner", gatekeeper_name: "Dana" },
        calls: [call({ details: { dm_name: "Carl", dm_role: "Operations manager" } })],
      })
    );
    expect(d.people.join(" | ")).toContain("Mike Reynolds, Owner");
    expect(d.people.join(" | ")).toContain("Dana");
    expect(d.people.join(" | ")).toContain("Carl, Operations manager");
  });

  it("does not repeat a person already listed as the owner", () => {
    const d = buildDossier(
      input({
        lead: { owner_name: "Mike" },
        calls: [call({ details: { dm_name: "Mike", dm_role: "Owner" } })],
      })
    );
    expect(d.people.filter((p) => p.startsWith("Mike"))).toHaveLength(1);
  });

  it("collects what they said their problem is, from calls and from meetings", () => {
    const d = buildDossier(
      input({
        calls: [call({ details: { main_problem: "Missed calls" } })],
        appointments: [{ scheduled_for: "2026-08-01T15:00:00Z", pain_point: "After-hours calls" }],
      })
    );
    expect(d.statedProblems).toEqual(["Missed calls", "After-hours calls"]);
  });

  it("ignores 'no major problem identified' — that is not a problem", () => {
    const d = buildDossier(
      input({ calls: [call({ details: { main_problem: "No major problem identified" } })] })
    );
    expect(d.statedProblems).toEqual([]);
  });

  it("records what was pitched, from what was actually discussed", () => {
    const d = buildDossier(
      input({
        appointments: [
          {
            scheduled_for: "2026-08-01T15:00:00Z",
            product: "AI Receptionist — after hours",
            meeting_reason: "Walkthrough of missed-call recovery",
          },
        ],
      })
    );
    expect(d.pitched).toContain("AI Receptionist — after hours");
    expect(d.pitched).toContain("Walkthrough of missed-call recovery");
  });

  it("captures pushback, including who said no and why", () => {
    const d = buildDossier(
      input({
        calls: [
          call({
            outcome: "not_interested",
            details: { said_by_role: "Owner / decision-maker", reason: "Too expensive" },
          }),
        ],
        objections: [{ objection_key: "cost", objection_label: "How much does it cost" }],
      })
    );
    expect(d.resistance).toContain("How much does it cost");
    expect(d.resistance.join(" | ")).toContain("Not interested (Owner / decision-maker): Too expensive");
  });

  it("lists what we promised, without duplicating it", () => {
    const d = buildDossier(
      input({
        lead: { last_next_step: "Send pricing" },
        calls: [call({ next_step: "Send pricing" }), call({ next_step: "Call back Tuesday" })],
      })
    );
    expect(d.promises).toEqual(["Send pricing", "Call back Tuesday"]);
  });

  it("shows only callbacks that are still outstanding", () => {
    const d = buildDossier(
      input({
        callbacks: [
          { scheduled_for: "2026-08-02T15:00:00Z", status: "pending", reason: "wants a quote" },
          { scheduled_for: "2026-07-02T15:00:00Z", status: "done" },
        ],
      })
    );
    expect(d.commitments).toHaveLength(1);
    expect(d.commitments[0]).toContain("wants a quote");
  });

  it("invents nothing from an empty record", () => {
    const d = buildDossier(input());
    expect(d.people).toEqual([]);
    expect(d.pitched).toEqual([]);
    expect(d.statedProblems).toEqual([]);
    expect(d.resistance).toEqual([]);
    expect(d.promises).toEqual([]);
    expect(d.commitments).toEqual([]);
  });

  it("ignores blank strings rather than listing empty bullets", () => {
    const d = buildDossier(
      input({ lead: { owner_name: "   ", last_next_step: "" }, calls: [call({ next_step: "  " })] })
    );
    expect(d.people).toEqual([]);
    expect(d.promises).toEqual([]);
  });
});

describe("gaps drive the next questions", () => {
  it("flags the things we should know and do not", () => {
    const d = buildDossier(input({ lead: { attempt_count: 3 }, calls: [call(), call(), call()] }));
    expect(d.gaps).toContain("We do not know the owner's name");
    expect(d.gaps).toContain("We do not know how they handle calls today");
    expect(d.gaps).toContain("They have not told us a problem worth solving yet");
    expect(d.gaps).toContain("No best time to reach them, after several attempts");
  });

  it("notices a conversation with the owner that produced no next step", () => {
    const d = buildDossier(
      input({
        lead: { owner_name: "Mike", answering_setup: "Owner answers most calls" },
        calls: [call({ outcome: "dm_conversation", reached_dm: true, details: { main_problem: "Missed calls" } })],
      })
    );
    expect(d.gaps).toContain("We reached the owner but no next step was agreed");
  });

  it("raises no gaps once everything is known and a meeting is booked", () => {
    const d = buildDossier(
      input({
        lead: {
          owner_name: "Mike",
          answering_setup: "Office staff answers",
          best_call_time: "before 9am",
          attempt_count: 2,
        },
        calls: [call({ outcome: "dm_conversation", reached_dm: true, details: { main_problem: "Missed calls" } })],
        appointments: [{ scheduled_for: "2026-08-01T15:00:00Z" }],
      })
    );
    expect(d.gaps).toEqual([]);
  });
});

describe("dossierPrompt is the only thing the model sees", () => {
  it("includes every section, and says so when one is empty", () => {
    const text = dossierPrompt("Ace Roofing", buildDossier(input()));
    expect(text).toContain("Business: Ace Roofing");
    expect(text).toContain("People we have spoken to: nothing recorded");
    expect(text).toContain("What we have pitched or discussed: nothing recorded");
  });

  it("carries the real facts through", () => {
    const d = buildDossier(
      input({
        lead: { owner_name: "Mike", answering_setup: "Calls go to voicemail" },
        calls: [call({ outcome: "dm_conversation", reached_dm: true, details: { main_problem: "Missed calls" } })],
      })
    );
    const text = dossierPrompt("Ace Roofing", d);
    expect(text).toContain("Mike");
    expect(text).toContain("Calls go to voicemail");
    expect(text).toContain("Missed calls");
  });
});
