// Admin passphrase.
//
// Callers need the site's domain to reach the dialer, so obscuring the URL was
// never going to keep them off the admin pages — /dial and / are one click
// apart. This gates every admin page and admin API behind one shared
// passphrase, held in a signed cookie so it is typed once per device.
//
// Uses Web Crypto rather than node's `crypto`, because middleware runs on the
// edge runtime where node's version is not available.

export const ADMIN_COOKIE = "admin_session";
export const ADMIN_SESSION_DAYS = 30;

/**
 * Paths that must NEVER be gated.
 *
 * Getting this wrong locks the callers out of their job, so the list is
 * explicit and unit-tested rather than a clever regex.
 */
/**
 * These match exactly, or as a whole path segment. "/dial" opens the dialer
 * and "/dial/anything" under it, but NOT "/dialogue-admin" — a plain
 * startsWith would have opened that too.
 */
const OPEN_ROUTES = [
  "/dial", // the caller app itself
  "/admin-login", // the passphrase form has to render
];

/** These match as a literal prefix. */
const OPEN_PREFIXES = [
  "/api/caller/", // caller PIN sign-in and sign-out
  "/api/dial/", // next lead, log outcome
  "/api/worker/", // the background engine; has its own WORKER_SECRET
  "/api/admin/", // the passphrase form has to be able to post somewhere
  "/_next/", // framework assets
  "/favicon", // favicon.ico and friends
];

export function isProtectedPath(pathname: string): boolean {
  for (const route of OPEN_ROUTES) {
    if (pathname === route || pathname.startsWith(`${route}/`)) return false;
  }
  for (const prefix of OPEN_PREFIXES) {
    if (pathname.startsWith(prefix)) return false;
  }
  return true;
}

export function adminPasswordConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare, so a wrong cookie cannot be guessed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function makeAdminToken(password: string, now = Date.now()): Promise<string> {
  const issuedAt = String(now);
  return `${issuedAt}.${await hmacHex(password, issuedAt)}`;
}

export async function verifyAdminToken(
  token: string | undefined | null,
  password: string,
  now = Date.now()
): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const issuedAt = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const issued = Number(issuedAt);
  if (!Number.isFinite(issued)) return false;
  // An old cookie stops working, and one dated in the future is nonsense.
  const age = now - issued;
  if (age < -60_000 || age > ADMIN_SESSION_DAYS * 86_400_000) return false;

  return safeEqual(await hmacHex(password, issuedAt), signature);
}
