// Client relationship.
//
// A lead card carries a name and a number. What a person actually needs before
// picking up the phone again is the relationship: who we have spoken to, what
// they told us, what we pitched, what we promised, and what is booked.
//
// All of that is already in the database, scattered across calls, their
// structured details, callbacks, appointments and the lead's own intelligence
// fields. This module assembles it into one dossier.
//
// Deliberately deterministic. The AI read that sits on top of it is optional
// and is fed ONLY from here, so it cannot invent a conversation that never
// happened — and when there is no API key the section still works.

export type CallRow = {
  id?: string;
  outcome: string;
  reached_dm?: boolean | null;
  notes?: string | null;
  details?: Record<string, string> | null;
  next_step?: string | null;
  spoke_with_role?: string | null;
  duration_seconds?: number | null;
  attempt_number?: number | null;
  created_at: string;
  callers?: { name: string } | { name: string }[] | null;
};

export type LeadRow = Record<string, unknown> & {
  business_name?: string | null;
  industry?: string | null;
  city?: string | null;
  state?: string | null;
  owner_name?: string | null;
  owner_title?: string | null;
  gatekeeper_name?: string | null;
  answering_setup?: string | null;
  existing_provider?: string | null;
  office_staff_count?: string | null;
  after_hours_process?: string | null;
  best_call_day?: string | null;
  best_call_time?: string | null;
  last_next_step?: string | null;
  last_objection?: string | null;
  attempt_count?: number | null;
  pipeline_stage?: string | null;
};

export type AppointmentRow = {
  scheduled_for: string;
  attendance_status?: string | null;
  product?: string | null;
  pain_point?: string | null;
  meeting_reason?: string | null;
  decision_maker_name?: string | null;
};

export type CallbackRow = {
  scheduled_for: string;
  status?: string | null;
  reason?: string | null;
  requested_by_name?: string | null;
};

export type DossierInput = {
  lead: LeadRow;
  calls: CallRow[];
  appointments: AppointmentRow[];
  callbacks: CallbackRow[];
  objections: { objection_label?: string | null; objection_key: string }[];
};

export type Dossier = {
  /** One line: where this stands. */
  status: string;
  /** Who we have actually spoken to. */
  people: string[];
  /** What they told us about how they run calls today. */
  theirSituation: string[];
  /** Problems they stated, in their own outcome fields. */
  statedProblems: string[];
  /** What we have pitched or discussed. */
  pitched: string[];
  /** Objections and pushback heard. */
  resistance: string[];
  /** Anything we said we would do. */
  promises: string[];
  /** Dates already in the diary. */
  commitments: string[];
  /** Things we should know and do not. Drives the next questions. */
  gaps: string[];
  /** Enough happened to be worth an analysis. */
  hasSubstance: boolean;
};

function one<T>(rel: T | T[] | null | undefined): T | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0] ?? null) : rel;
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

