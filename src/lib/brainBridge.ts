import "server-only";
import { createHash, createPublicKey, verify } from "node:crypto";

// Brain bridge — lets Brain (a separate system) use V2's Google Places
// connection without the Google key ever leaving this deployment.
//
// Brain signs each request with an Ed25519 private key it alone holds. V2
// verifies the signature against the PUBLIC keys pinned below. A public key is
// not a secret, so pinning it in source needs no environment variable, and a
// leak of this file grants nothing.

export type BrainPublicKey = { kid: string; spki: string };

/**
 * Pinned Brain public keys.
 *
 * `spki` is base64 of the SPKI DER of an Ed25519 public key; `kid` is the first
 * 16 hex chars of sha256(SPKI DER). Brain's integrations workflow publishes the
 * key and a session pins it here. Empty means every request is refused.
 */
export const BRAIN_PUBLIC_KEYS: BrainPublicKey[] = [];

/** How far a request's timestamp may sit from the server clock. */
export const BRAIN_MAX_SKEW_MS = 300_000;

export type BrainRequest = {
  method: string;
  path: string;
  timestamp: string | null | undefined;
  keyId: string | null | undefined;
  signature: string | null | undefined;
  body: string;
};

export type BrainVerdict = { ok: true } | { ok: false; reason: string };

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function brainKeyId(spkiDer: Buffer): string {
  return sha256Hex(spkiDer).slice(0, 16);
}

/** The exact UTF-8 string Brain signs. */
export function brainSigningString(
  method: string,
  path: string,
  timestamp: string,
  body: string
): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256Hex(body)}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function verifyBrainRequest(
  req: BrainRequest,
  keys: BrainPublicKey[] = BRAIN_PUBLIC_KEYS,
  now: number = Date.now()
): BrainVerdict {
  try {
    const { method, path, timestamp, keyId, signature, body } = req;
    if (!keyId) return { ok: false, reason: "missing key id" };
    if (!timestamp) return { ok: false, reason: "missing timestamp" };
    if (!signature) return { ok: false, reason: "missing signature" };
    if (typeof body !== "string") return { ok: false, reason: "body is not a string" };

    const pinned = keys.find((k) => k.kid === keyId);
    if (!pinned) return { ok: false, reason: "unknown key id" };

    const der = Buffer.from(pinned.spki, "base64");
    if (brainKeyId(der) !== pinned.kid) {
      return { ok: false, reason: "pinned key id does not match its key" };
    }

    if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: "malformed timestamp" };
    if (Math.abs(now - ts) > BRAIN_MAX_SKEW_MS) {
      return { ok: false, reason: "timestamp outside allowed window" };
    }

    if (!BASE64.test(signature)) return { ok: false, reason: "malformed signature" };
    const sig = Buffer.from(signature, "base64");
    if (sig.length !== 64) return { ok: false, reason: "malformed signature" };

    let key;
    try {
      key = createPublicKey({ key: der, format: "der", type: "spki" });
    } catch {
      return { ok: false, reason: "pinned key is not a valid SPKI key" };
    }
    if (key.asymmetricKeyType !== "ed25519") {
      return { ok: false, reason: "pinned key is not Ed25519" };
    }

    const data = Buffer.from(brainSigningString(method, path, timestamp, body), "utf8");
    if (!verify(null, data, key, sig)) return { ok: false, reason: "bad signature" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `verification error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
