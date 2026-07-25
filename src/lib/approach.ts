// Deterministic recommended calling approach (A/B/C/D). Short and
// operational — grounded only in data we actually have.

type ContactLite = {
  full_name: string | null;
  title: string | null;
  role_category: string;
  direct_phone: string | null;
  extension: string | null;
  active: boolean;
};

type DiscoveryLite = {
  owner_name: string | null;
  best_callback_time: string | null;
  transfer_instructions: string | null;
  direct_number: string | null;
  extension: string | null;
  gatekeeper_name: string | null;
};

type LeadLite = {
  review_count: number | null;
};

export function recommendApproach(
  lead: LeadLite,
  contacts: ContactLite[],
  latestDiscovery: DiscoveryLite | null
): { route: "A" | "B" | "C" | "D"; text: string } {
  // D: a previous call taught us something — use it.
  if (
    latestDiscovery &&
    (latestDiscovery.owner_name ||
      latestDiscovery.best_callback_time ||
      latestDiscovery.transfer_instructions ||
      latestDiscovery.direct_number)
  ) {
    const d = latestDiscovery;
    const parts: string[] = [];
    if (d.owner_name) parts.push(`A previous call identified ${d.owner_name}.`);
    if (d.direct_number)
      parts.push(`Direct number: ${d.direct_number}${d.extension ? ` ext ${d.extension}` : ""}.`);
    else if (d.extension) parts.push(`Ask for extension ${d.extension}.`);
    if (d.best_callback_time) parts.push(`Best time: ${d.best_callback_time}.`);
    if (d.transfer_instructions) parts.push(d.transfer_instructions);
    if (d.gatekeeper_name) parts.push(`Gatekeeper is ${d.gatekeeper_name}.`);
    return { route: "D", text: parts.join(" ") };
  }

  // A: we have a named decision-maker.
  const named = contacts.find(
    (c) => c.active && c.full_name && c.role_category !== "gatekeeper" && c.role_category !== "employee"
  );
  if (named) {
    const title = named.title ? `, the ${named.title.toLowerCase()}` : "";
    const line = named.direct_phone
      ? `Call their direct number and ask for ${named.full_name}${title}.`
      : `Call the main line and ask for ${named.full_name}${title}.`;
    const ext = named.extension ? ` Extension ${named.extension}.` : "";
    return { route: "A", text: line + ext };
  }

  // C: small business — go straight for the owner.
  const reviews = lead.review_count ?? 0;
  if (reviews < 100) {
    return {
      route: "C",
      text: "Ask whether the owner is available. If not, get the owner's name and the best callback time.",
    };
  }

  // B: bigger operation — role-based ask.
  return {
    route: "B",
    text: "Ask for whoever manages phone systems, scheduling, or customer intake.",
  };
}