export function buildDossier(input: DossierInput): Dossier {
  const { lead, calls, appointments, callbacks, objections } = input;

  const attempts = lead.attempt_count ?? calls.length;
  const spokeToOwner = calls.some((c) => c.reached_dm === true);
  const booked = appointments.length > 0;

  /* ------------------------------- people ------------------------------- */
  const people: string[] = [];
  if (clean(lead.owner_name)) {
    people.push(
      `${lead.owner_name}${clean(lead.owner_title) ? `, ${lead.owner_title}` : ""} — the decision maker`
    );
  }
  if (clean(lead.gatekeeper_name)) {
    people.push(`${lead.gatekeeper_name} — answers the phone`);
  }
  for (const c of calls) {
    const dm = clean(c.details?.dm_name);
    if (dm && !people.some((p) => p.startsWith(dm))) {
      const role = clean(c.details?.dm_role);
      people.push(`${dm}${role ? `, ${role}` : ""} — spoken to on a call`);
    }
  }

  /* ---------------------------- their situation --------------------------- */
  const theirSituation: string[] = [];
  const setup = clean(lead.answering_setup) || clean(calls.find((c) => clean(c.details?.answering_setup))?.details?.answering_setup);
  if (setup) theirSituation.push(`Calls are handled today by: ${setup}`);
  if (clean(lead.existing_provider)) {
    theirSituation.push(`Already using: ${lead.existing_provider}`);
  }
  if (clean(lead.office_staff_count)) {
    theirSituation.push(`Office staff: ${lead.office_staff_count}`);
  }
  if (clean(lead.after_hours_process)) {
    theirSituation.push(`After hours: ${lead.after_hours_process}`);
  }
  if (clean(lead.best_call_day) || clean(lead.best_call_time)) {
    theirSituation.push(
      `Best time to reach them: ${[lead.best_call_day, lead.best_call_time].filter(Boolean).join(" ")}`
    );
  }

  /* --------------------------- stated problems --------------------------- */
  const statedProblems: string[] = [];
  for (const c of calls) {
    const problem = clean(c.details?.main_problem);
    if (problem && problem !== "No major problem identified" && !statedProblems.includes(problem)) {
      statedProblems.push(problem);
    }
  }
  for (const a of appointments) {
    const pain = clean(a.pain_point);
    if (pain && !statedProblems.includes(pain)) statedProblems.push(pain);
  }

  /* ------------------------------- pitched ------------------------------- */
  const pitched: string[] = [];
  for (const a of appointments) {
    const product = clean(a.product);
    if (product && !pitched.includes(product)) pitched.push(product);
    const reason = clean(a.meeting_reason);
    if (reason && !pitched.includes(reason)) pitched.push(reason);
  }
  for (const c of calls) {
    const product = clean(c.details?.product);
    if (product && !pitched.includes(product)) pitched.push(product);
  }

  /* ------------------------------ resistance ----------------------------- */
  const resistance: string[] = [];
  for (const o of objections) {
    const label = clean(o.objection_label) || o.objection_key;
    if (!resistance.includes(label)) resistance.push(label);
  }
  for (const c of calls) {
    const objection = clean(c.details?.objection);
    if (objection && !resistance.includes(objection)) resistance.push(objection);
    if (c.outcome === "not_interested") {
      const reason = clean(c.details?.reason);
      const who = clean(c.details?.said_by_role) || "someone";
      const line = `Not interested (${who}): ${reason || "no reason given"}`;
      if (!resistance.includes(line)) resistance.push(line);
    }
  }

  /* ------------------------------- promises ------------------------------ */
  const promises: string[] = [];
  const lastStep = clean(lead.last_next_step);
  if (lastStep) promises.push(lastStep);
  for (const c of calls) {
    const step = clean(c.next_step) || clean(c.details?.next_step);
    if (step && !promises.includes(step)) promises.push(step);
  }

  /* ------------------------------ commitments ---------------------------- */
  const commitments: string[] = [];
  for (const a of appointments) {
    const when = new Date(a.scheduled_for);
    const status = clean(a.attendance_status);
    commitments.push(
      `Meeting ${when.toLocaleString(undefined, DATE_OPTS)}` +
        (a.decision_maker_name ? ` with ${a.decision_maker_name}` : "") +
        (status && status !== "scheduled" ? ` — ${status.replace(/_/g, " ")}` : "")
    );
  }
  for (const cb of callbacks) {
    if ((cb.status ?? "pending") !== "pending") continue;
    commitments.push(
      `Callback ${new Date(cb.scheduled_for).toLocaleString(undefined, DATE_OPTS)}` +
        (cb.reason ? ` — ${cb.reason}` : "")
    );
  }

  /* --------------------------------- gaps -------------------------------- */
  const gaps: string[] = [];
  if (!clean(lead.owner_name)) gaps.push("We do not know the owner's name");
  if (!setup) gaps.push("We do not know how they handle calls today");
  if (statedProblems.length === 0) {
    gaps.push("They have not told us a problem worth solving yet");
  }
  if (!clean(lead.best_call_time) && attempts >= 2) {
    gaps.push("No best time to reach them, after several attempts");
  }
  if (spokeToOwner && promises.length === 0 && !booked) {
    gaps.push("We reached the owner but no next step was agreed");
  }

  /* -------------------------------- status ------------------------------- */
  // A booked meeting is the most important fact there is, so it is checked
  // before anything else — including the call count, which can be empty if a
  // call row was ever detached from its lead.
  let status: string;
  if (booked) {
    const a = appointments[0];
    const held = clean(a.attendance_status);
    status =
      held === "held"
        ? "Met with them. This is a live opportunity."
        : held === "no_show"
          ? "Booked a meeting and they did not show."
          : `Meeting booked for ${new Date(a.scheduled_for).toLocaleString(undefined, DATE_OPTS)}.`;
  } else if (calls.length === 0) {
    status = "Never called.";
  } else if (spokeToOwner) {
    status = `Spoken with the decision maker across ${attempts} attempt${attempts === 1 ? "" : "s"}, no meeting yet.`;
  } else if (calls.some((c) => c.outcome === "gatekeeper")) {
    status = `${attempts} attempt${attempts === 1 ? "" : "s"}, only ever reached the gatekeeper.`;
  } else {
    status = `${attempts} attempt${attempts === 1 ? "" : "s"}, nobody has picked up.`;
  }

  return {
    status,
    people,
    theirSituation,
    statedProblems,
    pitched,
    resistance,
    promises,
    commitments,
    gaps,
    // One dial with nobody answering is not a relationship to analyse.
    hasSubstance:
      spokeToOwner ||
      booked ||
      statedProblems.length > 0 ||
      theirSituation.length > 0 ||
      resistance.length > 0,
  };
}

/**
 * The exact facts handed to the model. Nothing else is sent, so it cannot
 * describe a conversation that is not in the record.
 */
export function dossierPrompt(businessName: string, d: Dossier): string {
  const section = (title: string, lines: string[]) =>
    lines.length > 0 ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}` : `${title}: nothing recorded`;

  return [
    `Business: ${businessName}`,
    `Where it stands: ${d.status}`,
    section("People we have spoken to", d.people),
    section("How they run calls today", d.theirSituation),
    section("Problems they have stated", d.statedProblems),
    section("What we have pitched or discussed", d.pitched),
    section("Pushback and objections heard", d.resistance),
    section("What we said we would do", d.promises),
    section("Already in the diary", d.commitments),
    section("What we still do not know", d.gaps),
  ].join("\n\n");
}
