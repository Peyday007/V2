import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_COOKIE,
  ADMIN_SESSION_DAYS,
  makeAdminToken,
  safeEqual,
} from "@/lib/adminAuth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return NextResponse.json(
      {
        error:
          "ADMIN_PASSWORD is not set on this deployment, so there is nothing to sign in to. " +
          "Add it in Vercel → Settings → Environment Variables, then redeploy.",
      },
      { status: 503 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const given = typeof body.password === "string" ? body.password : "";

  if (!safeEqual(given, password)) {
    // Deliberately vague and slow-ish: no hint about length or near-misses.
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: "That passphrase is not right." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await makeAdminToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_SESSION_DAYS * 86_400,
  });
  return res;
}
