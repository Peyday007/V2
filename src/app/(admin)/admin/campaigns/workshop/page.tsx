"use client";

import { useCallback, useEffect, useState } from "react";
import { WorkshopBody, WorkshopShell, type WorkshopPacket } from "@/components/WorkshopView";

/*
 * The owner's page, from our side of it.
 *
 * There was no way to read what a prospect actually receives without finding
 * a real token and opening it — which marks the packet opened and puts an
 * admin in the funnel as if they were the prospect. This runs the same
 * computeGaps and buildRecommendations off the same lead row, changes
 * nothing, and records nothing.
 *
 * It renders through the SAME component the live page uses, so what is shown
 * here is what is shown there. A preview drawn by different code from the
 * page it previews is worth nothing.
 */

type Preview = {
  error: string | null;
  leads?: LeadOption[];
  packet: (WorkshopPacket & { leadId: string }) | null;
};
type LeadOption = { id: string; business_name: string; city: string | null };

export default function WorkshopPreviewPage() {
  const [data, setData] = useState<Preview | null>(null);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [leadId, setLeadId] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workshop/preview${id ? `?lead_id=${encodeURIComponent(id)}` : ""}`);
      const j: Preview = await res.json();
      setData(j);
      if (j.leads?.length) setLeads(j.leads);
    } catch (e) {
      setData({ error: e instanceof Error ? e.message : String(e), packet: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Inside the workshop</h1>
      <p className="faint" style={{ marginBottom: 18, lineHeight: 1.6 }}>
        Exactly what a business owner sees when they open their link, rendered by
        the same code as the real page. Nothing here is recorded — opening this
        does not mark anybody&rsquo;s packet as read.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 20, flexWrap: "wrap" }}>
        <select
          value={leadId}
          disabled={loading}
          onChange={(e) => {
            setLeadId(e.target.value);
            load(e.target.value);
          }}
          style={{ minWidth: 280 }}
        >
          <option value="">A lead with a diagnosis (chosen for me)</option>
          {leads.map((l) => (
            <option key={l.id} value={l.id}>
              {l.business_name}
              {l.city ? ` — ${l.city}` : ""}
            </option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => load(leadId)} disabled={loading}>
          {loading ? "Loading…" : "Reload"}
        </button>
      </div>

      {data?.error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", lineHeight: 1.6 }}>
          {data.error}
        </div>
      )}

      {data?.packet && (
        <>
          {data.packet.gaps.length === 0 && (
            <div className="card" style={{ borderColor: "var(--amber-dim)", marginBottom: 16, lineHeight: 1.6 }}>
              <strong>This lead has no findings.</strong> The page below is what
              they would get — deliberately thin, because nothing has been worked
              out about them yet. A page like this is a signal to enrich the lead,
              not to send it.
            </div>
          )}
          {/*
            Framed so it is obvious this is the public page and not another
            admin screen. The border is the edge of what a prospect sees.
          */}
          <div
            style={{
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              background: "var(--bg)",
              overflow: "hidden",
            }}
          >
            <div
              className="faint"
              style={{
                padding: "8px 16px",
                borderBottom: "1px solid var(--border)",
                fontSize: "0.72rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              What they see
            </div>
            <WorkshopShell>
              <WorkshopBody data={data.packet} />
              {/*
                The button is shown, dead, rather than hidden. It is part of
                what a prospect reads, and leaving it out would make the page
                look shorter and less committal than it really is.
              */}
              <button className="btn" disabled style={{ fontSize: "1.05rem", padding: "14px 26px" }}>
                Start my free 7-day trial
              </button>
              <p className="faint" style={{ marginTop: 10, lineHeight: 1.55 }}>
                (Not clickable here. On the real page this opens the form.)
              </p>
            </WorkshopShell>
          </div>
        </>
      )}
    </div>
  );
}
