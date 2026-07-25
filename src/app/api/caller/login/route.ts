import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { makeSessionToken, CALLER_COOKIE } from "@/lib/callerSession";

export async function POST(req: NextRequest) {
  const { pin } = await req.json();
  if (!pin || !/^\d{6}$/.test(pin)) {
    return NextResponse.json({ error: "Enter your 6-digit PIN" }, { status: 400 });
  }
  const { data: caller } = await supabase()
    .from("callers")
    .select("id, name, active")
    .eq("pin", pin)
    .single();
  if (!caller || !caller.active) {
    return NextResponse.json({ error: "Invalid PIN" }, { status: 401 });
  }
  const res = NextResponse.json({ id: caller.id, name: caller.name });
  res.cookies.set(CALLER_COOKIE, makeSessionToken(caller.id), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 12,
    path: "/",
  });
  return res;
}
