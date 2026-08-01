import { describe, it, expect } from "vitest";
import {
  isProtectedPath,
  makeAdminToken,
  verifyAdminToken,
  safeEqual,
  ADMIN_SESSION_DAYS,
} from "../src/lib/adminAuth";

const PASSWORD = "correct-horse-battery-staple-9482";

/**
 * The risk in this feature is not that someone gets in. It is that the gate
 * catches the caller app and stops the team working. These tests pin the
 * allow-list first.
 */
describe("the caller app is never gated", () => {
  it("leaves the dialer open", () => {
    expect(isProtectedPath("/dial")).toBe(false);
  });

  it("leaves caller sign-in open", () => {
    expect(isProtectedPath("/api/caller/login")).toBe(false);
    expect(isProtectedPath("/api/caller/logout")).toBe(false);
  });

  it("leaves the dialer's own endpoints open", () => {
    expect(isProtectedPath("/api/dial/next")).toBe(false);
    expect(isProtectedPath("/api/dial/outcome")).toBe(false);
  });

  it("leaves the background engine open — it has its own secret", () => {
    expect(isProtectedPath("/api/worker/tick")).toBe(false);
  });

  it("leaves the passphrase page and its endpoints open, or nobody could sign in", () => {
    expect(isProtectedPath("/admin-login")).toBe(false);
    expect(isProtectedPath("/api/admin/login")).toBe(false);
    expect(isProtectedPath("/api/admin/logout")).toBe(false);
  });

  it("leaves framework assets open", () => {
    expect(isProtectedPath("/_next/static/chunk.js")).toBe(false);
    expect(isProtectedPath("/favicon.ico")).toBe(false);
  });
});

describe("everything an admin sees is gated", () => {
  it("gates the board", () => {
    expect(isProtectedPath("/")).toBe(true);
  });

  it("gates every admin page", () => {
    for (const p of [
      "/admin/sourcing",
      "/admin/analytics",
      "/admin/campaigns",
      "/admin/callers",
      "/admin/suppressions",
      "/admin/history",
      "/admin/import",
      "/admin/appointments",
      "/metrics",
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it("gates the admin APIs, not just the pages", () => {
    for (const p of [
      "/api/leads",
      "/api/packets",
      "/api/packets/abc-123",
      "/api/analytics",
      "/api/pipeline",
      "/api/sourcing",
      "/api/callers",
      "/api/suppressions",
      "/api/events",
      "/api/diagnostics",
      "/api/import",
      "/api/prioritize",
      "/api/metrics",
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it("is not fooled by a path that merely starts like the caller app", () => {
    expect(isProtectedPath("/dialogue-admin")).toBe(true);
    expect(isProtectedPath("/api/dialsomething")).toBe(true);
  });
});

describe("safeEqual", () => {
  it("matches identical strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });
  it("rejects different strings of the same length", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
  });
  it("rejects different lengths without throwing", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("session tokens", () => {
  it("a token made with the passphrase verifies", async () => {
    const token = await makeAdminToken(PASSWORD);
    expect(await verifyAdminToken(token, PASSWORD)).toBe(true);
  });

  it("a token does not verify against a different passphrase", async () => {
    const token = await makeAdminToken(PASSWORD);
    expect(await verifyAdminToken(token, "something-else")).toBe(false);
  });

  it("changing the passphrase invalidates every existing session", async () => {
    const old = await makeAdminToken("old-passphrase");
    expect(await verifyAdminToken(old, "new-passphrase")).toBe(false);
  });

  it("a missing or malformed token is rejected", async () => {
    expect(await verifyAdminToken(undefined, PASSWORD)).toBe(false);
    expect(await verifyAdminToken("", PASSWORD)).toBe(false);
    expect(await verifyAdminToken("garbage", PASSWORD)).toBe(false);
    expect(await verifyAdminToken("notanumber.abc123", PASSWORD)).toBe(false);
  });

  it("a tampered signature is rejected", async () => {
    const token = await makeAdminToken(PASSWORD);
    const [issued] = token.split(".");
    expect(await verifyAdminToken(`${issued}.${"0".repeat(64)}`, PASSWORD)).toBe(false);
  });

  it("a tampered timestamp is rejected, so a session cannot be extended", async () => {
    const now = Date.now();
    const token = await makeAdminToken(PASSWORD, now);
    const sig = token.split(".")[1];
    expect(await verifyAdminToken(`${now + 1}.${sig}`, PASSWORD)).toBe(false);
  });

  it("expires after the session window", async () => {
    const then = Date.now() - (ADMIN_SESSION_DAYS + 1) * 86_400_000;
    const token = await makeAdminToken(PASSWORD, then);
    expect(await verifyAdminToken(token, PASSWORD)).toBe(false);
  });

  it("still valid just inside the window", async () => {
    const then = Date.now() - (ADMIN_SESSION_DAYS - 1) * 86_400_000;
    const token = await makeAdminToken(PASSWORD, then);
    expect(await verifyAdminToken(token, PASSWORD)).toBe(true);
  });

  it("rejects a token dated in the future", async () => {
    const token = await makeAdminToken(PASSWORD, Date.now() + 10 * 60_000);
    expect(await verifyAdminToken(token, PASSWORD)).toBe(false);
  });

  it("tolerates small clock skew between the browser and the server", async () => {
    const token = await makeAdminToken(PASSWORD, Date.now() + 5_000);
    expect(await verifyAdminToken(token, PASSWORD)).toBe(true);
  });
});

/**
 * Recording is split across two auth regimes on purpose: callers sign in with
 * a PIN, admins with the passphrase. Getting this wrong either locks callers
 * out of recording or opens recordings to anyone who finds the URL.
 */
describe("recording endpoints sit on the right side of the passphrase", () => {
  it("lets a PIN-signed caller reach the capture endpoints", () => {
    for (const p of [
      "/api/dial/recording",
      "/api/dial/recording/abc-123",
      "/api/dial/recording/abc-123/part",
      "/api/dial/recording/abc-123/finalize",
      "/api/dial/recording/abc-123/consent",
    ]) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it("keeps playback, transcripts and settings behind the passphrase", () => {
    for (const p of [
      "/api/recordings",
      "/api/recordings/abc-123",
      "/api/recordings/abc-123/transcribe",
      "/api/recording-settings",
      "/admin/recording",
    ]) {
      expect(isProtectedPath(p), p).toBe(true);
    }
  });

  it("does not open a lookalike path by prefix", () => {
    // The open prefix is "/api/dial/", so nothing outside it may sneak through.
    expect(isProtectedPath("/api/dialogue-recording")).toBe(true);
    expect(isProtectedPath("/api/recordings-export")).toBe(true);
  });
});
