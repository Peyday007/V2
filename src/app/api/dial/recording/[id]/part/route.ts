import { NextRequest, NextResponse } from "next/server";
import { getCallerId } from "@/lib/callerSession";
import { appendPart } from "@/lib/recordingStore";

export const dynamic = "force-dynamic";
// Audio chunks are binary, so the body is read raw rather than as JSON.
export const runtime = "nodejs";

/** One ~20 second chunk. The browser retries these, so it must be idempotent. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const callerId = await getCallerId();
  if (!callerId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id } = await ctx.params;
  const sequence = Number(req.nextUrl.searchParams.get("sequence"));
  if (!Number.isInteger(sequence) || sequence < 0) {
    return NextResponse.json({ error: "Bad sequence" }, { status: 400 });
  }

  const contentType = req.headers.get("content-type") || "application/octet-stream";
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength === 0) return NextResponse.json({ error: "Empty chunk" }, { status: 400 });

  const result = await appendPart(id, sequence, bytes, contentType);
  if (!result.ok) {
    // 409 tells the browser to stop retrying: consent was refused or the
    // recording is gone, and neither is fixed by trying again.
    const permanent = /deleted|no longer exists|Consent was refused/i.test(result.error || "");
    return NextResponse.json({ error: result.error }, { status: permanent ? 409 : 500 });
  }
  return NextResponse.json({ ok: true, sequence });
}
