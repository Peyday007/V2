"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import LoginGate from "@/components/LoginGate";

type Business = {
  id: number;
  business_name: string;
  primary_phone: string | null;
  normalized_phone: string | null;
  normalized_domain: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  rating: number | null;
  review_count: number | null;
  lead_status: string;
  do_not_call: boolean;
};

type Listing = {
  total: number;
  page: number;
  page_size: number;
  items: Business[];
};

export default function BusinessesPage() {
  return (
    <LoginGate>
      <BusinessList />
    </LoginGate>
  );
}

function BusinessList() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  async function load(searchQ = q, p = page) {
    setError("");
    try {
      const params = new URLSearchParams({ page: String(p), page_size: "50" });
      if (searchQ.trim()) params.set("q", searchQ.trim());
      setListing(await apiJson<Listing>(`/businesses?${params}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const pages = listing ? Math.max(1, Math.ceil(listing.total / listing.page_size)) : 1;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h1>Businesses</h1>
        <span className="tag-dim">{listing?.total ?? "…"} total</span>
        <div style={{ flex: 1 }} />
        <input
          placeholder="Search name, phone, domain, city…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setPage(1);
              load(q, 1);
            }
          }}
          style={{ maxWidth: 320 }}
        />
      </div>

      {error && <p style={{ color: "var(--red)", marginBottom: 12 }}>{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Business</th>
            <th>Phone</th>
            <th>Domain</th>
            <th>Location</th>
            <th>Industry</th>
            <th>Rating</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {listing?.items.map((b) => (
            <tr key={b.id} style={{ opacity: b.do_not_call ? 0.45 : 1 }}>
              <td style={{ fontWeight: 700 }}>{b.business_name}</td>
              <td style={{ color: "var(--amber)" }}>
                {b.primary_phone || b.normalized_phone || "—"}
              </td>
              <td className="muted">{b.normalized_domain || "—"}</td>
              <td className="muted">
                {[b.city, b.state].filter(Boolean).join(", ") || "—"}
              </td>
              <td className="muted">{b.industry || "—"}</td>
              <td className="muted">
                {b.rating != null ? `★ ${b.rating} (${b.review_count ?? 0})` : "—"}
              </td>
              <td>
                <span className={b.do_not_call ? "tag-dim" : "tag"}>
                  {b.do_not_call ? "DNC" : b.lead_status}
                </span>
              </td>
            </tr>
          ))}
          {listing && listing.items.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No businesses yet — upload a CSV on the Import page.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {pages > 1 && (
        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button
            className="btn-ghost"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            ← Prev
          </button>
          <span className="muted">
            Page {page} of {pages}
          </span>
          <button
            className="btn-ghost"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
