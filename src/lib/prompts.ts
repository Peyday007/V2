// Editable AI prompts.
//
// Every prompt the app sends to a model is defined here with its default
// wording and the variables it can use. An override stored in the database
// replaces the wording; the variables and the code around it stay the same.
//
// Two rules make this safe to hand to a non-programmer:
//
//   1. A prompt that fails to render falls back to its default rather than
//      sending something broken to the model.
//   2. Variables are checked before saving, so a typo is caught in the editor
//      rather than producing a prompt with "{{busines_name}}" in it.

export type PromptVariable = {
  name: string;
  description: string;
  /** Dropping this from the prompt makes it useless, so the editor warns. */
  important?: boolean;
};

export type PromptDef = {
  key: string;
  label: string;
  /** Where this prompt is used, in plain terms. */
  usedFor: string;
  /** What a change here will and will not affect. */
  affects: string;
  variables: PromptVariable[];
  default: string;
};

export const PROMPTS: PromptDef[] = [
  {
    key: "call_tip",
    label: "Call tip in the dialer",
    usedFor:
      "The short coaching note a caller sees above the script, written fresh for each lead.",
    affects:
      "Runs once per lead served, so changes show up on the next lead a caller opens.",
    variables: [
      { name: "business_name", description: "The company being called", important: true },
      { name: "industry", description: "Trade, or 'unknown'" },
      { name: "city", description: "City, or 'unknown'" },
      { name: "state", description: "Two-letter state" },
      { name: "rating", description: "Google rating, or 'unknown'" },
      { name: "review_count", description: "Number of Google reviews" },
      { name: "website", description: "Their website, or 'none found'" },
      { name: "contacts", description: "Known contacts by name and title, or 'none'" },
      { name: "approach", description: "The recommended way in, from enrichment" },
      { name: "notes", description: "Anything on the lead record" },
    ],
    default: `You are coaching a cold caller selling an AI Receptionist service to local service businesses. Based only on this lead's real data, give a 2-3 sentence practical tip for this specific call. No fluff, no invented facts.

Business: {{business_name}}
Industry: {{industry}}
City: {{city}}, {{state}}
Google rating: {{rating}} ({{review_count}} reviews)
Website: {{website}}
Known contacts: {{contacts}}
Recommended approach: {{approach}}
Notes: {{notes}}`,
  },
  {
    key: "relationship_read",
    label: "Client relationship read",
    usedFor:
      "The written analysis on a lead's full record — where it stands, whether the pitch fits, and what to do next.",
    affects:
      "Runs when you open a lead's page. Costs one API call each time, so it is not used in the dialer.",
    variables: [
      {
        name: "business_name",
        // Not marked important: the record already opens with "Business: X",
        // so the default does not need it separately.
        description: "The company, if you want to name it outside the record",
      },
      {
        name: "record",
        description:
          "Everything logged about them, assembled automatically: who was spoken to, what they said, what was pitched, objections, promises, what is booked, and what is unknown.",
        important: true,
      },
    ],
    default: `You are the account strategist for a small team selling an AI Receptionist service to owner-operated local home-service businesses. The product answers inbound calls: it picks up when nobody can, takes messages, books jobs, and covers after-hours and overflow.

Below is the COMPLETE record for one business. It is everything the team has logged.

RULES:
- Use only what is in the record. Never invent a conversation, a name, a price, a date, or a product that is not listed.
- If something is not in the record, say we do not know it — do not assume.
- Do not restate the record back at me. Interpret it.
- Be concrete and short. This is read between calls.

Answer in exactly these four sections, using these headings:

WHERE THIS STANDS
One short paragraph. Be honest if it is going nowhere.

FIT
What we have pitched, against what they have actually told us their problem is. If the pitch is aimed at the wrong thing, say what to lead with instead and why, based on their stated situation. If we have not learned enough to judge fit, say that instead of guessing.

NEXT MOVES
A numbered list, at most four. Each one an action a caller can take, with a timeframe (e.g. "this week", "within 3 days"). Include what to ASK to close the gaps listed.

WHAT WOULD KILL THIS
One or two lines: the most likely reason this dies, and what avoids it.

THE RECORD:

{{record}}`,
  },
  {
    key: "attack_today",
    label: "What to attack today",
    usedFor: "The prioritised list on the Packets tab, from your live numbers.",
    affects: "Runs when you press Ask Claude.",
    variables: [
      {
        name: "snapshot",
        description:
          "Live system state as JSON: campaigns, lead counts by stage, callers, packets, and recent call outcomes.",
        important: true,
      },
    ],
    default: `You are the sales operations brain for a small cold-calling team selling AI Receptionist services to owner-operated local home-service businesses.

IMPORTANT — what this system already does, so do not recommend doing it by hand:
- Lead generation is AUTOMATED. The admin presses Generate leads and the engine queries Google Places in the background, saving, normalizing and deduplicating businesses. NEVER tell the user to manually pull lists from Google Maps, Angi, Apollo, or a list vendor, or to upload a CSV.
- A campaign targets CALLABLE leads, not businesses found: the engine keeps searching, and re-opens a finished batch, until it has the number asked for. Never tell the user to over-order.
- Decision-maker enrichment runs automatically. enrichment_failed usually means a deliberate rejection (no callable phone, too big to be owner-operated, closed down), not a system fault.
- Only leads at ready_for_calling can be pulled into caller packets.
- The dialer logs 10 outcomes plus call duration, attempt number, objections raised, and whether the owner was known before dialing. Do not recommend adding dispositions or tracking.
- Packets are generated per caller on the Packets tab, where they can be reassigned, topped up, taken back or deleted.
- Do-not-call is enforced on the phone number across every duplicate record. Do not recommend building suppression.
- Appointment attendance is recorded by hand on the Appointments tab; if appointments exist but none are marked held or no-show, that IS worth flagging.

Based ONLY on the real snapshot below, tell the admin what to attack today. Be direct and specific — a short prioritized list, max 5 items, each an action they can take inside THIS system. If the data is thin, say exactly which step of the pipeline is the bottleneck and what unblocks it. Do not invent numbers.

{{snapshot}}`,
  },
];

