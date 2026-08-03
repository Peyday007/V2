// Team updates: what order they appear in, what counts as unread, and how the
// body text is turned into something renderable.
//
// Pure. No database, no React — so the caller's panel and the admin's feed
// cannot disagree about which update is at the top, and the markdown can be
// tested without a browser.
//
// The markdown deliberately parses to a DATA STRUCTURE rather than to an HTML
// string. Nothing in this file ever produces markup, so there is no
// dangerouslySetInnerHTML anywhere downstream and no way for a body to inject
// anything into a caller's page. The renderer turns the structure into React
// elements and text nodes, which escape themselves.

export type Update = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  archived_at?: string | null;
  created_at: string;
  updated_at?: string | null;
};

/* -------------------------------------------------------------------------- */
/* the feed                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pinned first, then newest first.
 *
 * The pin is what stops the one update everybody must read from sinking under
 * a fortnight of small notes, so it outranks recency outright rather than
 * merely nudging it.
 */
export function orderUpdates<T extends Pick<Update, "pinned" | "created_at">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

/** Retired updates stay in the database but leave the feed. */
export function liveUpdates<T extends Pick<Update, "archived_at">>(rows: T[]): T[] {
  return rows.filter((r) => !r.archived_at);
}

/* -------------------------------------------------------------------------- */
/* what is new to this caller                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which updates this caller has not seen.
 *
 * A caller who has never opened the panel has no timestamp at all, and every
 * update is new to them — which is exactly right for somebody's first shift,
 * because this doubles as the onboarding material.
 */
export function unseenUpdates<T extends Pick<Update, "created_at" | "archived_at">>(
  rows: T[],
  lastSeenAt: string | null | undefined
): T[] {
  const live = liveUpdates(rows);
  if (!lastSeenAt) return live;
  const seenAt = Date.parse(lastSeenAt);
  if (!Number.isFinite(seenAt)) return live;
  return live.filter((r) => Date.parse(r.created_at) > seenAt);
}

export function unseenCount<T extends Pick<Update, "created_at" | "archived_at">>(
  rows: T[],
  lastSeenAt: string | null | undefined
): number {
  return unseenUpdates(rows, lastSeenAt).length;
}

/**
 * An edit does not make an update unread again.
 *
 * Deliberate: fixing a typo would otherwise re-nag every caller who had
 * already read and acted on it, and after that happens twice they stop
 * trusting the badge. Something genuinely new gets posted as a new update.
 */
export function badgeLabel(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 new" : `${count} new`;
}

/* -------------------------------------------------------------------------- */
/* markdown                                                                   */
/* -------------------------------------------------------------------------- */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

/**
 * Bold, italic and inline code, in one pass.
 *
 * Ordered so `**bold**` is consumed before `*italic*` — matching the single
 * asterisk first would turn every bold run into two empty italics, which is
 * the classic way a hand-rolled markdown parser mangles its own input.
 */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });

    const token = match[0];
    if (token.startsWith("**")) out.push({ kind: "strong", text: token.slice(2, -2) });
    else if (token.startsWith("`")) out.push({ kind: "code", text: token.slice(1, -1) });
    else out.push({ kind: "em", text: token.slice(1, -1) });

    last = at + token.length;
  }

  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  // An empty run would render as an empty <p>; a single text node is the
  // honest representation of a line with no formatting in it.
  return out.length > 0 ? out : [{ kind: "text", text }];
}

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Block-level parse.
 *
 * Supports headings, bullet and numbered lists, and paragraphs — which is
 * everything a process note needs. There is no image, table, link or raw-HTML
 * syntax on purpose: the brief asked for formatted text, and every construct
 * that is not here is one that cannot go wrong.
 */
export function parseMarkdown(body: string): Block[] {
  const blocks: Block[] = [];
  const lines = (body || "").replace(/\r\n/g, "\n").split("\n");

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      items: list.items.map((i) => parseInline(i)),
    });
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      flush();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length as 1 | 2 | 3,
        inlines: parseInline(heading[2].trim()),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = !bullet ? NUMBERED.exec(line) : null;
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !!numbered;
      // A bullet list running straight into a numbered one is two lists.
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet?.[1] ?? numbered?.[1] ?? "").trim());
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/** Plain text, for a preview line or a search. Never rendered as markup. */
export function toPlainText(body: string, limit = 160): string {
  const flat = parseMarkdown(body)
    .map((b) =>
      b.kind === "list"
        ? b.items.map((i) => i.map((x) => x.text).join("")).join(" · ")
        : b.inlines.map((x) => x.text).join("")
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/* -------------------------------------------------------------------------- */
/* posting                                                                    */
/* -------------------------------------------------------------------------- */

export const MAX_TITLE = 160;
export const MAX_BODY = 20_000;

export type DraftProblem = { field: "title" | "body"; message: string };

/** What is wrong with a draft, in words, or nothing. */
export function validateDraft(draft: { title: string; body: string }): DraftProblem | null {
  const title = (draft.title || "").trim();
  const body = (draft.body || "").trim();
  if (!title) return { field: "title", message: "Give it a title — that is what the callers see first." };
  if (title.length > MAX_TITLE) {
    return { field: "title", message: `Titles are capped at ${MAX_TITLE} characters.` };
  }
  if (!body) return { field: "body", message: "An update with no body is a notification for nothing." };
  if (body.length > MAX_BODY) {
    return { field: "body", message: `That is longer than the ${MAX_BODY}-character limit.` };
  }
  return null;
}
