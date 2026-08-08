"use client";

// What a business owner actually reads.
//
// Shared by the live page at /workshop/[token] and by the admin preview, so
// the preview cannot drift from the real thing. A preview rendered by
// different code than the page it previews is worth nothing — the same
// argument as the capacity page running the worker's own planner.
//
// This component is presentation only. It never fetches, never posts and never
// knows about tokens; the page around it owns all of that.

export type Gap = { key: string; headline: string; detail: string; basis: string };
export type Recommendation = { key: string; title: string; detail: string; basis: string };

export type WorkshopPacket = {
  businessName: string;
  city: string | null;
  state: string | null;
  gaps: Gap[];
  recommendations: Recommendation[];
  contact: { name: string; phone: string; email: string };
  alreadyRequested: boolean;
  requestedAt: string | null;
};

/**
 * The trial terms, verbatim.
 *
 * NOT TO BE EDITED as a matter of wording or tone. This is the sentence
 * somebody ticks a box against, so it is the closest thing here to a
 * contract; changing it changes what was agreed to. Same rule as prices and
 * consent language — a person decides, not a refactor.
 */
export const AGREEMENT = "I agree to a free 7-day trial, no cost, cancel anytime";

export function WorkshopBody({ data }: { data: WorkshopPacket }) {
  const where = [data.city, data.state].filter(Boolean).join(", ");

  return (
    <>
      <p className="faint" style={{ marginBottom: 4, letterSpacing: "0.1em", fontSize: "0.75rem" }}>
        PREPARED FOR
      </p>
      <h1 style={{ marginBottom: 4, fontSize: "1.9rem", textTransform: "none", letterSpacing: 0 }}>
        {data.businessName}
      </h1>
      {where && <p className="faint" style={{ marginBottom: 26 }}>{where}</p>}

      {/* ------------------------------ the gaps ------------------------------ */}
      {data.gaps.length > 0 ? (
        <>
          <h2 style={{ marginBottom: 12 }}>What we found</h2>
          <div style={{ display: "grid", gap: 14, marginBottom: 30 }}>
            {data.gaps.map((g) => (
              <div key={g.key} style={{ borderLeft: "3px solid var(--amber)", paddingLeft: 14 }}>
                <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 3 }}>
                  {g.headline}
                </div>
                <p style={{ lineHeight: 1.6 }}>{g.detail}</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        /*
         * Nothing was found, so nothing is claimed.
         *
         * This used to fill the space with a pitch about missed calls, which
         * asserted a problem this business may not have — and did it on the
         * one page where we had nothing to go on. Saying plainly that we have
         * not looked closely yet is both true and a better opening than a
         * guess dressed up as a diagnosis.
         */
        <p style={{ lineHeight: 1.65, marginBottom: 30, fontSize: "1.05rem" }}>
          We look at how customers find and reach local service businesses — the
          phone, the website, the search listing, the reviews — and fix whatever is
          quietly costing work. We have not been through {data.businessName} in
          detail yet.
        </p>
      )}

      {/* --------------------------- what we would do -------------------------- */}
      {data.recommendations.length > 0 && (
        <>
          <h2 style={{ marginBottom: 4 }}>What we&rsquo;d do about it</h2>
          <p className="faint" style={{ marginBottom: 14, lineHeight: 1.55 }}>
            One thing per finding above. Nothing here needs you to change your
            number or install anything.
          </p>
          <div style={{ display: "grid", gap: 16, marginBottom: 30 }}>
            {data.recommendations.map((r, i) => (
              <div key={r.key} style={{ display: "flex", gap: 12 }}>
                <div
                  aria-hidden
                  style={{
                    flex: "none",
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    border: "1px solid var(--amber)",
                    color: "var(--amber)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.8rem",
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: "1.02rem", marginBottom: 3 }}>
                    {r.title}
                  </div>
                  <p style={{ lineHeight: 1.6 }}>{r.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** No navigation, no admin chrome. A prospect sees this and nothing else. */
export function WorkshopShell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "48px 22px 80px" }}>{children}</main>
  );
}
