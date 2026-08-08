// What a sequence is allowed to be.
//
// The brief was "don't make me hold its hand — it can figure out how many
// emails it should send and the space in between". So it does: the step count
// and the spacing are the writer's decision, not a setting anybody fills in.
//
// This file is the fence around that decision. A language model asked to write
// a cold-email sequence will occasionally produce eleven emails a day apart,
// or two emails four months apart, and both of those are worse than anything a
// person would have chosen. The bounds below are not the model second-guessed
// — they are the range inside which its judgement is worth having.
//
// Everything here is pure, so the rules are testable without a model call.
//
// The rule that outranks the rest: NO GENERATED COPY EVER CONTAINS A PRICE.
// Prices, discounts and legal language are never produced automatically. A
// sequence that names a figure is rejected outright rather than trimmed,
// because a sequence with its pricing sentence quietly removed reads like it
// is missing a sentence — which it is.

export type SequenceStep = {
  /** 1-based. Step 1 is the first email. */
  step: number;
  /**
   * Days to wait after the PREVIOUS step. Always 0 for step 1, which is sent
   * when the lead enters the campaign.
   */
  delayDays: number;
  subject: string;
  body: string;
  /** Why this email exists at this point. Shown to a human, never sent. */
  rationale: string;
};

export type SequencePlan = {
  name: string;
  brief: string;
  steps: SequenceStep[];
};

/* -------------------------------------------------------------------------- */
/* the bounds                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Two is the minimum that is worth calling a sequence — a single email with no
 * follow-up throws away most of the replies, and the second email is
 * consistently the one that gets answered.
 */
export const MIN_STEPS = 2;

/**
 * Six is where a cold sequence stops being persistence and starts being the
 * reason somebody presses "report spam". The ceiling matters more than the
 * floor: nobody complains about four emails.
 */
export const MAX_STEPS = 6;

/** A day is the shortest decent gap. Two emails the same morning is a bug. */
export const MIN_DELAY_DAYS = 1;

/** Beyond a fortnight the first email is forgotten and it reads as cold again. */
export const MAX_DELAY_DAYS = 14;

/** Long enough to be patient, short enough to still be one conversation. */
export const MAX_TOTAL_DAYS = 45;

export const MAX_SUBJECT_CHARS = 78;
export const MAX_BODY_CHARS = 1400;

/* -------------------------------------------------------------------------- */
/* money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Anything that reads as a price, a discount or a commitment.
 *
 * Deliberately broader than the reply-draft check in emailDraft.ts. That one
 * decides whether a human should see a message; this one rejects copy that
 * would go to every prospect in the campaign, unread, for months. The cost of
 * being too strict is one regeneration.
 */
const MONEY_IN_COPY = [
  /[$£€]\s?\d/,
  /*
   * Any percentage at all, not just "% off".
   *
   * It catches discounts, and it also catches the other thing this must never
   * produce: an invented statistic. "60% of callers never leave a message" is
   * the kind of sentence a writer generates confidently and nobody can source,
   * and it goes to every prospect in the campaign for a month.
   */
  // The word boundary goes INSIDE the alternation: "%" is not a word
  // character, so a \b after the group never matches "20% off" at all.
  /\b\d+\s*(?:%|percent\b)/i,
  /\b\d[\d,]*\s*(?:dollars|usd|pounds|euros)\b/i,
  /\b(?:per|a)\s+month\s+for\b/i,
  /\bonly\s+\d/i,
  /\bfree\s+(?:month|trial|week)\b/i,
  /\bdiscount\b/i,
  /\bmoney[- ]back\b/i,
  /\bno[- ]obligation\b/i,
  /\bguarantee[ds]?\b/i,
  /\bcontract\b/i,
  /\bcancel any ?time\b/i,
];

