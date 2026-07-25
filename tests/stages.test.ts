import { describe, it, expect } from "vitest";
import {
  SALES_STAGES,
  STAGE_LABELS,
  DEFAULT_STAGE,
  normalizeStage,
  coerceStage,
  isSalesStage,
  nextStageAfterOutcome,
  STAGE_FOR_OUTCOME,
} from "../src/lib/stages";

describe("canonical stage mapping", () => {
  it("has a label for every stage", () => {
    for (const s of SALES_STAGES) {
      expect(STAGE_LABELS[s]).toBeTruthy();
    }
  });

  it("stores snake_case keys, not display text", () => {
    for (const s of SALES_STAGES) {
      expect(s).toMatch(/^[a-z_]+$/);
    }
  });

  it("normalizes legacy display text from the old board", () => {
    expect(normalizeStage("New Lead")).toBe("new_lead");
    expect(normalizeStage("NEW LEAD")).toBe("new_lead");
    expect(normalizeStage("Contact Attempted")).toBe("contact_attempted");
    expect(normalizeStage("Discovery Booked")).toBe("discovery_booked");
    expect(normalizeStage("Closed Won")).toBe("won");
    expect(normalizeStage("Closed Lost")).toBe("lost");
  });

  it("normalizes historical short values", () => {
    expect(normalizeStage("new")).toBe("new_lead");
    expect(normalizeStage("contacted")).toBe("contact_attempted");
    expect(normalizeStage("appointment_set")).toBe("discovery_booked");
    expect(normalizeStage("  Qualified  ")).toBe("qualified");
    expect(normalizeStage("contact-attempted")).toBe("contact_attempted");
  });

  it("FLAGS unknown values instead of silently accepting them", () => {
    expect(normalizeStage("banana")).toBeNull();
    expect(normalizeStage("")).toBeNull();
    expect(normalizeStage(null)).toBeNull();
    expect(normalizeStage(undefined)).toBeNull();
  });

  it("coerces unknown values to a real column so no lead is invisible", () => {
    expect(coerceStage("banana")).toBe(DEFAULT_STAGE);
    expect(coerceStage(null)).toBe(DEFAULT_STAGE);
    expect(coerceStage("Qualified")).toBe("qualified");
  });

  it("validates stage values for the API guard", () => {
    expect(isSalesStage("qualified")).toBe(true);
    expect(isSalesStage("Qualified")).toBe(false);
    expect(isSalesStage("banana")).toBe(false);
  });
});

describe("call outcome -> stage transitions", () => {
  it("every outcome maps to a valid canonical stage", () => {
    for (const target of Object.values(STAGE_FOR_OUTCOME)) {
      expect(isSalesStage(target)).toBe(true);
    }
  });

  it("advances a new lead forward", () => {
    expect(nextStageAfterOutcome("new_lead", "no_answer")).toBe("contact_attempted");
    expect(nextStageAfterOutcome("new_lead", "dm_conversation")).toBe("qualified");
    expect(nextStageAfterOutcome("new_lead", "appointment_set")).toBe("discovery_booked");
  });

  it("never moves a lead backwards", () => {
    expect(nextStageAfterOutcome("qualified", "no_answer")).toBeNull();
    expect(nextStageAfterOutcome("discovery_booked", "voicemail")).toBeNull();
  });

  it("terminal outcomes always win", () => {
    expect(nextStageAfterOutcome("discovery_booked", "not_interested")).toBe("lost");
    expect(nextStageAfterOutcome("new_lead", "do_not_call")).toBe("lost");
  });

  it("does not move leads that are already closed", () => {
    expect(nextStageAfterOutcome("won", "no_answer")).toBeNull();
    expect(nextStageAfterOutcome("lost", "voicemail")).toBeNull();
    expect(nextStageAfterOutcome("lost", "not_interested")).toBeNull();
  });

  it("ignores outcomes with no stage meaning", () => {
    expect(nextStageAfterOutcome("new_lead", "unknown_outcome")).toBeNull();
  });
});
