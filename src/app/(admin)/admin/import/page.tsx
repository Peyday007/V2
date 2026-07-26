"use client";

import { useEffect, useState } from "react";
import { parseCsv, suggestMapping, IMPORTABLE_FIELDS } from "@/lib/csv";

type Campaign = { id: string; name: string };

type Result = {
  filename: string;
  total_rows: number;
  created: number;
  duplicates: number;
  error_rows: number;
  errors: { line: number; error: string }[];
};

export default function ImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/campaigns")
      .then((r) => r.json())
      .then((cs: Campaign[]) => {
        setCampaigns(cs);
        if (cs.length > 0) setCampaignId(cs[0].id);
      });
  }, []);

  async function pickFile(f: File) {
    setFile(f);
    setResult(null);
    setError("");
    const text = await f.text();
    const rows = parseCsv(text);
    if (rows.length < 2) {
      setError("That CSV has no data rows.");
      setHeaders([]);
      return;
    }
    const hs = rows[0].map((h) => h.trim());
    setHeaders(hs);
    setPreviewRows(rows.slice(1, 4));
    setMapping(suggestMapping(hs));
  }

  async function runImport() {
    if (!file) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    form.append(
      "mapping",
      JSON.stringify(Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))
    );
    if (campaignId) form.append("campaign_id", campaignId);
    const res = await fetch("/api/import", { method: "POST", body: form });
    const j = await res.json();
    if (!res.ok) {
      setError(j.error || "Import failed");
    } else {
      setResult(j);
      setHeaders([]);
      setFile(null);
    }
    setBusy(false);
  }

  const hasName = Object.values(mapping).includes("business_name");

  return (
    <div style={{ maxWidth: 780, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 16 }}>Import Leads</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept=".csv"
            style={{ maxWidth: 320 }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) pickFile(f);
            }}
          />
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            style={{ maxWidth: 260 }}
          >
            <option value="">No campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                → {c.name}
              </option>
            ))}
          </select>
        </div>
        <p className="faint" style={{ marginTop: 8 }}>
          CSV up to 10 MB. Rows matching an existing lead by phone, domain, or
          place ID are linked to it — nothing gets deleted, no duplicate calling.
        </p>
      </div>

      {error && <p style={{ color: "var(--red)", marginBottom: 12 }}>{error}</p>}

      {headers.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 10 }}>Map columns</h3>
          <table>
            <thead>
              <tr>
                <th>CSV column</th>
                <th>Sample</th>
                <th>Import as</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((h, i) => (
                <tr key={h + i}>
                  <td style={{ fontWeight: 700 }}>{h}</td>
                  <td className="faint">
                    {previewRows
                      .map((r) => r[i])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join(" · ")
                      .slice(0, 40)}
                  </td>
                  <td>
                    <select
                      value={mapping[h] || ""}
                      onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}
                    >
                      <option value="">— skip —</option>
                      {IMPORTABLE_FIELDS.map((f) => (
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
            {result.total_rows} rows → <strong>{result.created} new leads</strong>,{" "}
            {result.duplicates} duplicates linked, {result.error_rows} errors
          </p>
          {result.errors.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 20 }} className="muted">
              {result.errors.map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.error}
                </li>
              ))}
            </ul>
          )}
          {result.created > 0 && (
            <a href="/" className="btn" style={{ marginTop: 14 }}>
              View {result.created} new lead{result.created === 1 ? "" : "s"} on the board →
            </a>
          )}
        </div>
      )}
    </div>
  );
}
