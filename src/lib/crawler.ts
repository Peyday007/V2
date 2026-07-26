import "server-only";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { isAllowedByRobots } from "./crawler.robots";

// Polite, defensive fetching of lead websites.
//   - only http/https, only public IP addresses (SSRF guard)
//   - robots.txt honored
//   - hard timeout, response size cap, small page budget per site
//   - identifying User-Agent

export { isAllowedByRobots };

export const USER_AGENT =
  "DispatchBoardBot/1.0 (+contact: your admin; B2B decision-maker research)";

const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_500_000;

/** Private, loopback, link-local and carrier-grade NAT ranges. */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("::ffff:")) return isPrivateIPv4(lower.split(":").pop() || "");
  return false;
}

/** Reject anything that would let a lead's URL reach internal infrastructure. */
export async function isSafePublicUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }

  // A literal IP in the URL is checked directly; a name is resolved first.
  if (isIP(host)) {
    return isIP(host) === 4 ? !isPrivateIPv4(host) : !isPrivateIPv6(host);
  }
  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) =>
      r.family === 4 ? !isPrivateIPv4(r.address) : !isPrivateIPv6(r.address)
    );
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string | null> {
  if (!(await isSafePublicUrl(url))) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;

    const type = res.headers.get("content-type") || "";
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null;

    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_BYTES) return null;

    // Guard against servers that omit content-length.
    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export type FetchedPage = { url: string; html: string };

/**
 * Fetch a small, relevant set of pages from one site.
 * Stops early once `stopWhen` is satisfied so we crawl as little as possible.
 */
export async function crawlSite(
  websiteUrl: string,
  opts: {
    candidatePaths: string[];
    discover: (html: string, origin: string) => string[];
    maxPages?: number;
    stopWhen?: (page: FetchedPage) => boolean;
  }
): Promise<{ pages: FetchedPage[]; blockedByRobots: boolean }> {
  const maxPages = opts.maxPages ?? 5;
  const pages: FetchedPage[] = [];

  let origin: string;
  try {
    origin = new URL(websiteUrl).origin;
  } catch {
    return { pages, blockedByRobots: false };
  }

  const robotsTxt = (await fetchText(`${origin}/robots.txt`)) || "";
  const allowed = (u: string) => {
    try {
      return isAllowedByRobots(robotsTxt, new URL(u).pathname);
    } catch {
      return false;
    }
  };

  if (!allowed(origin + "/")) {
    return { pages, blockedByRobots: true };
  }

  const queue: string[] = [origin + "/"];
  const seen = new Set<string>();

  // Homepage first, so its links can point us at the real team page.
  const homeHtml = await fetchText(origin + "/");
  seen.add(origin + "/");
  if (homeHtml) {
    const page = { url: origin + "/", html: homeHtml };
    pages.push(page);
    if (opts.stopWhen?.(page)) return { pages, blockedByRobots: false };
    for (const link of opts.discover(homeHtml, origin)) queue.push(link);
  }

  for (const path of opts.candidatePaths) queue.push(origin + path);

  for (const url of queue) {
    if (pages.length >= maxPages) break;
    if (seen.has(url)) continue;
    seen.add(url);
    if (!allowed(url)) continue;

    const html = await fetchText(url);
    if (!html) continue;
    const page = { url, html };
    pages.push(page);
    if (opts.stopWhen?.(page)) break;

    // Be polite between requests to the same host.
    await new Promise((r) => setTimeout(r, 400));
  }

  return { pages, blockedByRobots: false };
}
