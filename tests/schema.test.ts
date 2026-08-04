import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every column this app names, checked against the migrations that create them.
 *
 * A misspelled column does not fail the build, does not fail typecheck, and
 * does not throw — Supabase answers 200 with an error string, the page shows
 * "run the migration", and the real cause (a column that never existed) is
 * invisible. That is how `learning_observations.outcome` reached production
 * when the column has always been called `outcome_type`.
 *
 * This reads the SQL rather than trusting a hand-maintained list, so a new
 * migration keeps it honest automatically.
 */

const ROOT = join(__dirname, "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

/** table -> columns, from CREATE TABLE bodies and ALTER TABLE ADD COLUMN. */
function schema(): Map<string, Set<string>> {
  const sql = migrationSql();
  const tables = new Map<string, Set<string>>();
  const add = (t: string, c: string) => {
    if (!tables.has(t)) tables.set(t, new Set());
    tables.get(t)!.add(c);
  };

  const created = /create table (?:if not exists )?(\w+)\s*\(\n([\s\S]*?)\n\);/gi;
  for (let m = created.exec(sql); m; m = created.exec(sql)) {
    const [, name, body] = m;
    if (!tables.has(name)) tables.set(name, new Set());
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      const col = /^([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(t);
      if (!col) continue;
      const word = col[1].toLowerCase();
      if (["primary", "unique", "check", "constraint", "foreign"].includes(word)) continue;
      add(name, col[1]);
    }
  }

  const altered = /alter table (\w+)\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)/gi;
  for (let m = altered.exec(sql); m; m = altered.exec(sql)) add(m[1], m[2]);

  return tables;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

type Reference = { file: string; table: string; column: string };

/**
 * Column lists are sometimes a named constant rather than an inline string.
 * Resolving them matters: hiding a list behind a constant is exactly what made
 * an earlier version of this check blind to the bug it was written for.
 */
function constants(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*\n?\s*"([^"]*)"/g;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) out.set(m[1], m[2]);
  return out;
}

/** Every `.from("table")….select(…)` pair in the app. */
function selectedColumns(): Reference[] {
  const refs: Reference[] = [];
  const pattern =
    /\.from\(\s*"(\w+)"\s*\)([\s\S]{0,400}?)\.select\(\s*(?:["`]([^"`]*)["`]|([A-Z][A-Z0-9_]*))/g;

  for (const file of sourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    const consts = constants(text);
    for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
      const [, table, between, literal, constName] = m;
      // The window ran past this statement into the next one.
      if (between.includes(".from(")) continue;
      let cols = literal ?? (constName ? consts.get(constName) : undefined);
      if (cols === undefined || cols.includes("*")) continue;
      // A select can be a template literal splicing a shared column list in:
      //   .select(`id, phone, ${ASSIGNMENT_COLUMNS}`)
      // Leaving the interpolation unresolved would quietly stop checking every
      // column it contributes, which is the same blindness the constant
      // resolution above was added to fix.
      cols = cols.replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (whole, name: string) => {
        const resolved = consts.get(name);
        if (resolved !== undefined) return resolved;
        for (const file2 of sourceFiles(join(ROOT, "src"))) {
          const c = constants(readFileSync(file2, "utf8")).get(name);
          if (c !== undefined) return c;
        }
        return whole;
      });
      // Nested relations — leads(business_name) — are joins, not columns here.
      const flat = cols.replace(/\w+\s*\([^)]*\)/g, "");
      for (const raw of flat.split(",")) {
        const column = raw.trim().split(":")[0].trim();
        if (!/^[a-z_][a-z0-9_]*$/.test(column)) continue;
        refs.push({ file: file.slice(ROOT.length + 1), table, column });
      }
    }
  }
  return refs;
}

