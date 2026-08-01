import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  startRecording,
  appendPart,
  finalizeRecording,
  discardRecording,
  recordConsent,
  linkRecordingToCall,
  playbackUrlFor,
  loadRecordingSettings,
  BUCKET,
} from "../src/lib/recordingPipeline";
import { concatParts, orderedPartNames } from "../src/lib/recordingSession";
import { seededDb, FakeDb } from "./fakeSupabase";

const db = (f: FakeDb) => f as unknown as SupabaseClient;
const chunk = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const decode = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : "");

const LEAD = "lead-1";
const CALLER = "caller-1";

async function begin(f: FakeDb, leadState: string | null = "TX") {
  return startRecording(db(f), {
    clientCaptureId: "capture-1",
    leadId: LEAD,
    callerId: CALLER,
    leadState,
    mimeType: "audio/webm;codecs=opus",
  });
}

/** The whole point: capture, upload, stitch, play back. */
describe("recording to playback, end to end", () => {
  it("stitches the chunks back into the original audio and serves it", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const id = started.recordingId;

    await appendPart(db(f), id, 0, chunk("HEADER+one "), "audio/webm");
    await appendPart(db(f), id, 1, chunk("two "), "audio/webm");
    await appendPart(db(f), id, 2, chunk("three"), "audio/webm");

    const done = await finalizeRecording(db(f), id, { durationSeconds: 61, partsExpected: 3 });
    expect(done.ok).toBe(true);

    const row = f.rows("recordings")[0];
    expect(row.storage_url).toBe(`${id}/call.webm`);
    expect(row.duration_seconds).toBe(61);
    expect(row.telephony_status).toBe("completed");
    expect(decode(f.objects.get(String(row.storage_url)))).toBe("HEADER+one two three");

    // The parts were duplication once stitched.
    expect([...f.objects.keys()].filter((k) => k.includes("/parts/"))).toEqual([]);

    const url = await playbackUrlFor(db(f), id);
    expect(url).toContain(`${id}/call.webm`);
  });

  it("orders the parts itself rather than trusting the listing", async () => {
    // The fake returns its listing reversed, exactly as storage may.
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    for (let i = 0; i < 12; i++) {
      await appendPart(db(f), started.recordingId, i, chunk(`${i}|`), "audio/webm");
    }
    await finalizeRecording(db(f), started.recordingId, { durationSeconds: 10, partsExpected: 12 });
    const row = f.rows("recordings")[0];
    // Wrong order here means a file no player will open.
    expect(decode(f.objects.get(String(row.storage_url)))).toBe(
      "0|1|2|3|4|5|6|7|8|9|10|11|"
    );
  });

  it("links the recording to the call once the outcome creates one", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    f.seed("calls", [{ id: "call-9", lead_id: LEAD }]);
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("x"), "audio/webm");
    await finalizeRecording(db(f), started.recordingId, { durationSeconds: 5, partsExpected: 1 });

    await linkRecordingToCall(db(f), started.recordingId, "call-9", LEAD);

    expect(f.rows("recordings")[0].call_id).toBe("call-9");
    expect(f.rows("calls")[0].recording_id).toBe(started.recordingId);
  });

  it("writes an audit trail of start and stop", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("x"), "audio/webm");
    await finalizeRecording(db(f), started.recordingId, { durationSeconds: 5, partsExpected: 1 });

    const types = f.rows("compliance_events").map((e) => e.event_type);
    expect(types).toContain("recording_started");
    expect(types).toContain("recording_stopped");
  });
});

