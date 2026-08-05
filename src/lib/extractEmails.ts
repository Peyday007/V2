// Finding an email address on a business's own website.
//
// This exists because of a number on the Email page: 993 of 1000 leads had no
// address, so the cold-email programme had nobody to email. The cause was not
// a bug — nothing in the application had ever looked. Google Places returns a
// phone and a website, never an email, and the only other path was the paid
// contact-provider waterfall, which has no keys configured. So every lead was
// "no email address on record", correctly and permanently.
//
// The crawler already fetches the contact and about pages of every business
// with a website, to find the owner's name. Their email address is usually on
// the same page, in a mailto: link. This reads it.
//
// The rules, which are the whole point:
//
//   ONLY WHAT IS ON THE PAGE. Never constructed. `firstname@domain.com` is a
//   plausible guess and a fabricated contact detail, and the standing rule is
//   that this application does not invent contact data. If the page does not
//   show an address, there is no address.
//
//   ALWAYS ATTRIBUTED. Every address carries the URL it was found on and when.
//   A claim you cannot trace is a claim you cannot defend.
//
//   NEVER SOMEBODY ELSE'S. A trade's website carries the web designer's
//   address in the footer, the reviews widget's, the chat vendor's. Those
//   belong to other companies and emailing them is worse than useless.
//
// Pure string work, so it can be tested against real HTML.

import { stripHtml } from "./extractPeople";

export type EmailKind =
  /** Belongs to a named person: sam@, m.rivera@. The best kind. */
  | "personal"
  /** info@, office@, sales@. Reaches the business; nobody in particular. */
  | "role"
  /** Everything else on the domain. */
  | "generic";

export type EmailCandidate = {
  email: string;
  kind: EmailKind;
  /** 0–1. How confident that this reaches this business. */
  confidence: number;
  /** Where it was found, so the claim can be checked. */
  sourceUrl: string;
  /** The text around it, for the same reason. */
  supportingText: string;
  /** True when the address is on the same domain as the website. */
  onDomain: boolean;
};

/*
 * Addresses that belong to somebody else.
 *
 * Everything here appears on small-business websites constantly and none of it
 * reaches the owner. Emailing a website builder's support address because it
 * was in the footer of a plumber's site is not a near miss — it is contacting
 * a company we never intended to contact.
 */
const FOREIGN_DOMAINS = [
  // Site builders and hosts, which put their own address in the footer.
  "wixpress.com", "wix.com", "squarespace.com", "godaddy.com", "weebly.com",
  "shopify.com", "wordpress.com", "webflow.com", "duda.co", "b12.io",
  // Marketing, review and chat widgets.
  "hubspot.com", "mailchimp.com", "constantcontact.com", "podium.com",
  "birdeye.com", "yext.com", "thryv.com", "housecallpro.com", "jobber.com",
  "servicetitan.com", "angi.com", "homeadvisor.com", "yelp.com", "thumbtack.com",
  // Platforms and analytics.
  "google.com", "googlemail.com", "facebook.com", "instagram.com", "sentry.io",
  "cloudflare.com", "example.com", "domain.com", "email.com", "yourdomain.com",
];

/** Local parts that are never a person and rarely worth emailing. */
const JUNK_LOCAL_PARTS = new Set([
  "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster",
  "abuse", "webmaster", "hostmaster", "mailer-daemon", "bounce", "bounces",
  "unsubscribe", "privacy", "legal", "dpo", "security", "spam",
  "test", "example", "user", "name", "youremail", "your-email", "email",
]);

/** Local parts that reach the business but not a named person. */
const ROLE_LOCAL_PARTS = new Set([
  "info", "contact", "hello", "hi", "office", "admin", "sales", "service",
  "support", "enquiries", "inquiries", "bookings", "booking", "schedule",
  "scheduling", "dispatch", "team", "help", "customerservice", "accounts",
  "accounting", "billing", "estimates", "quotes", "jobs", "careers", "hr",
  "mail", "general", "reception", "frontdesk", "main",
]);

