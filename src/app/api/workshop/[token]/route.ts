import { NextRequest, NextResponse } from "next/server";
import {
  publicAssessment,
  packetByToken,
  trackWorkshopEvent,
  saveBottleneckAnswer,
  completeAudit,
  recordInterestDetails,
} from "@/lib/workshopAssessment";
import { AREA_ORDER, type BottleneckAnswer } from "@/lib/bottleneckAudit";
import { WORKSHOP_EVENTS, type WorkshopEvent } from "@/lib/workshopLifecycle";

export const dynamic = "force-dynamic";

// The only API a member of the public reaches.
//
// TWO PROPERTIES, above everything else in this file.
//
// A TOKEN SEES ONE WORKSHOP. Every read and every write is resolved through
// packetByToken and then scoped to that packet's id. There is no branch where
// a body parameter chooses which packet is written to — if there were, one
// prospect could reach another's assessment by guessing an id, which is the
// whole reason the token is long and random in the first place.
//
// NOTHING INTERNAL LEAVES. The response is built by publicAssessment, which
// runs every finding through stripInternal. The operator's notes, the caller's
// talk track and the internal ranking commentary are absent from the payload
// rather than hidden by the component that renders it.
//
// AND ONE THING THIS ENDPOINT DELIBERATELY CANNOT DO: change a finding. The
// public surface is read-plus-append — events, questionnaire answers, contact
// preference. No request from this page can alter what was observed.

/* -------------------------------------------------------------------------- */

export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const assessment = await publicAssessment(token);
  if (!assessment) {
    return NextResponse.json({ error: "This link is no longer available." }, { status: 404 });
  }
  if (assessment.status === "revoked" || assessment.status === "expired") {
    return NextResponse.json({ error: "This link is no longer available." }, { status: 404 });
  }
  return NextResponse.json(assessment);
}

/* -------------------------------------------------------------------------- */

type Action =
  | "track"
  | "save_answer"
  | "complete_audit"
  | "interested"
  | "request_walkthrough"
  | "request_private_example";

const WALKTHROUGH_EVENT: Record<string, WorkshopEvent> = {
  phone: "workshop.walkthrough_phone_requested",
  video: "workshop.walkthrough_video_requested",
  recorded: "workshop.walkthrough_recorded_requested",
};