describe("consent decides whether audio survives", () => {
  it("refuses to start when recording is switched off", async () => {
    const f = seededDb({ recordingEnabled: false });
    const started = await begin(f);
    expect(started.ok).toBe(false);
    expect(f.rows("recordings")).toHaveLength(0);
    expect(f.rows("compliance_events")[0].event_type).toBe("recording_blocked");
  });

  it("refuses to start when the lead's state is unknown under per_state", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f, null);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toContain("blocked rather than guessed");
  });

  it("DELETES the audio when consent is refused, not merely flags it", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    const id = started.recordingId;

    await appendPart(db(f), id, 0, chunk("sensitive"), "audio/webm");
    expect(f.objects.size).toBe(1);

    const result = await recordConsent(db(f), id, "refused", "caller:1");
    expect(result.discarded).toBe(true);

    // The single most important assertion in this file.
    expect(f.objects.size).toBe(0);
    const row = f.rows("recordings")[0];
    expect(row.deleted_at).toBeTruthy();
    expect(row.discard_reason).toBe("consent_refused");
    expect(row.storage_url).toBeNull();

    const types = f.rows("compliance_events").map((e) => e.event_type);
    expect(types).toContain("consent_refused");
    expect(types).toContain("recording_deleted");
  });

  it("drops a chunk that arrives after a refusal", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await recordConsent(db(f), started.recordingId, "refused", "caller:1");

    const late = await appendPart(db(f), started.recordingId, 5, chunk("late"), "audio/webm");
    expect(late.ok).toBe(false);
    expect(f.objects.size).toBe(0);
  });

  it("refuses to finalize a recording whose consent was refused", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("x"), "audio/webm");
    // Mark refused directly, as a webhook or a second tab might.
    f.rows("recordings")[0].consent_status = "refused";

    const done = await finalizeRecording(db(f), started.recordingId, { durationSeconds: 3 });
    expect(done.ok).toBe(false);
    expect(f.objects.size).toBe(0);
  });

  it("reports rather than swallows a failed deletion", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("x"), "audio/webm");

    f.storageFailure = "storage offline";
    const result = await discardRecording(db(f), started.recordingId, "consent_refused", "caller:1");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not be deleted");
    const logged = f.rows("compliance_events").find((e) => e.event_type === "recording_deleted");
    expect((logged?.detail as Record<string, unknown>)?.deletionFailed).toBe(true);
  });
});

describe("retries and interruptions", () => {
  it("a retried start returns the same recording rather than a second one", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const first = await begin(f);
    const second = await begin(f);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.recordingId).toBe(first.recordingId);
    expect(f.rows("recordings")).toHaveLength(1);
  });

  it("a retried chunk overwrites rather than duplicating", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("first try"), "audio/webm");
    await appendPart(db(f), started.recordingId, 0, chunk("retry"), "audio/webm");
    expect(f.objects.size).toBe(1);

    await finalizeRecording(db(f), started.recordingId, { durationSeconds: 2, partsExpected: 1 });
    const row = f.rows("recordings")[0];
    expect(decode(f.objects.get(String(row.storage_url)))).toBe("retry");
  });

  it("a retried finalize is a no-op, not a second stitch", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("one"), "audio/webm");
    await finalizeRecording(db(f), started.recordingId, { durationSeconds: 2, partsExpected: 1 });
    const again = await finalizeRecording(db(f), started.recordingId, { durationSeconds: 99 });
    expect(again.ok).toBe(true);
    // The duration from the first, real finalize survives.
    expect(f.rows("recordings")[0].duration_seconds).toBe(2);
  });

  it("saves what uploaded when the tail was lost to a refresh", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    // Two chunks landed; the third never left the browser.
    await appendPart(db(f), started.recordingId, 0, chunk("part one "), "audio/webm");
    await appendPart(db(f), started.recordingId, 1, chunk("part two"), "audio/webm");

    const done = await finalizeRecording(db(f), started.recordingId, { partsExpected: 2 });
    expect(done.ok).toBe(true);
    const row = f.rows("recordings")[0];
    expect(decode(f.objects.get(String(row.storage_url)))).toBe("part one part two");
  });

  it("discards an empty recording rather than storing a zero-byte file", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    const done = await finalizeRecording(db(f), started.recordingId, {});
    expect(done.ok).toBe(false);
    expect(done.error).toContain("No audio was captured");
    expect(f.rows("recordings")[0].deleted_at).toBeTruthy();
  });

  it("gives no playback link for a deleted recording", async () => {
    const f = seededDb({ consentPolicy: "per_state" });
    const started = await begin(f);
    if (!started.ok) return;
    await appendPart(db(f), started.recordingId, 0, chunk("x"), "audio/webm");
    await finalizeRecording(db(f), started.recordingId, { durationSeconds: 2 });
    await discardRecording(db(f), started.recordingId, "deleted_by_admin", "admin");
    expect(await playbackUrlFor(db(f), started.recordingId)).toBeNull();
  });
});

describe("settings fail closed", () => {
  it("treats an unreadable settings row as recording off", async () => {
    const f = new FakeDb(); // no settings row at all
    const settings = await loadRecordingSettings(db(f));
    expect(settings.recordingEnabled).toBe(false);
    expect(settings.consentPolicy).toBe("all_party");
    expect(settings.transcriptionEnabled).toBe(false);
  });

  it("uses the private bucket, never a public one", () => {
    expect(BUCKET).toBe("call-recordings");
  });
});

describe("stitching", () => {
  it("preserves bytes exactly", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    expect([...concatParts([a, b])]).toEqual([1, 2, 3, 4, 5]);
    expect(concatParts([]).byteLength).toBe(0);
  });

  it("sorts part names so 10 follows 9", () => {
    expect(orderedPartNames(["000010", "000009", "000002"])).toEqual([
      "000002",
      "000009",
      "000010",
    ]);
  });
});