export function containsMoneyOrTerms(text: string): string | null {
  for (const p of MONEY_IN_COPY) {
    const m = p.exec(text || "");
    if (m) return m[0];
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* merge fields                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The variables the push actually sends, from emailCompose.composeVariables.
 *
 * A sequence referencing a variable nobody sends renders as a literal
 * `{{owner_last_name}}` in a prospect's inbox, which is the single most
 * obvious way to announce that an email is automated. So an unknown variable
 * is an error, not a warning.
 */
export const KNOWN_VARIABLES = [
  "owner_first_name",
  "business_name",
  "city",
  "state",
  "review_count",
  "rating",
  "gap_headline",
  "gap_detail",
  "gap_list",
  "gap_count",
  "recommendation_list",
  "top_recommendation",
  "workshop_link",
  "has_website",
  "spoke_to_owner",
  // Instantly's own, always available.
  "personalization",
  "firstName",
  "lastName",
  "companyName",
  "sendingAccountFirstName",
  "unsubscribeLink",
];

export function variablesUsed(text: string): string[] {
  const found = new Set<string>();
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) found.add(m[1]);
  return [...found];
}

export function unknownVariables(text: string): string[] {
  return variablesUsed(text).filter((v) => !KNOWN_VARIABLES.includes(v));
}

/* -------------------------------------------------------------------------- */
/* validating                                                                 */
/* -------------------------------------------------------------------------- */

export type PlanProblem = { step: number | null; problem: string };

/**
 * Everything wrong with a plan, rather than the first thing wrong with it.
 *
 * Returning all of them at once matters here: the fix is a regeneration with
 * the problems fed back to the writer, and one-at-a-time would mean six round
 * trips to fix six things.
 */
export function validatePlan(plan: SequencePlan): PlanProblem[] {
  const problems: PlanProblem[] = [];

  if (!plan.name?.trim()) problems.push({ step: null, problem: "The sequence has no name." });

  const steps = plan.steps || [];
  if (steps.length < MIN_STEPS) {
    problems.push({
      step: null,
      problem: `A sequence needs at least ${MIN_STEPS} emails — one email with no follow-up throws away most of the replies.`,
    });
  }
  if (steps.length > MAX_STEPS) {
    problems.push({
      step: null,
      problem: `${steps.length} emails is too many. Past ${MAX_STEPS} it stops being persistence and starts getting reported as spam.`,
    });
  }

  let total = 0;
  steps.forEach((s, i) => {
    const n = i + 1;

    if (s.step !== n) {
      problems.push({ step: n, problem: `Step numbers must run 1..n; found ${s.step} at position ${n}.` });
    }

    if (i === 0) {
      if (s.delayDays !== 0) {
        problems.push({ step: n, problem: "The first email goes out when the lead enters the campaign, so its delay must be 0." });
      }
    } else {
      if (!Number.isInteger(s.delayDays) || s.delayDays < MIN_DELAY_DAYS) {
        problems.push({ step: n, problem: `Wait at least ${MIN_DELAY_DAYS} day after the previous email.` });
      }
      if (s.delayDays > MAX_DELAY_DAYS) {
        problems.push({ step: n, problem: `Waiting ${s.delayDays} days means the first email has been forgotten. Keep it under ${MAX_DELAY_DAYS}.` });
      }
      total += s.delayDays;
    }

    const subject = (s.subject || "").trim();
    if (!subject) problems.push({ step: n, problem: "No subject line." });
    if (subject.length > MAX_SUBJECT_CHARS) {
      problems.push({ step: n, problem: `The subject is ${subject.length} characters; it will be cut off on a phone. Keep it under ${MAX_SUBJECT_CHARS}.` });
    }
    if (/^(re|fwd):/i.test(subject)) {
      // Faking a reply to a conversation that never happened is the oldest
      // trick in cold email and it is a lie told to somebody's inbox.
      problems.push({ step: n, problem: 'A subject starting "Re:" pretends to continue a conversation that never happened.' });
    }

    const body = (s.body || "").trim();
    if (!body) problems.push({ step: n, problem: "No body." });
    if (body.length > MAX_BODY_CHARS) {
      problems.push({ step: n, problem: `The body is ${body.length} characters. A cold email that scrolls does not get read.` });
    }

    const money = containsMoneyOrTerms(`${subject}\n${body}`);
    if (money) {
      problems.push({
        step: n,
        problem: `Contains "${money}". Prices, discounts and terms are never written automatically — leave them for a person on a call.`,
      });
    }

    for (const bad of unknownVariables(`${subject}\n${body}`)) {
      problems.push({
        step: n,
        problem: `{{${bad}}} is not a field we send, so it would appear literally in the email.`,
      });
    }
  });

  /*
   * At least one email has to carry the link.
   *
   * Every pushed lead now gets a packet — their own gaps, their own
   * recommendations, the same page a caller would have texted them — and the
   * URL is handed to the sequence as {{workshop_link}}. A sequence that never
   * references it sends the prospect nothing to look at, and the whole
   * diagnostic pipeline behind it produces a variable that goes nowhere.
   *
   * A problem rather than a silent warning, because the writer retries on
   * problems and this is exactly the kind of thing a retry fixes.
   */
  if (steps.length > 0 && !steps.some((s) => variablesUsed(`${s.subject}\n${s.body}`).includes("workshop_link"))) {
    problems.push({
      step: null,
      problem:
        "No email links to the prospect's page. Put {{workshop_link}} in at least one of them — it is the thing they click to see what you found.",
    });
  }

  /*
   * The first email has to carry the findings, not just a link to them.
   *
   * We do the work of diagnosing a business and then the copy said "here is
   * what we found: <link>" — so the substance was visible only to somebody
   * curious enough to click, which is the person who needed convincing
   * least. The findings are the reason the email is worth reading. They go
   * in it.
   *
   * Checked on the FIRST email specifically: that is the one nearly everybody
   * reads and most people only read.
   */
  const first = steps.find((s) => s.step === 1) ?? steps[0];
  if (first) {
    const carries = variablesUsed(`${first.subject}\n${first.body}`);
    const hasFindings = ["gap_list", "gap_headline", "gap_detail"].some((v) => carries.includes(v));
    if (!hasFindings) {
      problems.push({
        step: 1,
        problem:
          "The first email does not say what we found. Put {{gap_list}} in it, or " +
          "{{gap_headline}} with {{gap_detail}} — an owner who has to click a link to " +
          "learn anything will not click.",
      });
    }
  }

  if (total > MAX_TOTAL_DAYS) {
    problems.push({
      step: null,
      problem: `The sequence runs ${total} days. Past ${MAX_TOTAL_DAYS} it is no longer one conversation.`,
    });
  }

  return problems;
}

/**
 * Trim what can be trimmed safely, so a near-miss does not need a whole
 * regeneration.
 *
 * Only ever removes or clamps — never writes a sentence. Money is deliberately
 * NOT handled here: silently deleting a pricing sentence leaves a paragraph
 * with a hole in it, and the writer should be told to try again instead.
 */
export function normalisePlan(plan: SequencePlan): SequencePlan {
  const steps = (plan.steps || []).slice(0, MAX_STEPS).map((s, i) => ({
    step: i + 1,
    delayDays:
      i === 0
        ? 0
        : Math.min(MAX_DELAY_DAYS, Math.max(MIN_DELAY_DAYS, Math.round(Number(s.delayDays) || MIN_DELAY_DAYS))),
    subject: (s.subject || "").trim().replace(/\s+/g, " "),
    body: (s.body || "").trim(),
    rationale: (s.rationale || "").trim(),
  }));
  return { name: (plan.name || "").trim(), brief: (plan.brief || "").trim(), steps };
}

/** How the cadence reads to a person, for the page. */
export function describeCadence(steps: SequenceStep[]): string {
  if (steps.length === 0) return "No emails.";
  const days: number[] = [];
  let running = 0;
  for (const s of steps) {
    running += s.step === 1 ? 0 : s.delayDays;
    days.push(running);
  }
  const total = days[days.length - 1];
  return `${steps.length} emails over ${total} day${total === 1 ? "" : "s"} — sent on day ${days.join(", then ")}.`;
}

/** Shape check on whatever the model returned, before anything trusts it. */
export function looksLikePlan(value: unknown): value is SequencePlan {
  const v = value as SequencePlan;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.name === "string" &&
    Array.isArray(v.steps) &&
    v.steps.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.subject === "string" &&
        typeof s.body === "string"
    )
  );
}