describe("every column the app reads exists in the migrations", () => {
  const tables = schema();
  const refs = selectedColumns();

  it("parses a real schema out of the SQL", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // assertion below vacuous.
    expect(tables.size).toBeGreaterThan(20);
    expect(tables.get("recordings")?.has("consent_status")).toBe(true);
    expect(tables.get("call_analysis")?.has("needs_review")).toBe(true);
    expect(tables.get("learning_observations")?.has("outcome_type")).toBe(true);
    // The exact misspelling that shipped.
    expect(tables.get("learning_observations")?.has("outcome")).toBe(false);
  });

  it("finds the select statements to check", () => {
    expect(refs.length).toBeGreaterThan(100);
  });

  it("names no column that does not exist", () => {
    const missing = refs
      .filter((r) => tables.has(r.table) && !tables.get(r.table)!.has(r.column))
      .map((r) => `${r.file}: ${r.table}.${r.column}`);
    expect([...new Set(missing)]).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* ambiguous embeds                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which tables each table points at, and how many times.
 *
 * `call_analysis` references `callers` twice — `caller_id`, who made the call,
 * and `confirmed_by`, whoever settled the reading afterwards. PostgREST cannot
 * guess which one `callers(name)` means, so it refuses the ENTIRE query with
 * "more than one relationship was found for 'call_analysis' and 'callers'".
 *
 * That reached production. The Needs-you badge read 30 because the counting
 * query has no embed, and the list underneath read 0 because the list query
 * failed — the two disagreeing was the only symptom, and neither number was
 * obviously the wrong one.
 *
 * It does not fail the build, does not fail typecheck and does not throw. So
 * it gets a test that reads the migrations.
 */
function foreignKeys(): Map<string, Map<string, string[]>> {
  const sql = migrationSql();
  const fks = new Map<string, Map<string, string[]>>();

  const created = /create table (?:if not exists )?(\w+)\s*\(\n([\s\S]*?)\n\);/gi;
  for (let m = created.exec(sql); m; m = created.exec(sql)) {
    const [, source, body] = m;
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("--")) continue;
      const ref = /^([a-z_][a-z0-9_]*)\s+[\s\S]*?references\s+([a-z_][a-z0-9_]*)\s*\(/i.exec(line);
      if (!ref) continue;
      const [, column, target] = ref;
      if (!fks.has(source)) fks.set(source, new Map());
      const byTarget = fks.get(source)!;
      byTarget.set(target, [...(byTarget.get(target) || []), column]);
    }
  }

  // ALTER TABLE ... ADD COLUMN x uuid references y(id)
  const altered =
    /alter table (\w+)\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)[^;]*?references\s+([a-z_][a-z0-9_]*)\s*\(/gi;
  for (let m = altered.exec(sql); m; m = altered.exec(sql)) {
    const [, source, column, target] = m;
    if (!fks.has(source)) fks.set(source, new Map());
    const byTarget = fks.get(source)!;
    byTarget.set(target, [...(byTarget.get(target) || []), column]);
  }

  return fks;
}

/**
 * Every `.from("x").select("… y(…) …")` in the codebase.
 *
 * Scanned rather than regexed in one shot, because the obvious regex is wrong
 * in a way that silently passes: `\.select\(([\s\S]*?)\)` is non-greedy and
 * stops at the FIRST close paren, which in
 * `select("id, leads(business_name), callers(name)")` is the one closing
 * `leads(...)` — so the embed that actually breaks the query is never even
 * looked at. This walks the argument with a depth counter instead.
 */
function selectArgument(text: string, from: number): string | null {
  const at = text.indexOf(".select(", from);
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + ".select".length; i < text.length; i++) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(at + ".select(".length, i);
    }
  }
  return null;
}

