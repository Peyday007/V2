"use client";

import { useState } from "react";
import { api, apiJson } from "@/lib/api";
import LoginGate from "@/components/LoginGate";

type Preview = {
  headers: string[];
  fields: string[];
  suggested_mapping: Record<string, string>;
};

type Batch = {
  id: number;
  filename: string;
  total_rows: number;
  created_businesses: number;
  linked_duplicates: number;
  error_rows: number;
  errors: { line: number; error: string }[];
};

export default function ImportPage() {
  return (
    <LoginGate>
      <Importer />
    </LoginGate>
  );
}

function Importer() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function doPreview(f: File) {
    setError("");
    setResult(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", f);
      const res = await api("/imports/preview", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).detail || "Preview failed");
      const p: Preview = await res.json();
      setPreview(p);
      setMapping(p.suggested_mapping);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append(
        "mapping",
        JSON.stringify(
          Object.fromEntries(Object.entries(mapping).filter(([, v]) => v))
        )
      );
      const res = await api("/imports", { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json()).detail || "Import failed");
      setResult(await res.json());
      setPreview(null);
      setFile(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  const mappedFields = Object.values(mapping).filter(Boolean);
  const hasName = mappedFields.includes("business_name");

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 16 }}>Import Leads</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => {
            const f = e.target.files?.[0] || null;
            setFile(f);
            if (f) doPreview(f);
          }}
        />
        <p className="faint" style={{ marginTop: 8 }}>
          CSV up to 10 MB. Duplicates (same phone, domain, or source ID) are
          linked to the existing business, never deleted.
        </p>
      </div>

      {error && <p style={{ color: "var(--red)", marginBottom: 12 }}>{error}</p>}

      {preview && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 10 }}>Map columns</h3>
          <table>
            <thead>
              <tr>
                <th>CSV column</th>
                <th>Import as</th>
              </tr>
            </thead>
            <tbody>
              {preview.headers.map((h) => (
                <tr key={h}>
                  <td style={{ fontWeight: 700 }}>{h}</td>
                  <td>
                    <select
                      value={mapping[h] || ""}
                      onChange={(e) =>
                        setMapping({ ...mapping, [h]: e.target.value })
                      }
                    >
                      <option value="">— skip —</option>
                      {preview.fields.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!hasName && (
            <p style={{ color: "var(--red)", marginTop: 10 }}>
              Map one column to business_name to import.
            </p>
          )}
          <button
            className="btn"
            style={{ marginTop: 14 }}
            disabled={busy || !hasName}
            onClick={runImport}
          >
            {busy ? "Importing…" : "Run import"}
          </button>
        </div>
      )}

      {result && (
        <div className="card" style={{ borderColor: "var(--amber-dim)" }}>
          <h3 style={{ color: "var(--amber)", marginBottom: 10 }}>
            Import complete — {result.filename}
          </h3>
          <p>
            {result.total_rows} rows → {result.created_businesses} new businesses,{" "}
            {result.linked_duplicates} duplicates linked, {result.error_rows} errors
          </p>
          {result.errors.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 20 }} className="muted">
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