function clean(v: unknown, max = 200): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const found = await packetByToken(token);
  if (!found) {
    return NextResponse.json({ error: "This link is no longer available." }, { status: 404 });
  }
  const packetId = found.packet.id as string;
  const status = String(found.packet.status ?? "");
  if (status === "revoked" || status === "expired") {
    return NextResponse.json({ error: "This link is no longer available." }, { status: 404 });
  }
  const variant = (found.packet.variant as string) ?? null;

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action ?? "") as Action;
  /*
   * A preview never counts. It is recorded — an operator should be able to see
   * that they looked — but trackWorkshopEvent refuses to advance the status
   * for one, so no preview can create interest, engagement or a conversion.
   */
  const isAdminPreview = body?.preview === true;

  switch (action) {
    /* ---------------------------------------------------------------- */
    case "track": {
      const event = String(body.event ?? "");
      if (!(WORKSHOP_EVENTS as readonly string[]).includes(event)) {
        return NextResponse.json({ error: "Unknown event." }, { status: 400 });
      }
      /*
       * The public page may only report that something was LOOKED AT. The
       * events that change the lifecycle — interest, a demo request, a
       * walkthrough, an approval — have their own actions below, with their
       * own validation. Accepting them here would let a crafted request
       * manufacture a conversion.
       */
      const viewOnly = event.match(
        /_viewed$|_expanded$|^workshop\.opened$|^workshop\.audit_(started|option_selected)$/
      );
      if (!viewOnly) {
        return NextResponse.json({ error: "That event is not reportable here." }, { status: 400 });
      }
      const { recorded } = await trackWorkshopEvent({
        packetId,
        event: event as WorkshopEvent,
        target: clean(body.target, 120) || null,
        variant,
        isAdminPreview,
      });
      return NextResponse.json({ ok: true, recorded, preview: isAdminPreview });
    }

    /* ---------------------------------------------------------------- */
    case "save_answer": {
      if (isAdminPreview) {
        return NextResponse.json({ ok: true, preview: true, firstTime: false, grantsAccess: false });
      }
      const area = clean(body.area, 60);
      if (!AREA_ORDER.includes(area as BottleneckAnswer["area"])) {
        return NextResponse.json({ error: "Unknown area." }, { status: 400 });
      }
      const freq = clean(body.frequency, 20);
      const affects = clean(body.affects, 20);
      const ok = await saveBottleneckAnswer(packetId, {
        area: area as BottleneckAnswer["area"],
        detail: clean(body.detail, 2000) || null,
        frequency: (["daily", "weekly", "occasionally", "unsure"].includes(freq)
          ? freq
          : null) as BottleneckAnswer["frequency"],
        affects: (["revenue", "time", "customers", "employees", "costs", "visibility"].includes(
          affects
        )
          ? affects
          : null) as BottleneckAnswer["affects"],
      });
      // Saved as they go, so a refresh mid-questionnaire loses nothing.
      await trackWorkshopEvent({
        packetId,
        event: "workshop.audit_option_selected",
        target: area,
        variant,
      });
      return NextResponse.json({ ok });
    }

    /* ---------------------------------------------------------------- */
    case "complete_audit": {
      if (isAdminPreview) {
        return NextResponse.json({ ok: true, preview: true, firstTime: false, grantsAccess: false });
      }
      const map = await completeAudit(packetId);
      await trackWorkshopEvent({
        packetId,
        event: "workshop.audit_completed",
        variant,
      });
      /*
       * If the map comes back empty because the answers could not be read,
       * the answers themselves are still saved — the owner's work is never
       * lost to a failure further down. They can retry and get their map.
       */
      return NextResponse.json({ ok: true, map, recoverable: map.length === 0 });
    }

    /* ---------------------------------------------------------------- */
    case "interested": {
      if (isAdminPreview) {
        return NextResponse.json({ ok: true, preview: true, firstTime: false, grantsAccess: false });
      }
      /*
       * THE BUTTON. What it does and, more importantly, what it does not.
       *
       * It records that somebody would like to see more. It does not begin a
       * trial, authorise access to anything, permit a change to a live system,
       * or constitute a purchase. Those are four separate acts with four
       * separate states, and none of them is reachable from here.
       */
      await recordInterestDetails(packetId, {
        name: clean(body.name),
        email: clean(body.email),
        phone: clean(body.phone, 50),
        preferred: ["phone", "email", "text"].includes(clean(body.preferred, 10))
          ? (clean(body.preferred, 10) as "phone" | "email" | "text")
          : undefined,
      });
      const { recorded } = await trackWorkshopEvent({
        packetId,
        event: "workshop.interest_clicked",
        variant,
      });
      // `recorded` false means the idempotency key rejected a repeat. That is
      // the system working: one click, one conversion, however many taps.
      return NextResponse.json({
        ok: true,
        firstTime: recorded,
        grantsAccess: false,
        startsTrial: false,
        message:
          "Thanks — we will put together the private example and get back to you. " +
          "Nothing in your business changes unless you explicitly ask us to.",
      });
    }

    /* ---------------------------------------------------------------- */
    case "request_private_example": {
      if (isAdminPreview) {
        return NextResponse.json({ ok: true, preview: true, firstTime: false, grantsAccess: false });
      }
      const { recorded } = await trackWorkshopEvent({
        packetId,
        event: "workshop.private_example_requested",
        target: clean(body.target, 120) || null,
        variant,
      });
      return NextResponse.json({ ok: true, firstTime: recorded, grantsAccess: false });
    }

    /* ---------------------------------------------------------------- */
    case "request_walkthrough": {
      if (isAdminPreview) {
        return NextResponse.json({ ok: true, preview: true, firstTime: false, grantsAccess: false });
      }
      const kind = clean(body.kind, 20);
      const event = WALKTHROUGH_EVENT[kind];
      if (!event) {
        return NextResponse.json({ error: "Unknown walkthrough type." }, { status: 400 });
      }
      await recordInterestDetails(packetId, {
        name: clean(body.name),
        email: clean(body.email),
        phone: clean(body.phone, 50),
        preferred: kind === "phone" ? "phone" : "email",
      });
      const { recorded } = await trackWorkshopEvent({ packetId, event, variant });
      return NextResponse.json({
        ok: true,
        firstTime: recorded,
        grantsAccess: false,
        message:
          kind === "recorded"
            ? "We will record a walkthrough and send you the link — nothing to attend."
            : "We will be in touch to find a time that suits you.",
      });
    }

    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