function embeds(): { file: string; source: string; target: string; hinted: boolean }[] {
  const out: { file: string; source: string; target: string; hinted: boolean }[] = [];
  const files = [
    ...sourceFiles(join(ROOT, "src", "app")),
    ...sourceFiles(join(ROOT, "src", "lib")),
  ];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const from = /\.from\(\s*["'`](\w+)["'`]\s*\)/g;
    for (let m = from.exec(text); m; m = from.exec(text)) {
      const source = m[1];
      // The select belongs to this from() only if no other from() intervenes.
      const nextFrom = text.indexOf(".from(", m.index + 1);
      const arg = selectArgument(text, m.index);
      if (arg === null) continue;
      const argAt = text.indexOf(".select(", m.index);
      if (nextFrom >= 0 && argAt > nextFrom) continue;

      // Embeds look like `target(cols)`; a hinted one is `target!fk(cols)`.
      const embed = /([a-z_][a-z0-9_]*)\s*(![a-z_][a-z0-9_]*)?\s*\(/gi;
      for (let e = embed.exec(arg); e; e = embed.exec(arg)) {
        const [, target, hint] = e;
        if (["exact", "count", "head"].includes(target)) continue;
        out.push({ file: file.replace(ROOT + "/", ""), source, target, hinted: !!hint });
      }
    }
  }
  return out;
}

describe("no query embeds an ambiguously-related table", () => {
  const fks = foreignKeys();

  it("call_analysis really does reference callers twice — the case that caused this", () => {
    expect(fks.get("call_analysis")?.get("callers")?.length).toBe(2);
  });

  it("NO SELECT EMBEDS A TABLE ITS SOURCE POINTS AT MORE THAN ONCE", () => {
    const bad: string[] = [];
    for (const e of embeds()) {
      if (e.hinted) continue; // disambiguated on purpose
      const columns = fks.get(e.source)?.get(e.target);
      if (columns && columns.length > 1) {
        bad.push(
          `${e.file}: .from("${e.source}").select(… ${e.target}(…) …) — ` +
            `${e.source} references ${e.target} via ${columns.join(" and ")}. ` +
            `PostgREST refuses the whole query. Fetch it separately, or hint the column.`
        );
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("the review queue no longer embeds callers at all", () => {
    const reviewEmbeds = embeds().filter(
      (e) => e.file.includes("api/review") && e.source === "call_analysis"
    );
    expect(reviewEmbeds.map((e) => e.target)).not.toContain("callers");
  });
});

/* -------------------------------------------------------------------------- */
/* enumerated constraints vs the code that writes to them                     */
/* -------------------------------------------------------------------------- */

/**
 * A check constraint is a list of allowed values in SQL. The code that decides
 * what to write is a list of allowed values in TypeScript. Nothing keeps the
 * two in step, and when they drift the failure is not a warning — Postgres
 * rejects the INSERT and every other field on that row goes with it.
 *
 * That is not hypothetical. `calls_script_version_check` allowed A, B and C;
 * SCRIPT_VERSIONS grew to A..G; and four callers in seven lost their entire
 * outcome — notes, next step, duration — to an alert box about a tracking
 * column. Nothing caught it because both halves were internally consistent.
 *
 * So the test reads both halves and asserts the SQL admits every value the
 * code can produce.
 */

/** The definition of one named check constraint, last one wins. */
function checkConstraint(name: string): string | null {
  const sql = migrationSql();
  const re = new RegExp(`constraint\\s+${name}\\s*\\n?\\s*check\\s*\\(([\\s\\S]*?)\\)\\s*;`, "gi");
  let found: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) found = m[1];
  return found;
}

describe("what the code may write, the database must accept", () => {
  it("the script_version constraint exists and was widened", () => {
    const def = checkConstraint("calls_script_version_check");
    expect(def, "0034 should define calls_script_version_check").toBeTruthy();
    // The list form is the trap: it is correct until somebody adds a variant.
    expect(def).not.toMatch(/in\s*\(/i);
  });

  it("EVERY SCRIPT VERSION THE ASSIGNER CAN PRODUCE IS ACCEPTED BY THE COLUMN", () => {
    const def = checkConstraint("calls_script_version_check") || "";
    const shape = /~\s*'\^(\[[^\]]+\])\$'/.exec(def);
    expect(shape, `could not read a shape out of: ${def}`).toBeTruthy();
    const allowed = new RegExp(`^${shape![1]}$`);

    const src = readFileSync(join(ROOT, "src", "lib", "gatekeeperScripts.ts"), "utf8");
    const list = /SCRIPT_VERSIONS\s*=\s*\[([^\]]+)\]/.exec(src);
    expect(list, "could not read SCRIPT_VERSIONS").toBeTruthy();
    const versions = [...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(3);

    const rejected = versions.filter((v) => !allowed.test(v));
    expect(
      rejected,
      `the database would reject ${rejected.join(", ")} and discard the whole call`
    ).toEqual([]);
  });

  it("the outcome route never lets a refused tag discard the call", () => {
    const route = readFileSync(
      join(ROOT, "src", "app", "api", "dial", "outcome", "route.ts"),
      "utf8"
    );
    // A check violation naming this column must be retried untagged, not returned.
    expect(route).toMatch(/23514/);
    expect(route).toMatch(/script_version:\s*null/);
  });
});
