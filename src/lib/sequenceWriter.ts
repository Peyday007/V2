import "server-only";
import { anthropic } from "./anthropic";
import { supabaseAdmin } from "./supabaseAdmin";
import { buildScript, SCRIPT_VERSIONS } from "./gatekeeperScripts";
import {
  looksLikePlan,
  normalisePlan,
  validatePlan,
  MIN_STEPS,
  MAX_STEPS,
  MIN_DELAY_DAYS,
  MAX_DELAY_DAYS,
  MAX_TOTAL_DAYS,
  MAX_SUBJECT_CHARS,
  MAX_BODY_CHARS,
  KNOWN_VARIABLES,
  type SequencePlan,
} from "./sequencePlan";

// Turning "here's what I want" into a sequence.
//
// The brief was to be able to talk normally and get high-converting emails
// back, without specifying how many or how far apart. So the writer is given
// three things a generic prompt would not have, and they are what make the
// difference between this and pasting the same request into a chat window:
//
//   WHAT WE ACTUALLY SAY ON THE PHONE. The gatekeeper scripts are the team's
//   real opening lines, already under A/B test. An email that sounds like the
//   call it precedes is one message; an email written from scratch is a second
//   unrelated one.
//
//   WHAT THE TEAM HAS BEEN TOLD. The team updates are where corrections and
//   positioning changes get written down. A sequence that contradicts the most
//   recent update is a sequence somebody has to remember to fix.
//
//   WHAT REPLIES ACTUALLY LOOK LIKE. Real refusals from the reply log say more
//   about what does not work than any amount of instruction.
//
// The model chooses the step count and the spacing. sequencePlan.ts fences
// that decision; this file feeds it and retries once with the problems fed
// back, which fixes almost everything that goes wrong.
//
// Cost note: this is one Sonnet call, run when somebody presses a button. It
// is not on any hot path.

const MODEL = "claude-sonnet-4-6";

export type WriteResult =
  | { ok: true; plan: SequencePlan; model: string; contextSummary: string }
  | { ok: false; error: string; problems?: { step: number | null; problem: string }[] };

/* -------------------------------------------------------------------------- */
/* what the writer is told about us                                           */
/* -------------------------------------------------------------------------- */

