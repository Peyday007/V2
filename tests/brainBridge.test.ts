import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, sign, createHash } from "node:crypto";

// brainBridge imports "server-only", which throws outside a server bundle.
vi.mock("server-only", () => ({}));

import { verifyBrainRequest, type BrainPublicKey } from "../src/lib/brainBridge";

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const kid = createHash("sha256").update(der).digest("hex").slice(0, 16);
  return { privateKey, pinned: { kid, spki: der.toString("base64") } as BrainPublicKey };
}

const NOW = 1_800_000_000_000;
const PATH = "/api/brain/places";

function signed(
  privateKey: ReturnType<typeof makeKey>["privateKey"],
  kid: string,
  body: string,
  timestamp = String(NOW),
  path = PATH
) {
  const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
  const data = Buffer.from(`POST\n${path}\n${timestamp}\n${bodyHash}`, "utf8");
  return {
    method: "POST",
    path: PATH,
    timestamp,
    keyId: kid,
    signature: sign(null, data, privateKey).toString("base64"),
    body,
  };
}

describe("verifyBrainRequest", () => {
  const { privateKey, pinned } = makeKey();
  const keys = [pinned];
  const body = JSON.stringify({ textQuery: "plumbers in Austin" });

  it("accepts a correctly signed request", () => {
    expect(verifyBrainRequest(signed(privateKey, pinned.kid, body), keys, NOW)).toEqual({ ok: true });
  });

  it("accepts within the ±5 minute window", () => {
    const req = signed(privateKey, pinned.kid, body, String(NOW - 299_000));
    expect(verifyBrainRequest(req, keys, NOW).ok).toBe(true);
  });

  it("rejects an unknown kid", () => {
    const req = signed(privateKey, "0000000000000000", body);
    expect(verifyBrainRequest(req, keys, NOW).ok).toBe(false);
  });

  it("rejects when no keys are pinned", () => {
    expect(verifyBrainRequest(signed(privateKey, pinned.kid, body), [], NOW).ok).toBe(false);
  });

  it("rejects a stale or future timestamp", () => {
    expect(verifyBrainRequest(signed(privateKey, pinned.kid, body, String(NOW - 300_001)), keys, NOW).ok).toBe(false);
    expect(verifyBrainRequest(signed(privateKey, pinned.kid, body, String(NOW + 300_001)), keys, NOW).ok).toBe(false);
  });

  it("rejects a tampered body", () => {
    const req = signed(privateKey, pinned.kid, body);
    expect(verifyBrainRequest({ ...req, body: body + " " }, keys, NOW).ok).toBe(false);
  });

  it("rejects a signature made for a different path", () => {
    const req = signed(privateKey, pinned.kid, body, String(NOW), "/api/brain/other");
    expect(verifyBrainRequest(req, keys, NOW).ok).toBe(false);
  });

  it("rejects a signature from a different key under a pinned kid", () => {
    const other = makeKey();
    const req = signed(other.privateKey, pinned.kid, body);
    expect(verifyBrainRequest(req, keys, NOW).ok).toBe(false);
  });

  it("rejects malformed signatures and headers without throwing", () => {
    const good = signed(privateKey, pinned.kid, body);
    for (const bad of [
      { ...good, signature: "not base64!!" },
      { ...good, signature: "" },
      { ...good, signature: null },
      { ...good, signature: Buffer.alloc(10).toString("base64") },
      { ...good, timestamp: "abc" },
      { ...good, timestamp: undefined },
      { ...good, keyId: null },
    ]) {
      const v = verifyBrainRequest(bad, keys, NOW);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(typeof v.reason).toBe("string");
    }
  });

  it("rejects a mis-pinned entry whose kid is not its key's hash", () => {
    const other = makeKey();
    // Real kid of key A, but the SPKI of key B pinned under it.
    const misPinned: BrainPublicKey = { kid: pinned.kid, spki: other.pinned.spki };
    const req = signed(other.privateKey, pinned.kid, body);
    const v = verifyBrainRequest(req, [misPinned], NOW);
    expect(v.ok).toBe(false);
  });

  it("rejects a pinned entry that is not a key at all", () => {
    const junk = Buffer.from("not a key");
    const kid = createHash("sha256").update(junk).digest("hex").slice(0, 16);
    const req = signed(privateKey, kid, body);
    expect(verifyBrainRequest(req, [{ kid, spki: junk.toString("base64") }], NOW).ok).toBe(false);
  });
});
