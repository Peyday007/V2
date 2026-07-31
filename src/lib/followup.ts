// Immediate follow-up.
//
// A warm prospect goes cold in minutes. The default target is ten, which means
// the queue has to be unambiguous about what is late and by how much — and the
// draft has to be ready before the caller opens it, or the ten minutes go on
// writing rather than sending.
//
// Drafting and SENDING are separate switches, and sending is off by default.
// Nothing reaches a prospect without a person pressing the button unless an
// administrator has explicitly turned that on.

import type { CallAnalysisResult } from "./callAnalysis";

export type FollowupKind = "email" | "call_back" | "send_info" | "other";

export type FollowupStatus =
  | "pending"
  | "drafted"
  | "approved"
  | "sent"
  | "answered"
  | "converted"
  | "cancelled"
  | "overdue";

export const OPEN_STATUSES: FollowupStatus[] = ["pending", "drafted", "approved", "overdue"];

export type FollowupTrigger = {
  reason: string;
  kind: FollowupKind;
  /** Where it goes, when the call captured it. */
  target: string | null;
};

/**
 * Should this call produce a follow-up at all?
 *
 * Deliberately narrow: a follow-up for every call would bury the ones that
 * matter, which defeats the queue. Only an explicit request or genuine
 * qualified interest qualifies.
 */
export function triggerFor(
  outcome: string,
  analysis: CallAnalysisResult
): FollowupTrigger | null {
  if (analysis.doNotCallRequested) return null;

  if (analysis.contactConfirmed && analysis.followupRequested) {
    return {
      reason: "They asked for information and gave you an address",
      kind: "email",
      target: analysis.contactConfirmed ?? null,
    };
  }
  if (outcome === "appointment_set") {
    return {
      reason: "Meeting booked — confirm it in writing",
      kind: "email",
      target: analysis.contactConfirmed ?? null,
    };
  }
  if (analysis.interestLevel === "strong") {
    return {
      reason: "Strong interest on the call",
      kind: analysis.contactConfirmed ? "email" : "call_back",
      target: analysis.contactConfirmed ?? null,
    };
  }
  if (outcome === "callback" || analysis.followupRequested) {
    return {
      reason: "Follow-up agreed on the call",
      kind: analysis.contactConfirmed ? "email" : "call_back",
      target: analysis.contactConfirmed ?? null,
    };
  }
  return null;
}

export function deadlineFor(
  trigger: FollowupTrigger,
  now: Date,
  deadlineMinutes: number,
  explicitDeadline?: string | null
): Date {
  // A time the prospect actually asked for always wins over the default.
  if (explicitDeadline) {
    const d = new Date(explicitDeadline);
    if (!Number.isNaN(d.getTime()) && d.getTime() > now.getTime()) return d;
  }
  // A promised call back is not the same urgency as a warm email.
  const minutes = trigger.kind === "call_back" ? Math.max(deadlineMinutes, 60) : deadlineMinutes;
  return new Date(now.getTime() + minutes * 60_000);
}

export type QueueItem = {
  id: string;
  dueAt: string;
  status: FollowupStatus;
  businessName?: string | null;
};

export type QueueEntry = QueueItem & {
  minutesLate: number;
  minutesRemaining: number;
  urgency: "overdue" | "due_now" | "soon" | "later" | "done";
  urgencyLabel: string;
};

/** Sorted worst-first, because the queue exists to surface what is late. */
export function buildQueue(items: QueueItem[], now = new Date()): QueueEntry[] {
  return items
    .map((item) => {
      const due = new Date(item.dueAt).getTime();
      const diffMs = due - now.getTime();
      const minutes = Math.round(diffMs / 60_000);

      if (!OPEN_STATUSES.includes(item.status)) {
        return {
          ...item,
          minutesLate: 0,
          minutesRemaining: 0,
          urgency: "done" as const,
          urgencyLabel: item.status,
        };
      }
      if (diffMs < 0) {
        const late = Math.abs(minutes);
        return {
          ...item,
          minutesLate: late,
          minutesRemaining: 0,
          urgency: "overdue" as const,
          urgencyLabel:
            late < 60 ? `${late} min late` : `${Math.round(late / 60)}h late`,
        };
      }
      if (minutes <= 2) {
        return {
          ...item,
          minutesLate: 0,
          minutesRemaining: minutes,
          urgency: "due_now" as const,
          urgencyLabel: "due now",
        };
      }
      if (minutes <= 30) {
        return {
          ...item,
          minutesLate: 0,
          minutesRemaining: minutes,
          urgency: "soon" as const,
          urgencyLabel: `${minutes} min left`,
        };
      }
      return {
        ...item,
        minutesLate: 0,
        minutesRemaining: minutes,
        urgency: "later" as const,
        urgencyLabel:
          minutes < 1440 ? `${Math.round(minutes / 60)}h left` : `${Math.round(minutes / 1440)}d left`,
      };
    })
    .sort((a, b) => {
      const rank = { overdue: 0, due_now: 1, soon: 2, later: 3, done: 4 };
      return (
        rank[a.urgency] - rank[b.urgency] ||
        new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()
      );
    });
}

/** Late, and nobody has been told yet. */
export function needsAlert(
  entry: { urgency: string; alertedAt?: string | null }
): boolean {
  return entry.urgency === "overdue" && !entry.alertedAt;
}

/* -------------------------------------------------------------------------- */
/* drafting                                                                   */
/* -------------------------------------------------------------------------- */

export type DraftContext = {
  businessName: string;
  contactName?: string | null;
  callerName: string;
  trigger: FollowupTrigger;
  analysis: CallAnalysisResult;
};

/**
 * A draft built only from what was confirmed on the call.
 *
 * No invented benefits, no made-up pricing, no claims about what was
 * discussed. If the call did not establish a problem, the draft does not
 * pretend one was named — it asks.
 */
export function draftFollowup(ctx: DraftContext): { subject: string; body: string } {
  const first = (ctx.contactName || "").trim().split(/\s+/)[0] || "there";
  const problem = (ctx.analysis.needsDiscovered || [])[0];
  const meeting = ctx.analysis.meetingAt
    ? new Date(ctx.analysis.meetingAt)
    : null;

  if (ctx.trigger.kind === "email" && meeting) {
    return {
      subject: `Confirming ${meeting.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`,
      body: [
        `Hi ${first},`,
        "",
        `Thanks for your time just now. Confirming we are speaking ${meeting.toLocaleString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}.`,
        problem ? `\nI will come ready to talk about ${problem.toLowerCase()}.` : "",
        "",
        "If anything changes, just reply here and we will move it.",
        "",
        ctx.callerName,
      ]
        .filter((l) => l !== "")
        .join("\n"),
    };
  }

  return {
    subject: problem
      ? `${ctx.businessName} — the missed-calls problem you mentioned`
      : `Following up — ${ctx.businessName}`,
    body: [
      `Hi ${first},`,
      "",
      "Thanks for taking my call just now.",
      problem
        ? `You mentioned ${problem.toLowerCase()} — that is exactly what we handle: your phone gets answered when nobody can pick up, so the job does not go to whoever they ring next.`
        : "As promised, here is a short note on what we do: your phone gets answered when nobody on your team can pick up, so a missed call does not become a lost job.",
      "",
      "Worth fifteen minutes to see whether it fits? I can do most mornings this week.",
      "",
      ctx.callerName,
    ].join("\n"),
  };
}