export const PROMPT_MAP: Record<string, PromptDef> = Object.fromEntries(
  PROMPTS.map((p) => [p.key, p])
);

/** Every {{variable}} referenced in a template, in order of appearance. */
export function variablesUsed(template: string): string[] {
  const found: string[] = [];
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

export type TemplateProblem = {
  level: "error" | "warning";
  message: string;
};

/**
 * Check a template before it is saved. Errors block saving; warnings do not,
 * because deliberately dropping a variable is a legitimate edit.
 */
export function validateTemplate(def: PromptDef, template: string): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  const trimmed = template.trim();

  if (trimmed.length === 0) {
    problems.push({ level: "error", message: "The prompt is empty." });
    return problems;
  }
  if (trimmed.length < 20) {
    problems.push({
      level: "error",
      message: "That is too short to be a working prompt.",
    });
  }

  const known = new Set(def.variables.map((v) => v.name));
  for (const used of variablesUsed(template)) {
    if (!known.has(used)) {
      problems.push({
        level: "error",
        message: `{{${used}}} is not a variable this prompt has. It would be sent to the model literally.`,
      });
    }
  }

  // A lone brace pair is almost always a typo for a variable.
  if (/\{[^{]|[^}]\}/.test(template.replace(/\{\{[^}]*\}\}/g, ""))) {
    problems.push({
      level: "warning",
      message: "There is a single { or } in the text. Variables need double braces, like {{business_name}}.",
    });
  }

  const used = new Set(variablesUsed(template));
  for (const v of def.variables) {
    if (v.important && !used.has(v.name)) {
      problems.push({
        level: "warning",
        message: `{{${v.name}}} is missing. Without it the model has no ${v.description.toLowerCase()} to work from.`,
      });
    }
  }

  return problems;
}

/** Substitute {{variables}}. Anything not supplied becomes an empty string. */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    return v === null || v === undefined ? "" : String(v);
  });
}

/**
 * The wording to actually send: the stored override when it is usable,
 * otherwise the shipped default. Never throws — a broken override must not
 * take a feature offline.
 */
export function resolvePrompt(
  key: string,
  override: string | null | undefined,
  vars: Record<string, string | number | null | undefined>
): { text: string; usedDefault: boolean; reason?: string } {
  const def = PROMPT_MAP[key];
  if (!def) {
    return { text: "", usedDefault: true, reason: `Unknown prompt "${key}"` };
  }

  if (override && override.trim().length > 0) {
    const problems = validateTemplate(def, override).filter((p) => p.level === "error");
    if (problems.length === 0) {
      return { text: renderTemplate(override, vars), usedDefault: false };
    }
    return {
      text: renderTemplate(def.default, vars),
      usedDefault: true,
      reason: `The saved prompt has a problem, so the default was used: ${problems[0].message}`,
    };
  }

  return { text: renderTemplate(def.default, vars), usedDefault: true };
}

/** Preview text for the editor, with obvious stand-in values. */
export function sampleValues(def: PromptDef): Record<string, string> {
  const samples: Record<string, string> = {
    business_name: "Ace Roofing & Gutters",
    industry: "roofing",
    city: "Troy",
    state: "MI",
    rating: "4.7",
    review_count: "84",
    website: "https://aceroofingtroy.example",
    contacts: "Mike Reynolds (Owner)",
    approach: "Ask for Mike Reynolds, the owner",
    notes: "Called twice, gatekeeper is Dana",
    record:
      "Where it stands: Spoken with the decision maker across 3 attempts, no meeting yet.\n\nProblems they have stated:\n- Missed calls",
    snapshot: '{ "leads_by_machine_status": { "ready_for_calling": 42 } }',
  };
  const out: Record<string, string> = {};
  for (const v of def.variables) out[v.name] = samples[v.name] ?? `(${v.name})`;
  return out;
}