/**
 * A deliberately conservative pattern.
 *
 * No attempt to implement the RFC. What matters is not matching things that
 * are not addresses — image filenames like `logo@2x.png`, version strings like
 * `react@18.2.0`, and CSS `@media` are all common on these pages and all match
 * a naive pattern.
 */
const EMAIL_RE = /\b[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}\.[A-Za-z]{2,24}\b/g;

/** Extensions that mean this was a filename, not an address. */
const FILE_ENDINGS = /\.(png|jpe?g|gif|svg|webp|css|js|mjs|json|woff2?|ico|pdf|mp4|avif)$/i;

/** Obfuscations a person reads as an address and a regex does not. */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s+at\s+(?=[A-Za-z0-9-]+\s*(?:\.|\(dot\)|\[dot\])\s*[A-Za-z]{2,})/gi, "@")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s+dot\s+(?=[A-Za-z]{2,24}\b)/gi, ".");
}

/** The registrable-ish domain, for comparing an address to a website. */
export function rootDomain(host: string): string {
  const clean = (host || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
  const parts = clean.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  // Handles co.uk, com.au and friends without a public-suffix list: a
  // two-letter TLD preceded by a short second level is almost always one.
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (last.length === 2 && secondLast.length <= 3) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

export function classifyLocalPart(local: string): EmailKind {
  const bare = local.toLowerCase().replace(/[._-]/g, "");
  if (ROLE_LOCAL_PARTS.has(bare) || ROLE_LOCAL_PARTS.has(local.toLowerCase())) return "role";
  // sam, sam.rivera, s.rivera, samrivera — a person's address is letters, and
  // usually short. Digits are almost always a role account or a bot.
  if (/^[a-z]+([._-][a-z]+)?$/i.test(local) && local.length <= 24) return "personal";
  return "generic";
}

/**
 * Does this address plausibly belong to the person we already identified?
 *
 * A page that says "Maria Rivera, Owner" and carries `maria@acehvac.com` is
 * the strongest signal available short of paying a provider. Matched on the
 * local part only, and only against a name we already hold — this RANKS an
 * address that is already on the page. It never builds one.
 */
export function matchesOwnerName(local: string, ownerName: string | null | undefined): boolean {
  const name = (ownerName || "").trim().toLowerCase();
  if (!name) return false;
  const parts = name.split(/\s+/).filter((p) => p.length >= 2);
  if (parts.length === 0) return false;
  const bare = local.toLowerCase().replace(/[._-]/g, "");
  const first = parts[0];
  const last = parts[parts.length - 1];

  if (bare === first) return true;
  if (bare === last) return true;
  if (bare === `${first}${last}`) return true;
  if (bare === `${first[0]}${last}`) return true;
  if (bare === `${first}${last[0]}`) return true;
  return false;
}

function isForeign(domain: string): boolean {
  const root = rootDomain(domain);
  return FOREIGN_DOMAINS.some((d) => root === d || root.endsWith(`.${d}`));
}

/** Public, so a test can assert the junk filter directly. */
export function isPlausibleEmail(email: string): boolean {
  if (FILE_ENDINGS.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return false;
  if (!domain.includes(".")) return false;
  // "react@18.2.0" and friends: a domain whose last label is digits is a
  // version number, not a host.
  if (/^\d+$/.test(domain.split(".").pop() || "")) return false;
  if (/^\d+(\.\d+)+$/.test(domain)) return false;
  if (JUNK_LOCAL_PARTS.has(local.toLowerCase().replace(/[._-]/g, ""))) return false;
  if (isForeign(domain)) return false;
  return true;
}

/** A short window of text around a match, for the evidence trail. */
function contextAround(haystack: string, needle: string): string {
  const at = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return "";
  const from = Math.max(0, at - 60);
  const to = Math.min(haystack.length, at + needle.length + 60);
  return haystack.slice(from, to).replace(/\s+/g, " ").trim();
}

/**
 * Every usable address on one page, best first.
 *
 * `mailto:` links are scored above addresses found in body text: a mailto is
 * unambiguously an address somebody published to be written to, whereas loose
 * text can be a customer's address in a testimonial.
 */
export function extractEmails(
  html: string,
  opts: { pageUrl: string; websiteDomain?: string | null; ownerName?: string | null }
): EmailCandidate[] {
  const site = rootDomain(opts.websiteDomain || opts.pageUrl || "");
  const text = deobfuscate(stripHtml(html));
  const found = new Map<string, EmailCandidate>();

  const consider = (raw: string, fromMailto: boolean, context: string) => {
    const email = raw.trim().toLowerCase().replace(/[.,;:)\]]+$/, "");
    if (!isPlausibleEmail(email)) return;

    const [local, domain] = [email.slice(0, email.indexOf("@")), email.slice(email.indexOf("@") + 1)];
    const onDomain = !!site && rootDomain(domain) === site;
    const kind = matchesOwnerName(local, opts.ownerName)
      ? "personal"
      : classifyLocalPart(local);

    /*
     * CONFIDENCE ANSWERS ONE QUESTION: does this address reach this business?
     *
     * It deliberately says nothing about WHO it reaches. That belongs in
     * bestEmail's ranking, and mixing the two is what broke this.
     *
     * The bug, which cost the programme its best addresses: role accounts used
     * to get +0.05 here and personal ones got nothing. Off-domain starts at
     * 0.4, a mailto added 0.15, and the store floor is 0.6 — so
     * `info@gmail.com` landed on exactly 0.60 and was kept, while
     * `sam@gmail.com` on the same page landed on 0.55 and was thrown away.
     * That 0.05 was the whole difference, and it discarded the owner's real
     * inbox at precisely the businesses this sells to best: the one-van
     * operators whose contact page is a gmail address.
     *
     * The comment that used to sit here said an off-domain address "is kept
     * and scored down rather than dropped". The arithmetic did not do that.
     * Now it does.
     */
    let confidence = onDomain ? 0.7 : 0.4;

    /*
     * A mailto: is markup somebody wrote on purpose so that strangers can
     * write to them. That is a far stronger signal than the old +0.15 treated
     * it as, and it is now enough on its own to carry an off-domain address
     * over the floor (0.4 + 0.25 = 0.65).
     *
     * Loose body text deliberately does NOT get this: an address in a
     * paragraph can be a customer's, quoted in a testimonial.
     */
    if (fromMailto) confidence += 0.25;

    // We already know this person's name and this is their address. The
    // strongest signal available without paying a provider — and it rescues an
    // off-domain personal address that was only ever in body text.
    if (matchesOwnerName(local, opts.ownerName)) confidence += 0.2;

    confidence = Math.min(0.98, Number(confidence.toFixed(2)));

    const existing = found.get(email);
    if (existing && existing.confidence >= confidence) return;
    found.set(email, {
      email,
      kind,
      confidence,
      sourceUrl: opts.pageUrl,
      supportingText: context.slice(0, 200),
      onDomain,
    });
  };

  // mailto: links first, straight out of the markup.
  const mailto = /href\s*=\s*["']\s*mailto:([^"'?>\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = mailto.exec(html)) !== null) {
    const decoded = safeDecode(m[1]);
    consider(decoded, true, contextAround(text, decoded) || "mailto: link");
  }

  // Then anything in the visible text.
  const inText = text.match(EMAIL_RE) || [];
  for (const raw of inText) consider(raw, false, contextAround(text, raw));

  return [...found.values()].sort((a, b) => b.confidence - a.confidence);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The one address to store, out of everything found across every page.
 *
 * Returns null rather than settling. An address we are not confident in is a
 * bounce, and bounces are what get a sending domain blocked — so "none" is a
 * perfectly good answer and is much better than "probably".
 */
export const MIN_STORE_CONFIDENCE = 0.6;

export function bestEmail(candidates: EmailCandidate[]): EmailCandidate | null {
  const usable = candidates.filter((c) => c.confidence >= MIN_STORE_CONFIDENCE);
  if (usable.length === 0) return null;

  // A named person beats a role account of the same confidence: the whole
  // point of the programme is reaching the person who can say yes.
  const rank = (c: EmailCandidate) =>
    c.confidence + (c.kind === "personal" ? 0.15 : c.kind === "role" ? 0.05 : 0);
  return [...usable].sort((a, b) => rank(b) - rank(a))[0];
}
