import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

const COOKIE_NAME = "caller_session";

function secret(): string {
  const s = process.env.CALLER_SESSION_SECRET;
  if (!s) throw new Error("Missing CALLER_SESSION_SECRET");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function makeSessionToken(callerId: string): string {
  const payload = `${callerId}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = sign(payload);
  const given = parts[2];
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return null;
  return parts[0];
}

export async function getCallerId(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export const CALLER_COOKIE = COOKIE_NAME;
