// Deterministic normalization for import matching. Raw values are always
// preserved on the lead; these only feed the normalized_* columns.

const STATE_MAP: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

const LEGAL_SUFFIXES = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "ltd", "limited",
  "co", "company", "llp", "pllc", "pc", "pa",
]);

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let value = raw.trim().toLowerCase();
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    value = "https://" + value;
  }
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

export function normalizeBusinessName(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let name = raw.toLowerCase();
  name = name.replace(/[^\w\s&]/g, " ").replace(/\s+/g, " ").trim();
  const words = name.split(" ");
  while (words.length && LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words.pop();
  }
  const result = words.join(" ").trim();
  return result || null;
}

export function normalizeState(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const value = raw.trim();
  const upper = value.toUpperCase();
  if (value.length === 2 && Object.values(STATE_MAP).includes(upper)) return upper;
  return STATE_MAP[value.toLowerCase()] || null;
}

export function normalizeZip(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
}