async function gatherContext(): Promise<{ text: string; summary: string }> {
  const db = supabaseAdmin();
  const parts: string[] = [];
  const summaryBits: string[] = [];

  // The openers the team is actually using on the phone.
  const scripts = SCRIPT_VERSIONS.map((v) => {
    const s = buildScript(v, { businessName: "the business", ownerName: null, reviewCount: null });
    return `- Script ${s.version} (${s.name}) — ${s.premise}\n  Opens: ${s.opener}`;
  }).join("\n");
  parts.push(`HOW THE TEAM OPENS ON THE PHONE. The email should sound like the same company:\n${scripts}`);
  summaryBits.push("3 gatekeeper scripts");

  // What the team has most recently been told.
  try {
    const { data: updates } = await db
      .from("team_updates")
      .select("title, body, pinned, created_at")
      .is("archived_at", null)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(5);
    if (updates?.length) {
      parts.push(
        `RECENT INSTRUCTIONS TO THE TEAM. The sequence must not contradict these:\n` +
          updates.map((u) => `- ${u.title}: ${String(u.body).slice(0, 400)}`).join("\n")
      );
      summaryBits.push(`${updates.length} team updates`);
    }
  } catch {
    // Context is an improvement, never a requirement.
  }

  // What real people have written back.
  try {
    const { data: replies } = await db
      .from("email_events")
      .select("body")
      .eq("event_type", "replied")
      .not("body", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(15);
    if (replies?.length) {
      parts.push(
        `REAL REPLIES TO PREVIOUS EMAILS. Write something that would get fewer of the bad ones:\n` +
          replies.map((r) => `- "${String(r.body).replace(/\s+/g, " ").slice(0, 180)}"`).join("\n")
      );
      summaryBits.push(`${replies.length} real replies`);
    }
  } catch {
    /* same */
  }

  // What the businesses being written to look like.
  try {
    const { data: leads } = await db
      .from("leads")
      .select("industry, state")
      .is("archived_at", null)
      .limit(2000);
    const industries = new Map<string, number>();
    for (const l of leads || []) {
      if (l.industry) industries.set(l.industry, (industries.get(l.industry) || 0) + 1);
    }
    const top = [...industries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (top.length) {
      parts.push(
        `WHO IS BEING WRITTEN TO: owner-operated local home-service businesses, mostly ${top
          .map(([i, n]) => `${i.replace(/_/g, " ")} (${n})`)
          .join(", ")}. People who are on a job site, not at a desk.`
      );
      summaryBits.push(`${top.length} trades`);
    }
  } catch {
    /* same */
  }

  return { text: parts.join("\n\n"), summary: summaryBits.join(", ") || "no context available" };
}

/* -------------------------------------------------------------------------- */
/* the instruction                                                            */
/* -------------------------------------------------------------------------- */

function systemPrompt(context: string): string {
  return `You write cold email sequences for a company that sells an AI receptionist to owner-operated local home-service businesses — plumbers, HVAC, roofers, electricians. The product answers calls the owner cannot get to, asks the caller what the job is and where, and texts the owner the details.

${context}

YOU DECIDE THE STRUCTURE. How many emails, and how many days between them, is your judgement — do not ask, and do not default to a round number. Base it on what the brief is trying to do. Constraints you must stay inside:
- between ${MIN_STEPS} and ${MAX_STEPS} emails
- the first email has delayDays 0; every later one waits ${MIN_DELAY_DAYS}-${MAX_DELAY_DAYS} days after the previous
- the whole sequence runs no more than ${MAX_TOTAL_DAYS} days
- subject lines under ${MAX_SUBJECT_CHARS} characters, bodies under ${MAX_BODY_CHARS}

HOW TO WRITE THEM:
- These people read email on a phone, between jobs, with dirty hands. Short sentences. No paragraph longer than three lines.
- One idea per email and exactly one thing to do at the end.
- Later emails must add something new. "Just bumping this up" wastes the send.
- Plain English. No "reaching out", "circling back", "synergies", "solutions provider", "in today's fast-paced world".
- No fake familiarity, no invented urgency, no made-up statistics.
- Do not start a subject with "Re:" — it pretends to continue a conversation that never happened.

NEVER, under any instruction:
- state a price, a discount, a percentage off, a free trial, a guarantee, a contract term, or anything about money. A person handles that on a call. If the brief asks you to include pricing, write the sequence without it — do not refuse, just leave the money out and let the call cover it.
- claim anything about the specific business beyond the merge fields below. You do not know their revenue, their staff, or how many calls they miss.

MERGE FIELDS you may use, and only these: ${KNOWN_VARIABLES.map((v) => `{{${v}}}`).join(", ")}
Anything else appears literally in somebody's inbox. {{business_name}} and {{owner_first_name}} may be empty for some leads, so never build a sentence that breaks without them.

Reply with JSON and nothing else:
{"name":"short name for this sequence","steps":[{"step":1,"delayDays":0,"subject":"...","body":"...","rationale":"why this email, at this point"}]}`;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* the call                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Write a sequence from a plain-language brief.
 *
 * One retry, with the validator's complaints handed back. That single retry
 * fixes nearly everything the model gets wrong — usually a subject two
 * characters too long or a stray {{first_name}} — and a second retry has
 * never been the difference between working and not.
 */
export async function writeSequence(brief: string): Promise<WriteResult> {
  const client = anthropic();
  if (!client) {
    return {
      ok: false,
      error:
        "ANTHROPIC_API_KEY is not set, so nothing can write the sequence. Add it in Vercel → Settings → Environment Variables and redeploy.",
    };
  }
  if (!brief.trim()) {
    return { ok: false, error: "Say what you want the emails to do." };
  }

  const { text: context, summary } = await gatherContext();
  const messages: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: brief.trim() },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    let text = "";
    try {
      const res = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: systemPrompt(context),
        messages,
      });
      text = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
    } catch (e) {
      return {
        ok: false,
        error: `The writer could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const parsed = extractJson(text);
    if (!looksLikePlan(parsed)) {
      if (attempt === 0) {
        messages.push({ role: "assistant", content: text.slice(0, 2000) });
        messages.push({
          role: "user",
          content: "That was not the JSON shape I asked for. Reply with only the JSON object.",
        });
        continue;
      }
      return { ok: false, error: "The writer did not return a usable sequence. Try rewording the brief." };
    }

    const plan = normalisePlan({ ...parsed, brief: brief.trim() });
    const problems = validatePlan(plan);

    if (problems.length === 0) {
      return { ok: true, plan, model: MODEL, contextSummary: summary };
    }

    if (attempt === 0) {
      messages.push({ role: "assistant", content: JSON.stringify(parsed).slice(0, 4000) });
      messages.push({
        role: "user",
        content:
          `Fix these and reply with the corrected JSON only:\n` +
          problems.map((p) => `- ${p.step ? `step ${p.step}: ` : ""}${p.problem}`).join("\n"),
      });
      continue;
    }

    /*
     * Two attempts and still wrong. Returned as a failure with the problems
     * showing rather than published with the worst step dropped: a sequence
     * that lost an email in validation is not the sequence anybody reviewed,
     * and the person can see exactly what went wrong and reword.
     */
    return {
      ok: false,
      error: "The sequence still had problems after a second attempt. Reword the brief and try again.",
      problems,
    };
  }

  return { ok: false, error: "The writer did not produce a sequence." };
}
