import { describe, it, expect } from "vitest";
import {
  buildTranscriptPrompt,
  extractJson,
  parseAnalysis,
  transcriptConfidence,
  tooThinToRead,
  ANALYSIS_SYSTEM_PROMPT,
  MIN_WORDS_FOR_ANALYSIS,
  type TranscriptLine,
} from "../src/lib/transcriptAnalysis";

const line = (text: string, speaker = "unknown", startMs = 0): TranscriptLine => ({
  speaker,
  text,
  startMs,
});

const words = (n: number, speaker = "unknown") =>
  Array.from({ length: n }, (_, i) => line("word", speaker, i * 1000));

describe("the prompt", () => {
  it("tells the model that null is a correct answer", () => {
    // The whole design rests on this: these readings are applied unseen, so an
    // admitted gap has to be cheaper than a confident guess.
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/null/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/without a human checking/i);
  });

  it("warns that the prospect's side is a phone speaker across a desk", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/room capture/i);
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/Mis-heard words are expected/i);
  });

  it("forbids inventing a name or number", () => {
    expect(ANALYSIS_SYSTEM_PROMPT).toMatch(/Never invent/i);
  });

  it("timestamps every line and admits when the speaker is unknown", () => {
    const p = buildTranscriptPrompt({
      businessName: "Northside Plumbing",
      segments: [line("Hello there", "unknown", 65_000), line("Speaking", "caller", 70_000)],
    });
    expect(p).toContain("[1:05] ?: Hello there");
    expect(p).toContain("[1:10] caller: Speaking");
    expect(p).toContain("Northside Plumbing");
  });

  it("says the transcript is empty rather than sending nothing", () => {
    const p = buildTranscriptPrompt({ businessName: "X", segments: [] });
    expect(p).toContain("(empty)");
  });
});

describe("parsing what the model returns", () => {
  it("reads a clean object", () => {
    const r = parseAnalysis(
      JSON.stringify({
        personReached: "Dave, the owner",
        ownerReached: true,
        interestLevel: "mild",
        meetingStatus: "booked",
        objections: ["we already answer every call"],
      })
    );
    expect(r?.ownerReached).toBe(true);
    expect(r?.interestLevel).toBe("mild");
    expect(r?.objections).toEqual(["we already answer every call"]);
  });

  it("digs the object out of a fence or a preamble", () => {
    expect(extractJson('```json\n{"ownerReached": true}\n```')).toEqual({ ownerReached: true });
    expect(extractJson('Sure! Here you go: {"ownerReached": false} Hope that helps.')).toEqual({
      ownerReached: false,
    });
  });

  it("returns null on anything it cannot read, rather than half a result", () => {
    expect(parseAnalysis("not json at all")).toBeNull();
    expect(parseAnalysis("")).toBeNull();
    expect(extractJson("{ broken")).toBeNull();
  });

  it("drops an enum value it does not recognise", () => {
    const r = parseAnalysis(
      JSON.stringify({ interestLevel: "extremely keen", meetingStatus: "maybe" })
    );
    expect(r?.interestLevel).toBeUndefined();
    expect(r?.meetingStatus).toBeUndefined();
  });

  it("refuses a meeting date that is not a real date", () => {
    expect(parseAnalysis(JSON.stringify({ meetingAt: "next Tuesday" }))?.meetingAt).toBeNull();
    expect(parseAnalysis(JSON.stringify({ meetingAt: "sometime" }))?.meetingAt).toBeNull();
    const good = parseAnalysis(JSON.stringify({ meetingAt: "2026-08-04T14:00:00Z" }));
    expect(good?.meetingAt).toBe("2026-08-04T14:00:00.000Z");
  });

  it("treats the word 'unknown' as no answer", () => {
    expect(parseAnalysis(JSON.stringify({ personReached: "unknown" }))?.personReached).toBeNull();
    expect(parseAnalysis(JSON.stringify({ coachingPoint: "null" }))?.coachingPoint).toBeNull();
  });

  it("only accepts a real boolean, never a stringy one", () => {
    // "false" as a string would otherwise read as true downstream.
    expect(parseAnalysis(JSON.stringify({ ownerReached: "false" }))?.ownerReached).toBeNull();
    expect(parseAnalysis(JSON.stringify({ ownerReached: 1 }))?.ownerReached).toBeNull();
  });

  it("cleans lists and caps them", () => {
    const r = parseAnalysis(
      JSON.stringify({ objections: ["  spaced  ", "", "  ", ...Array(20).fill("x")] })
    );
    expect(r?.objections?.[0]).toBe("spaced");
    expect(r?.objections?.length).toBeLessThanOrEqual(12);
    expect(parseAnalysis(JSON.stringify({ objections: "not a list" }))?.objections).toEqual([]);
  });
});

/**
 * Confidence has to come from the transcript, not the model. A model asked how
 * sure it is will say 0.9 about three words.
 */
describe("confidence is measured, not self-reported", () => {
  it("is low on a transcript too thin to say anything", () => {
    expect(transcriptConfidence([line("hello")])).toBeLessThan(0.3);
    expect(tooThinToRead([line("hello there")])).toBe(true);
  });

  it("rises with usable speech", () => {
    const short = transcriptConfidence(words(MIN_WORDS_FOR_ANALYSIS + 5));
    const long = transcriptConfidence(words(400));
    expect(long).toBeGreaterThan(short);
  });

  it("rises when the transcriber could tell the speakers apart", () => {
    const anon = transcriptConfidence(words(200));
    const labelled = transcriptConfidence(words(200, "caller"));
    expect(labelled).toBeGreaterThan(anon);
  });

  it("never claims certainty, because a room capture never earns it", () => {
    expect(transcriptConfidence(words(5000, "caller"))).toBeLessThanOrEqual(0.95);
  });

  it("lets a real call through", () => {
    expect(tooThinToRead(words(MIN_WORDS_FOR_ANALYSIS + 1))).toBe(false);
  });
});
