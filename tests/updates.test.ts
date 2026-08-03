// Team updates: the feed order, what counts as unread, and the markdown.
//
// The markdown gets the most attention here for one reason: an update body is
// typed by a person and then rendered on every caller's screen. It parses to a
// data structure with no markup in it anywhere, and these tests are what keep
// it that way — the moment something in here produces an HTML string, the
// no-injection guarantee is gone.

import { describe, it, expect } from "vitest";
import {
  orderUpdates,
  liveUpdates,
  unseenUpdates,
  unseenCount,
  badgeLabel,
  parseInline,
  parseMarkdown,
  toPlainText,
  validateDraft,
  MAX_TITLE,
  type Update,
} from "../src/lib/updates";

const u = (o: Partial<Update> & { id: string; created_at: string }): Update => ({
  title: `Update ${o.id}`,
  body: "body",
  pinned: false,
  archived_at: null,
  ...o,
});

/* -------------------------------------------------------------------------- */
/* order                                                                      */
/* -------------------------------------------------------------------------- */

describe("what sits at the top of the feed", () => {
  it("newest first, ordinarily", () => {
    const out = orderUpdates([
      u({ id: "old", created_at: "2026-01-01T00:00:00Z" }),
      u({ id: "new", created_at: "2026-08-01T00:00:00Z" }),
      u({ id: "mid", created_at: "2026-04-01T00:00:00Z" }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["new", "mid", "old"]);
  });

  it("A PIN OUTRANKS RECENCY OUTRIGHT — that is the point of pinning", () => {
    // The process change everybody must read cannot sink under a fortnight of
    // small notes just because the small notes are newer.
    const out = orderUpdates([
      u({ id: "yesterday", created_at: "2026-08-02T00:00:00Z" }),
      u({ id: "pinned-but-ancient", created_at: "2025-01-01T00:00:00Z", pinned: true }),
    ]);
    expect(out[0].id).toBe("pinned-but-ancient");
  });

  it("pinned updates are still sorted among themselves", () => {
    const out = orderUpdates([
      u({ id: "pin-old", created_at: "2026-01-01T00:00:00Z", pinned: true }),
      u({ id: "pin-new", created_at: "2026-08-01T00:00:00Z", pinned: true }),
    ]);
    expect(out.map((r) => r.id)).toEqual(["pin-new", "pin-old"]);
  });

  it("does not mutate the array it was handed", () => {
    const rows = [
      u({ id: "a", created_at: "2026-01-01T00:00:00Z" }),
      u({ id: "b", created_at: "2026-08-01T00:00:00Z" }),
    ];
    orderUpdates(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("retired updates leave the feed but not the database", () => {
    const rows = [
      u({ id: "live", created_at: "2026-08-01T00:00:00Z" }),
      u({ id: "gone", created_at: "2026-08-02T00:00:00Z", archived_at: "2026-08-03T00:00:00Z" }),
    ];
    expect(liveUpdates(rows).map((r) => r.id)).toEqual(["live"]);
    expect(rows).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* unread                                                                     */
/* -------------------------------------------------------------------------- */

describe("what is new to this caller", () => {
  const rows = [
    u({ id: "before", created_at: "2026-08-01T09:00:00Z" }),
    u({ id: "after", created_at: "2026-08-01T11:00:00Z" }),
  ];

  it("EVERYTHING is new to somebody who has never opened it", () => {
    // Which is exactly right on a new hire's first shift — this doubles as the
    // onboarding material.
    expect(unseenCount(rows, null)).toBe(2);
    expect(unseenCount(rows, undefined)).toBe(2);
  });

  it("only what was posted after they last looked", () => {
    const out = unseenUpdates(rows, "2026-08-01T10:00:00Z");
    expect(out.map((r) => r.id)).toEqual(["after"]);
  });

  it("nothing, once they are up to date", () => {
    expect(unseenCount(rows, "2026-08-02T00:00:00Z")).toBe(0);
  });

  it("a retired update never counts as unread", () => {
    const withRetired = [
      ...rows,
      u({ id: "retired", created_at: "2026-08-05T00:00:00Z", archived_at: "2026-08-06T00:00:00Z" }),
    ];
    expect(unseenCount(withRetired, "2026-08-01T10:00:00Z")).toBe(1);
  });

  it("a corrupt timestamp is treated as never having looked, not as up to date", () => {
    // Failing open here means somebody sees an update twice. Failing closed
    // means they never see it at all, which is the expensive direction.
    expect(unseenCount(rows, "not a date")).toBe(2);
  });

  it("the badge reads like a person wrote it", () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-1)).toBeNull();
    expect(badgeLabel(1)).toBe("1 new");
    expect(badgeLabel(4)).toBe("4 new");
  });
});

/* -------------------------------------------------------------------------- */
/* markdown — inline                                                          */
/* -------------------------------------------------------------------------- */

describe("inline formatting", () => {
  it("BOLD IS MATCHED BEFORE ITALIC", () => {
    // Matching the single asterisk first turns every **bold** run into two
    // empty italics — the classic way a hand-rolled parser mangles its input.
    expect(parseInline("**What changed:** we moved")).toEqual([
      { kind: "strong", text: "What changed:" },
      { kind: "text", text: " we moved" },
    ]);
  });

  it("handles italic and code", () => {
    expect(parseInline("*maybe*")).toEqual([{ kind: "em", text: "maybe" }]);
    expect(parseInline("press `Send`")).toEqual([
      { kind: "text", text: "press " },
      { kind: "code", text: "Send" },
    ]);
  });

  it("keeps several runs in order", () => {
    expect(parseInline("a **b** c *d* e").map((p) => p.kind)).toEqual([
      "text",
      "strong",
      "text",
      "em",
      "text",
    ]);
  });

  it("plain text stays one node", () => {
    expect(parseInline("nothing special here")).toEqual([
      { kind: "text", text: "nothing special here" },
    ]);
  });

  it("an unclosed marker is left alone rather than eating the rest of the line", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
    expect(parseInline("**unclosed")).toEqual([{ kind: "text", text: "**unclosed" }]);
  });
});

/* -------------------------------------------------------------------------- */
/* markdown — blocks                                                          */
/* -------------------------------------------------------------------------- */

describe("block formatting", () => {
  it("headings by depth", () => {
    const blocks = parseMarkdown("# One\n## Two\n### Three");
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : null))).toEqual([1, 2, 3]);
  });

  it("blank lines separate paragraphs", () => {
    const blocks = parseMarkdown("first para\n\nsecond para");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
  });

  it("a wrapped paragraph joins back into one", () => {
    const blocks = parseMarkdown("one line\nand its continuation");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].inlines[0].text).toBe("one line and its continuation");
  });

  it("bullet lists, with either marker", () => {
    const blocks = parseMarkdown("- one\n* two");
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "list") throw new Error("expected list");
    expect(blocks[0].ordered).toBe(false);
    expect(blocks[0].items).toHaveLength(2);
  });

  it("numbered lists", () => {
    const blocks = parseMarkdown("1. first\n2. second");
    if (blocks[0].kind !== "list") throw new Error("expected list");
    expect(blocks[0].ordered).toBe(true);
  });

  it("a bullet list running into a numbered one is two lists", () => {
    const blocks = parseMarkdown("- bullet\n1. numbered");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === "list")).toBe(true);
  });

  it("formatting works inside list items", () => {
    const blocks = parseMarkdown("- a **bold** point");
    if (blocks[0].kind !== "list") throw new Error("expected list");
    expect(blocks[0].items[0].map((i) => i.kind)).toEqual(["text", "strong", "text"]);
  });

  it("an empty body produces nothing rather than throwing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });

  it("survives Windows line endings", () => {
    expect(parseMarkdown("one\r\n\r\ntwo")).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* the property that matters most                                             */
/* -------------------------------------------------------------------------- */

describe("nothing here can produce markup", () => {
  const nasty = [
    '<script>alert("xss")</script>',
    '<img src=x onerror="alert(1)">',
    "<b>bold</b> and <a href='javascript:alert(1)'>link</a>",
    "</p><script>fetch('/api/leads')</script>",
  ];

  it("HTML IN A BODY STAYS TEXT — it is never parsed as markup", () => {
    for (const body of nasty) {
      const blocks = parseMarkdown(body);
      const flat = JSON.stringify(blocks);
      // The characters survive as text content...
      expect(toPlainText(body)).toContain("<");
      // ...and every leaf is a plain string on a `text`-ish node, never a
      // structure the renderer would treat as an element.
      for (const b of blocks) {
        const inlines = b.kind === "list" ? b.items.flat() : b.inlines;
        for (const piece of inlines) {
          expect(typeof piece.text).toBe("string");
          expect(["text", "strong", "em", "code"]).toContain(piece.kind);
        }
      }
      expect(flat).not.toMatch(/"kind":"(html|raw|element)"/);
    }
  });

  it("there is no link or image syntax to abuse", () => {
    const blocks = parseMarkdown("[click](javascript:alert(1)) ![x](y)");
    // Parsed as ordinary text — no href, no src, nothing to navigate to.
    expect(blocks).toHaveLength(1);
    if (blocks[0].kind !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].inlines.every((i) => i.kind === "text" || i.kind === "em")).toBe(true);
    expect(JSON.stringify(blocks)).not.toMatch(/href|src/);
  });
});

/* -------------------------------------------------------------------------- */
/* the real seeded update                                                     */
/* -------------------------------------------------------------------------- */

describe("the first update, as seeded", () => {
  const BODY = `**What changed:** we're no longer booking a 15-minute meeting at the end of the call. Instead, we offer a free trial on the spot and text them a link.

Steps 1-3 stay exactly the same — pain-only, no mention of "AI" or naming the product.

**Step 4 (new close):** "Let me start it on your line right now — no cost, no commitment. Sound fair?"

**What's in the packet** (for your own understanding, you don't need to walk them through it live):

- Their business name and a couple of specific gaps we found
- A link to see the AI receptionist actually working
- A button for them to confirm and officially start the trial

If you're not sure what to say at any point, hit "Objection Help" — don't freelance the pitch.`;

  it("parses into the shape it was written as", () => {
    const blocks = parseMarkdown(BODY);
    expect(blocks.filter((b) => b.kind === "list")).toHaveLength(1);
    const list = blocks.find((b) => b.kind === "list");
    if (!list || list.kind !== "list") throw new Error("expected the packet list");
    expect(list.items).toHaveLength(3);
  });

  it("keeps the bold labels the callers scan for", () => {
    const strongs = parseMarkdown(BODY)
      .flatMap((b) => (b.kind === "list" ? b.items.flat() : b.inlines))
      .filter((i) => i.kind === "strong")
      .map((i) => i.text);
    expect(strongs).toContain("What changed:");
    expect(strongs).toContain("Step 4 (new close):");
    expect(strongs).toContain("What's in the packet");
  });

  it("APOSTROPHES AND QUOTED SCRIPT LINES SURVIVE INTACT", () => {
    const flat = toPlainText(BODY, 5000);
    expect(flat).toContain("we're no longer booking");
    expect(flat).toContain("no cost, no commitment");
    expect(flat).toContain("don't freelance the pitch");
    expect(flat).toContain('"Objection Help"');
  });

  it("the hyphenated step range is not eaten as a bullet", () => {
    // "Steps 1-3 stay exactly the same" starts with a word, not a marker —
    // but a sloppier bullet regex would have caught the "-" inside it.
    const flat = toPlainText(BODY, 5000);
    expect(flat).toContain("Steps 1-3 stay exactly the same");
  });
});

describe("plain-text summaries", () => {
  it("flattens formatting for the board strip", () => {
    expect(toPlainText("**Bold** and *italic*")).toBe("Bold and italic");
  });

  it("joins list items readably", () => {
    expect(toPlainText("- one\n- two")).toBe("one · two");
  });

  it("truncates with an ellipsis rather than mid-word sprawl", () => {
    const out = toPlainText("x".repeat(400), 40);
    expect(out).toHaveLength(40);
    expect(out.endsWith("…")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* posting                                                                    */
/* -------------------------------------------------------------------------- */

describe("what may be posted", () => {
  it("accepts a real draft", () => {
    expect(validateDraft({ title: "New process", body: "Do this." })).toBeNull();
  });

  it("refuses an untitled update — the title is what callers see first", () => {
    expect(validateDraft({ title: "  ", body: "Do this." })?.field).toBe("title");
  });

  it("refuses an empty body — a notification for nothing", () => {
    const p = validateDraft({ title: "Heads up", body: "" });
    expect(p?.field).toBe("body");
    expect(p?.message).toMatch(/notification for nothing/);
  });

  it("caps the title", () => {
    expect(validateDraft({ title: "x".repeat(MAX_TITLE + 1), body: "b" })?.field).toBe("title");
    expect(validateDraft({ title: "x".repeat(MAX_TITLE), body: "b" })).toBeNull();
  });
});
