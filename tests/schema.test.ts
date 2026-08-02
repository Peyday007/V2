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
      const cols = literal ?? (constName ? consts.get(constName) : undefined);
      if (cols === undefined || cols.includes("*")) continue;
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
