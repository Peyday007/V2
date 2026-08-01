// A fake Supabase client, enough of one to drive the recording pipeline end to
// end: tables, storage objects, and the handful of query shapes this feature
// uses. Deliberately in-memory and deliberately dumb — its job is to let the
// real pipeline code run, not to reimplement Postgres.

type Row = Record<string, unknown>;

export class FakeDb {
  tables = new Map<string, Row[]>();
  objects = new Map<string, Uint8Array>();
  /** Set to a message to make every storage write fail, as a dead network would. */
  storageFailure: string | null = null;
  signedUrls: string[] = [];

  seed(table: string, rows: Row[]) {
    this.tables.set(table, rows.map((r) => ({ ...r })));
  }

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }

  get storage() {
    return {
      from: (_bucket: string) => ({
        upload: async (key: string, body: ArrayBuffer | Uint8Array) => {
          if (this.storageFailure) return { data: null, error: { message: this.storageFailure } };
          const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
          this.objects.set(key, bytes);
          return { data: { path: key }, error: null };
        },
        download: async (key: string) => {
          const bytes = this.objects.get(key);
          if (!bytes) return { data: null, error: { message: "Object not found" } };
          return {
            data: {
              arrayBuffer: async () =>
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            },
            error: null,
          };
        },
        list: async (prefix: string) => {
          const names: { name: string }[] = [];
          for (const key of this.objects.keys()) {
            if (key.startsWith(`${prefix}/`)) names.push({ name: key.slice(prefix.length + 1) });
          }
          // Storage lists in arbitrary order. Shuffling here is the point: the
          // pipeline must not depend on the listing being sorted.
          return { data: names.reverse(), error: null };
        },
        remove: async (keys: string[]) => {
          if (this.storageFailure) return { data: null, error: { message: this.storageFailure } };
          for (const k of keys) this.objects.delete(k);
          return { data: null, error: null };
        },
        createSignedUrl: async (key: string, seconds: number) => {
          if (!this.objects.has(key)) return { data: null, error: { message: "Object not found" } };
          const url = `https://fake.storage/${key}?exp=${seconds}`;
          this.signedUrls.push(url);
          return { data: { signedUrl: url }, error: null };
        },
      }),
    };
  }
}

type Filter = { col: string; val: unknown; op: "eq" | "is" };

class FakeQuery {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private conflictKey: string | null = null;
  private limitN: number | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(_cols?: string) {
    if (this.mode === "select") this.mode = "select";
    return this;
  }
  insert(payload: Row | Row[]) {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = payload;
    this.conflictKey = opts?.onConflict ?? null;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, val, op: "is" });
    return this;
  }
  order() {
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) =>
      f.op === "is" ? (row[f.col] ?? null) === f.val : row[f.col] === f.val
    );
  }

  private run(): { data: Row[] } {
    const rows = this.db.rows(this.table);

    if (this.mode === "insert" || this.mode === "upsert") {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const written: Row[] = [];
      for (const item of items) {
        if (this.mode === "upsert" && this.conflictKey) {
          const existing = rows.find((r) => r[this.conflictKey!] === item[this.conflictKey!]);
          if (existing) {
            Object.assign(existing, item);
            written.push(existing);
            continue;
          }
        }
        const row: Row = { id: item.id ?? `id-${this.table}-${rows.length + 1}`, ...item };
        rows.push(row);
        written.push(row);
      }
      return { data: written };
    }

    if (this.mode === "update") {
      const hit = rows.filter((r) => this.matches(r));
      for (const r of hit) Object.assign(r, this.payload as Row);
      return { data: hit };
    }

    if (this.mode === "delete") {
      const keep: Row[] = [];
      const gone: Row[] = [];
      for (const r of rows) (this.matches(r) ? gone : keep).push(r);
      this.db.tables.set(this.table, keep);
      return { data: gone };
    }

    let out = rows.filter((r) => this.matches(r));
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return { data: out };
  }

  async single() {
    const { data } = this.run();
    if (data.length === 0) return { data: null, error: { message: "No rows" } };
    return { data: data[0], error: null };
  }

  async maybeSingle() {
    const { data } = this.run();
    return { data: data[0] ?? null, error: null };
  }

  then(resolve: (v: { data: Row[]; error: null }) => unknown) {
    const { data } = this.run();
    return Promise.resolve(resolve({ data, error: null }));
  }
}

/** A database already carrying the rows the recording flow expects to find. */
export function seededDb(
  over: { recordingEnabled?: boolean; consentPolicy?: string; transcriptionEnabled?: boolean } = {}
): FakeDb {
  const db = new FakeDb();
  db.seed("call_intelligence_settings", [
    {
      id: true,
      recording_enabled: over.recordingEnabled ?? true,
      consent_policy: over.consentPolicy ?? "all_party",
      consent_announcement: "This call may be recorded for quality and training purposes.",
      retention_days: 90,
      transcription_enabled: over.transcriptionEnabled ?? false,
    },
  ]);
  db.seed("recordings", []);
  db.seed("transcript_segments", []);
  db.seed("compliance_events", []);
  db.seed("calls", []);
  return db;
}
