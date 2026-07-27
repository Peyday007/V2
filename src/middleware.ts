import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, isProtectedPath, verifyAdminToken } from "@/lib/adminAuth";

/**
 * Gate the admin console behind the shared passphrase.
 *
 * FAILS OPEN when ADMIN_PASSWORD is not set. That is deliberate: environment
 * variables on Vercel only take effect after a redeploy, so failing closed
 * would brick the whole site for anyone who adds the variable and forgets. The
 * admin pages show a loud banner while unprotected, so it cannot go unnoticed.
 */
export async function middleware(req: NextRequest) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return NextResponse.next();

  const { pathname, search } = req.nextUrl;
  if (!isProtectedPath(pathname)) return NextResponse.next();

  const token = req.cookies.get(ADMIN_COOKIE)?.value;
  if (await verifyAdminToken(token, password)) return NextResponse.next();

  // An API call gets an honest status; a page gets the passphrase form.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not signed in to the admin console." },
      { status: 401 }
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/admin-login";
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own asset pipeline. The real allow-list lives in
  // isProtectedPath, where it is unit-tested.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
