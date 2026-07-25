import { NextResponse } from "next/server";
import { CALLER_COOKIE } from "@/lib/callerSession";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(CALLER_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
