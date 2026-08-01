import { describe, it, expect, afterEach } from "vitest";
import {
  configuredTranscriber,
  transcriptionCapability,
  normaliseDeepgram,
  normaliseWhisper,
  prepareSegments,
} from "../src/lib/transcription";

const ENV_KEYS = ["TRANSCRIPTION_PROVIDER", "DEEPGRAM_API_KEY", "OPENAI_API_KEY"];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("no provider is pretended into existence", () => {
  it("reports none by default, and says what that means", () => {
    expect(configuredTranscriber()).toBe("none");
    const cap = transcriptionCapability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain("saved and playable but not written out as text");
  });

  it("says exactly what an admin has to do", () => {
    expect(transcriptionCapability().remedy).toContain("TRANSCRIPTION_PROVIDER");
  });

  it("refuses a selected provider whose key is missing, rather than failing later", () => {
    process.env.TRANSCRIPTION_PROVIDER = "deepgram";
    const cap = transcriptionCapability();
    expect(cap.available).toBe(false);
    expect(cap.reason).toContain("API key is missing");
    expect(cap.remedy).toContain("DEEPGRAM_API_KEY");
  });

  it("accepts a provider once its key is present", () => {
    process.env.TRANSCRIPTION_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(transcriptionCapability().available).toBe(true);
  });

  it("treats whisper as an alias for openai", () => {
    process.env.TRANSCRIPTION_PROVIDER = "whisper";
    expect(configuredTranscriber()).toBe("openai");
  });

  it("ignores a provider name it does not implement", () => {
    process.env.TRANSCRIPTION_PROVIDER = "some-startup";
    expect(configuredTranscriber()).toBe("none");
  });
});

/**
 * One microphone hears the caller directly and the prospect through a phone
 * speaker. Deciding which is which from that is guesswork, and a transcript
 * that guesses wrong is worse than one that says it does not know.
 */
describe("speakers are never guessed", () => {
  it("does not turn a Deepgram speaker index into an identity", () => {
    const segments = normaliseDeepgram({
      results: {
        channels: [
          {
            alternatives: [
              {
                paragraphs: {
                  paragraphs: [
                    { speaker: 0, start: 0, end: 2.5, sentences: [{ text: "Hi, is the owner in?" }] },
                    { speaker: 1, start: 2.6, end: 4, sentences: [{ text: "Speaking." }] },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.speaker === "unknown")).toBe(true);
  });

  it("strips a label the provider was not confident about", () => {
    const prepared = prepareSegments([
      { sequence: 0, startMs: 0, endMs: 10, speaker: "caller", speakerConfidence: 0.4, text: "hello" },
    ]);
    expect(prepared[0].speaker).toBe("unknown");
  });

  it("keeps a label the provider was confident about", () => {
    const prepared = prepareSegments([
      { sequence: 0, startMs: 0, endMs: 10, speaker: "caller", speakerConfidence: 0.9, text: "hello" },
    ]);
    expect(prepared[0].speaker).toBe("caller");
  });
});

describe("Deepgram responses", () => {
  it("groups words by speaker when there are no paragraphs", () => {
    const segments = normaliseDeepgram({
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [
                  { punctuated_word: "Hello,", start: 0, end: 0.4, speaker: 0 },
                  { punctuated_word: "there.", start: 0.4, end: 0.8, speaker: 0 },
                  { punctuated_word: "Speaking.", start: 1.0, end: 1.5, speaker: 1 },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("Hello, there.");
    expect(segments[0].endMs).toBe(800);
    expect(segments[1].text).toBe("Speaking.");
  });

  it("returns nothing rather than throwing on a shape it does not know", () => {
    expect(normaliseDeepgram({})).toEqual([]);
    expect(normaliseDeepgram(null)).toEqual([]);
    expect(normaliseDeepgram({ results: { channels: [] } })).toEqual([]);
  });

  it("converts seconds to milliseconds", () => {
    const segments = normaliseDeepgram({
      results: {
        channels: [
          {
            alternatives: [
              {
                paragraphs: {
                  paragraphs: [{ start: 1.25, end: 3.5, sentences: [{ text: "ok" }] }],
                },
              },
            ],
          },
        ],
      },
    });
    expect(segments[0].startMs).toBe(1250);
    expect(segments[0].endMs).toBe(3500);
  });
});

describe("Whisper responses", () => {
  it("reads timestamped segments", () => {
    const segments = normaliseWhisper({
      segments: [
        { start: 0, end: 2, text: " Hi there." },
        { start: 2, end: 5, text: " Is the owner around?" },
      ],
    });
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe("Hi there.");
    expect(segments[1].startMs).toBe(2000);
  });

  it("falls back to one block when only plain text came back", () => {
    const segments = normaliseWhisper({ text: "the whole call" });
    expect(segments).toHaveLength(1);
    expect(segments[0].startMs).toBe(0);
  });

  it("returns nothing on an empty response", () => {
    expect(normaliseWhisper({})).toEqual([]);
    expect(normaliseWhisper({ text: "   " })).toEqual([]);
  });
});

describe("preparing segments for storage", () => {
  it("drops empties and re-sequences from zero", () => {
    const prepared = prepareSegments([
      { sequence: 5, startMs: 0, endMs: 1, speaker: "unknown", speakerConfidence: null, text: "one" },
      { sequence: 6, startMs: 1, endMs: 2, speaker: "unknown", speakerConfidence: null, text: "   " },
      { sequence: 7, startMs: 2, endMs: 3, speaker: "unknown", speakerConfidence: null, text: "two" },
    ]);
    expect(prepared.map((s) => s.sequence)).toEqual([0, 1]);
    expect(prepared.map((s) => s.text)).toEqual(["one", "two"]);
  });

  it("never emits a negative timestamp", () => {
    const prepared = prepareSegments([
      { sequence: 0, startMs: -10, endMs: -5, speaker: "unknown", speakerConfidence: null, text: "x" },
    ]);
    expect(prepared[0].startMs).toBe(0);
    expect(prepared[0].endMs).toBe(0);
  });
});
