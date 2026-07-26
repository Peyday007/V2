import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { makeSessionToken, CALLER_COOKIE } from "@/lib/callerSession";
import { recordEvent } from "@/lib/events";

export async function POST(req: NextRequest) {
  // Without this secret no session cookie can be signed, so login can never
  // succeed. Say so plainly instead of throwing a 500 the caller can't read.
  if (!process.env.CALLER_SESSION_SECRET) {
    console.error("[caller/login] CALLER_SESSION_SECRET is not set");
    return NextResponse.json(
      {
        error:
          "Sign-in is not configured on this deployment. An admin needs to add CALLER_SESSION_SECRET in Vercel → Settings → Environment Variables, then redeploy.",
      },
      { status: 503 }
    );
  }

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
  await recordEvent({
    type: "caller.signed_in",
    entityType: "caller",
    entityId: caller.id,
    actorType: "caller",
    actorCallerId: caller.id,
    source: "ui",
    metadata: { name: caller.name },
  });

  const res = NextResponse.json({ id: caller.id, name: caller.name });
  res.cookies.set(CALLER_COOKIE, makeSessionToken(caller.id), {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 12,
    path: "/",
  });
  return res;
}
