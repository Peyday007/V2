"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AREA_ORDER,
  AREA_PROMPT,
  AUDIT_INTRO,
  BAND_LABEL,
  PROVENANCE_HEADINGS,
  type BottleneckArea,
  type MappedOpportunity,
} from "@/lib/bottleneckAudit";
import { CONFIDENCE_LABEL, SOURCE_LABEL, STAGE_LABEL } from "@/lib/opportunityModel";

// The only screen a member of the public ever sees.
//
// WHAT THIS REPLACED. One long scrolling packet that opened with a product —
// an AI receptionist, a website, an SEO score — and read, however accurate its
// numbers, as a template with a business name dropped into it.
//
// This is a guided assessment instead. It opens with the business, names one
// constraint and two supporting ones, and lets an owner go as deep as they want
// on any of them without forcing the detail on everybody. A product appears
// only underneath a finding, as one of several possible answers to it.
//
// The four things it is built to produce, in order: one "they actually looked
// at us", two "I had not thought about that", one "they might know how to fix
// this", and one next step that costs nothing to take.

export type PublicOpportunity = {
  id: string;
  stage: string;
  title: string;
  summary: string;
  evidence: string;
  sourceType: keyof typeof SOURCE_LABEL;
  sourceDetail: string | null;
  observedAt: string;
  knownFacts: string[];
  inferences: string[];
  needsConfirmation: string[];
  wouldVerifyNext: string[];
  confidence: keyof typeof CONFIDENCE_LABEL;
  potentialEffect: string | null;
  demonstrable: boolean;
  demoLabel: string | null;
  solutionDirections: string[];
  priority: string;
};

export type Assessment = {
  businessName: string;
  market: string;
  researchedLine: string;
  headline: string;
  variant: string;
  config: {
    summaryFindings: number;
    evidenceInline: boolean;
    layout: string;
    ctaPosition: string;
    headline: string;
  };
  primary: PublicOpportunity | null;
  supporting: PublicOpportunity[];
  contact: { name: string; email: string; phone: string };
  status: string;
  alreadyInterested: boolean;
  bottleneck: { area: BottleneckArea; detail?: string | null; frequency?: string | null; affects?: string | null }[];
  auditComplete: boolean;
  map: MappedOpportunity[];
};

/**
 * The one broader-capability line.
 *
 * Restrained on purpose, and placed after a specific matched example rather
 * than before it. A list of everything we build, shown first, is a catalogue —
 * which is what this whole rebuild exists to stop being.
 */
export const CAPABILITY_LINE =
  "This is one example. We build around the constraint we find — customer intake, " +
  "follow-up, reputation, research, operations, financial visibility, or another " +
  "part of the business.";

type Section = "summary" | "finding" | "preview" | "audit" | "map" | "next";

const TABS: { id: Section; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "audit", label: "Your side" },
  { id: "map", label: "Opportunity map" },
  { id: "next", label: "Next step" },
];

/* -------------------------------------------------------------------------- */

export function WorkshopMiniSite({ token, data }: { token: string; data: Assessment }) {
  const [section, setSection] = useState<Section>("summary");
  const [openFinding, setOpenFinding] = useState<PublicOpportunity | null>(null);
  const [answers, setAnswers] = useState<Record<string, { detail: string; frequency: string; affects: string }>>(
    () => {
      const seed: Record<string, { detail: string; frequency: string; affects: string }> = {};
      for (const a of data.bottleneck) {
        seed[a.area] = {
          detail: a.detail ?? "",
          frequency: a.frequency ?? "",
          affects: a.affects ?? "",
        };
      }
      return seed;
    }
  );
  const [map, setMap] = useState<MappedOpportunity[]>(data.map);
  const [interested, setInterested] = useState(data.alreadyInterested);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  /*
   * ADMIN PREVIEW. The operator opens the prospect's real page to check it,
   * with ?preview=1 on the URL. Every event carries the flag so the server
   * records it separately and excludes it from engagement, interest and
   * conversion. Without this, checking a page would look exactly like the
   * prospect reading it, and every number an operator relies on would count
   * their own visits.
   */
  const isPreview =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("preview") === "1";

  const post = useCallback(
    async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/workshop/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, preview: isPreview }),
      });
      return res.ok ? res.json() : null;
    },
    [token, isPreview]
  );

  const track = useCallback(
    (event: string, target?: string) => {
      void post({ action: "track", event, target });
    },
    [post]
  );

  useEffect(() => {
    track("workshop.opened");
    track("workshop.summary_viewed", "summary");
    // Once per mount. The idempotency key on the server makes repeats free.
  }, [track]);

  const all = [data.primary, ...data.supporting].filter(Boolean) as PublicOpportunity[];

  function go(next: Section) {
    setSection(next);
    if (next === "map") track("workshop.map_viewed", "map");
    if (next === "preview") track("workshop.preview_viewed", openFinding?.id ?? "preview");
    if (next === "audit") track("workshop.audit_started", "audit");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------------------------------------------------------------- */

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 64px" }}>
      <header style={{ marginBottom: 20 }}>
        <div className="faint" style={{ fontSize: "0.8rem", letterSpacing: "0.08em" }}>
          NORTHVALE — BUSINESS ASSESSMENT
        </div>
        <h1 style={{ margin: "6px 0 4px", lineHeight: 1.2 }}>{data.businessName}</h1>
        {data.market && <div className="faint">{data.market}</div>}
      </header>

      <nav
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 22,
          borderBottom: "1px solid var(--border)",
          paddingBottom: 10,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => go(t.id)}
            className="btn-ghost"
            aria-current={section === t.id ? "page" : undefined}
            style={{
              fontSize: "0.9rem",
              padding: "6px 10px",
              borderBottom:
                section === t.id ? "2px solid var(--amber)" : "2px solid transparent",
              color: section === t.id ? "var(--amber)" : undefined,
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {notice && (
        <div className="card" style={{ marginBottom: 18, borderColor: "var(--amber)", lineHeight: 1.6 }}>
          {notice}
        </div>
      )}

      {/* ------------------------------ summary ------------------------------ */}
      {section === "summary" && (
        <section>
          <p style={{ lineHeight: 1.7, fontSize: "1.05rem" }}>{data.researchedLine}</p>
          <h2 style={{ marginTop: 22 }}>{data.headline}</h2>

          {all.length === 0 && (
            <p className="faint" style={{ lineHeight: 1.7 }}>
              We could not find enough publicly to say anything useful yet — which is an
              honest answer rather than a filled page. The questionnaire under
              &ldquo;Your side&rdquo; is the fastest way for us to help.
            </p>
          )}

          {all.map((o, i) => (
            <article
              key={o.id}
              className="card"
              style={{
                marginBottom: 14,
                borderColor: i === 0 ? "var(--amber)" : "var(--border)",
              }}
            >
              <div className="faint" style={{ fontSize: "0.78rem", letterSpacing: "0.06em" }}>
                {i === 0 ? "THE MAIN ONE" : "ALSO WORTH KNOWING"} · {STAGE_LABEL[o.stage as keyof typeof STAGE_LABEL] ?? o.stage}
              </div>
              <h3 style={{ margin: "6px 0 8px" }}>{o.title}</h3>
              <p style={{ lineHeight: 1.7, marginTop: 0 }}>{o.summary}</p>

              {data.config.evidenceInline && (
                <p className="faint" style={{ lineHeight: 1.6, fontSize: "0.9rem" }}>
                  {SOURCE_LABEL[o.sourceType] ?? "Public sources"} ·{" "}
                  {new Date(o.observedAt).toLocaleDateString()}
                </p>
              )}

              <div className="faint" style={{ fontSize: "0.85rem", marginBottom: 10 }}>
                {CONFIDENCE_LABEL[o.confidence]}
              </div>

              <button
                className="btn-ghost"
                onClick={() => {
                  setOpenFinding(o);
                  track("workshop.finding_viewed", o.id);
                  setSection("finding");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              >
                See what we looked at
              </button>
            </article>
          ))}

          <InterestBlock
            data={data}
            interested={interested}
            busy={busy}
            onInterested={async (form) => {
              setBusy(true);
              const j = await post({ action: "interested", ...form });
              setBusy(false);
              if (j?.ok) {
                setInterested(true);
                setNotice(j.message);
                go("next");
              }
            }}
          />
        </section>
      )}

      {/* --------------------------- finding detail -------------------------- */}
      {section === "finding" && openFinding && (
        <FindingDetail
          o={openFinding}
          onBack={() => go("summary")}
          onEvidence={() => track("workshop.evidence_expanded", openFinding.id)}
          onPreview={() => {
            setSection("preview");
            track("workshop.preview_viewed", openFinding.id);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      )}

      {/* --------------------------- private preview ------------------------- */}
      {section === "preview" && (
        <section>
          <button className="btn-ghost" onClick={() => go("summary")} style={{ marginBottom: 14 }}>
            ← Back to the summary
          </button>
          <h2 style={{ marginTop: 0 }}>What we could put together, privately</h2>
          <p style={{ lineHeight: 1.7 }}>
            Built on your own public details, on our side. Nothing connects to your systems
            and nothing in your business changes.
          </p>
          <div className="card" style={{ borderColor: "var(--amber)" }}>
            <h3 style={{ marginTop: 0 }}>
              {openFinding?.demoLabel ?? all[0]?.demoLabel ?? "A worked example for your business"}
            </h3>
            <p className="faint" style={{ lineHeight: 1.7 }}>
              Matched to{" "}
              {openFinding?.title ?? all[0]?.title ?? "the main thing we found"} — not a
              generic demonstration.
            </p>
          </div>
          <p className="faint" style={{ lineHeight: 1.7, marginTop: 16 }}>
            {CAPABILITY_LINE}
          </p>
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const j = await post({
                action: "request_private_example",
                target: openFinding?.id ?? null,
              });
              setBusy(false);
              if (j?.ok) {
                setNotice("We will build that and send it over. Nothing changes on your side.");
                go("next");
              }
            }}
          >
            Build me a private example
          </button>
        </section>
      )}

      {/* ------------------------------- audit ------------------------------- */}
      {section === "audit" && (
        <BottleneckAudit
          answers={answers}
          busy={busy}
          onChange={(area, patch) => {
            setAnswers((prev) => {
              const blank = { detail: "", frequency: "", affects: "" };
              const merged = { ...blank, ...(prev[area] ?? blank), ...patch };
              const next = { ...prev, [area]: merged };
              // Saved as it is typed, so a refresh loses nothing.
              void post({ action: "save_answer", area, ...next[area] });
              return next;
            });
          }}
          onSubmit={async () => {
            setBusy(true);
            const j = await post({ action: "complete_audit" });
            setBusy(false);
            if (j?.ok) {
              setMap(j.map ?? []);
              if (j.recoverable) {
                setNotice(
                  "Your answers are saved, but we could not build the map just now. Try again in a moment — nothing you typed is lost."
                );
              } else {
                go("map");
              }
            }
          }}
        />
      )}

      {/* -------------------------------- map -------------------------------- */}
      {section === "map" && (
        <OpportunityMapView
          map={map}
          hasAudit={data.auditComplete || map.length > 0}
          onAudit={() => go("audit")}
          onTalk={() => go("next")}
          onBuild={async () => {
            setBusy(true);
            const j = await post({ action: "request_private_example", target: "map" });
            setBusy(false);
            if (j?.ok) {
              setNotice("We will build that and send it over.");
              go("next");
            }
          }}
        />
      )}

      {/* ------------------------------- next -------------------------------- */}
      {section === "next" && (
        <NextSteps
          interested={interested}
          busy={busy}
          onWalkthrough={async (kind) => {
            setBusy(true);
            const j = await post({ action: "request_walkthrough", kind, ...data.contact });
            setBusy(false);
            if (j?.ok) setNotice(j.message);
          }}
          onExplore={() => go("summary")}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* finding detail                                                             */
/* -------------------------------------------------------------------------- */

function FindingDetail({
  o,
  onBack,
  onEvidence,
  onPreview,
}: {
  o: PublicOpportunity;
  onBack: () => void;
  onEvidence: () => void;
  onPreview: () => void;
}) {
  return (
    <section>
      <button className="btn-ghost" onClick={onBack} style={{ marginBottom: 14 }}>
        ← Back to the summary
      </button>
      <div className="faint" style={{ fontSize: "0.78rem", letterSpacing: "0.06em" }}>
        {STAGE_LABEL[o.stage as keyof typeof STAGE_LABEL] ?? o.stage}
      </div>
      <h2 style={{ marginTop: 6 }}>{o.title}</h2>
      <p style={{ lineHeight: 1.7, fontSize: "1.03rem" }}>{o.summary}</p>

      {/*
        THE FOUR HEADINGS THAT KEEP THIS HONEST.

        Separated deliberately, and in this order. An owner is owed the
        difference between what we saw, what we are reading into it, what only
        they can confirm, and what we would go and check. Blending them is how
        an inference becomes, three paragraphs later, something we appear to
        have measured.
      */}
      <Block title="What we observed">
        <p style={{ lineHeight: 1.7, marginTop: 0 }}>{o.evidence}</p>
        <p className="faint" style={{ lineHeight: 1.6, fontSize: "0.9rem" }}>
          {SOURCE_LABEL[o.sourceType] ?? "Public sources"}
          {o.sourceDetail ? ` · ${o.sourceDetail}` : ""} · looked at{" "}
          {new Date(o.observedAt).toLocaleDateString()}
        </p>
      </Block>

      {o.knownFacts.length > 0 && (
        <Block title="What we know">
          <List items={o.knownFacts} />
        </Block>
      )}

      {o.inferences.length > 0 && (
        <Block title="What we are inferring — not the same thing">
          <List items={o.inferences} />
        </Block>
      )}

      {o.needsConfirmation.length > 0 && (
        <Block title="What only you can confirm">
          <List items={o.needsConfirmation} />
        </Block>
      )}

      {o.wouldVerifyNext.length > 0 && (
        <Block title="What we would check next">
          <List items={o.wouldVerifyNext} />
        </Block>
      )}

      <details onToggle={onEvidence} style={{ marginTop: 14 }}>
        <summary style={{ cursor: "pointer" }} className="faint">
          How sure are you about this?
        </summary>
        <p className="faint" style={{ lineHeight: 1.7 }}>
          {CONFIDENCE_LABEL[o.confidence]}. Everything above comes from what is public about
          your business. We would need your own numbers before putting a figure on any of it —
          and we would rather say that than invent one.
        </p>
      </details>

      {o.solutionDirections.length > 0 && (
        <Block title="Ways this tends to get fixed">
          <List items={o.solutionDirections} />
          <p className="faint" style={{ lineHeight: 1.6, fontSize: "0.9rem" }}>
            Which of these is right depends on how your business actually runs — that is a
            conversation, not something we would decide from the outside.
          </p>
        </Block>
      )}

      {o.demonstrable && (
        <div style={{ marginTop: 18 }}>
          <button className="btn" onClick={onPreview}>
            Show me what that would look like
          </button>
          <p className="faint" style={{ lineHeight: 1.6, marginTop: 8 }}>
            Built on our side from public information. Nothing touches your systems.
          </p>
        </div>
      )}
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ marginBottom: 6, fontSize: "1rem" }}>{title}</h3>
      {children}
    </div>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul style={{ lineHeight: 1.7, marginTop: 0, paddingLeft: 20 }}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* interest                                                                   */
/* -------------------------------------------------------------------------- */

export const INTEREST_CTA = "I'm interested in seeing more";

function InterestBlock({
  data,
  interested,
  busy,
  onInterested,
}: {
  data: Assessment;
  interested: boolean;
  busy: boolean;
  onInterested: (form: { name: string; email: string; phone: string; preferred: string }) => void;
}) {
  const known = !!(data.contact.email || data.contact.phone);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: data.contact.name,
    email: data.contact.email,
    phone: data.contact.phone,
    preferred: data.contact.email ? "email" : "phone",
  });

  if (interested) {
    return (
      <div className="card" style={{ marginTop: 22, borderColor: "var(--amber)" }}>
        <h3 style={{ marginTop: 0 }}>Thanks — we have that</h3>
        <p style={{ lineHeight: 1.7 }}>
          We will put together the private example and get back to you. Nothing in your
          business changes unless you explicitly ask us to.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 22 }}>
      {/*
        WHAT THIS BUTTON IS NOT.

        It replaced "Start my free 7-day trial", which made pressing it look
        like starting something. It does not start anything. It records that
        somebody would like to see more, and a person reads that. Access,
        permission to change a live system, and a paid engagement are three
        further steps, each asked for separately.
      */}
      {!open ? (
        <>
          <button className="btn" onClick={() => setOpen(true)} disabled={busy}>
            {INTEREST_CTA}
          </button>
          <p className="faint" style={{ lineHeight: 1.6, marginTop: 10, marginBottom: 0 }}>
            This does not start a trial, buy anything, or give us access to your systems. It
            tells us you would like to see more.
          </p>
        </>
      ) : (
        <>
          <h3 style={{ marginTop: 0 }}>Where should we send it?</h3>
          {known ? (
            <p className="faint" style={{ lineHeight: 1.6 }}>
              We already have your details — change anything below if it is wrong.
            </p>
          ) : null}
          <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
            <input
              placeholder="Your name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <input
              placeholder="Email"
              inputMode="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <input
              placeholder="Mobile"
              inputMode="tel"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
            <label className="faint">
              Best way to reach you{" "}
              <select
                value={form.preferred}
                onChange={(e) => setForm({ ...form, preferred: e.target.value })}
              >
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="text">Text</option>
              </select>
            </label>
          </div>
          {/*
            Consent, stated plainly and NOT pre-ticked. There is no checkbox
            here at all: submitting the form with your own contact details is
            the consent, and the sentence says exactly what it is for.
          */}
          <p className="faint" style={{ lineHeight: 1.6 }}>
            By sending this you are asking us to contact you about what we found. We will not
            add you to a mailing list, and nothing in your business changes without you
            explicitly asking.
          </p>
          <button className="btn" disabled={busy} onClick={() => onInterested(form)}>
            {busy ? "Sending…" : INTEREST_CTA}
          </button>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* bottleneck audit                                                           */
/* -------------------------------------------------------------------------- */

function BottleneckAudit({
  answers,
  busy,
  onChange,
  onSubmit,
}: {
  answers: Record<string, { detail: string; frequency: string; affects: string }>;
  busy: boolean;
  onChange: (area: BottleneckArea, patch: Partial<{ detail: string; frequency: string; affects: string }>) => void;
  onSubmit: () => void;
}) {
  const chosen = Object.keys(answers);
  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Your side of it</h2>
      <p style={{ lineHeight: 1.7 }}>{AUDIT_INTRO}</p>

      <div style={{ display: "grid", gap: 8, marginTop: 18 }}>
        {AREA_ORDER.map((area) => {
          const on = area in answers;
          return (
            <div key={area} className="card" style={{ padding: on ? 14 : 10 }}>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onChange(area, {})}
                  style={{ marginTop: 4 }}
                />
                <span style={{ lineHeight: 1.5 }}>{AREA_PROMPT[area]}</span>
              </label>

              {on && (
                <div style={{ display: "grid", gap: 8, marginTop: 10, paddingLeft: 28 }}>
                  <input
                    placeholder="What happens?"
                    value={answers[area]?.detail ?? ""}
                    onChange={(e) => onChange(area, { detail: e.target.value })}
                  />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <label className="faint">
                      How often{" "}
                      <select
                        value={answers[area]?.frequency ?? ""}
                        onChange={(e) => onChange(area, { frequency: e.target.value })}
                      >
                        <option value="">—</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="occasionally">Occasionally</option>
                        <option value="unsure">Not sure</option>
                      </select>
                    </label>
                    <label className="faint">
                      Affects most{" "}
                      <select
                        value={answers[area]?.affects ?? ""}
                        onChange={(e) => onChange(area, { affects: e.target.value })}
                      >
                        <option value="">—</option>
                        <option value="revenue">Revenue</option>
                        <option value="time">Time</option>
                        <option value="customers">Customers</option>
                        <option value="employees">Employees</option>
                        <option value="costs">Costs</option>
                        <option value="visibility">Visibility</option>
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="faint" style={{ lineHeight: 1.6, marginTop: 14 }}>
        Your answers save as you go — if you close this and come back, they will still be here.
      </p>

      <button className="btn" disabled={busy || chosen.length === 0} onClick={onSubmit}>
        {busy ? "Working…" : "Show me the opportunity map"}
      </button>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* opportunity map                                                            */
/* -------------------------------------------------------------------------- */

const BAND_ORDER: (keyof typeof BAND_LABEL)[] = ["fix_first", "quick_win", "investigate_next"];

function OpportunityMapView({
  map,
  hasAudit,
  onAudit,
  onTalk,
  onBuild,
}: {
  map: MappedOpportunity[];
  hasAudit: boolean;
  onAudit: () => void;
  onTalk: () => void;
  onBuild: () => void;
}) {
  if (!hasAudit || map.length === 0) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Opportunity map</h2>
        <p style={{ lineHeight: 1.7 }}>
          Fill in the short questionnaire and we will map what you tell us against what we
          found from the outside.
        </p>
        <button className="btn" onClick={onAudit}>
          Go to the questionnaire
        </button>
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Opportunity map</h2>
      {/*
        NOT AN AUDIT, AND IT SAYS SO. An audit implies we checked. We did not
        check — we asked, and the owner told us. Calling it a definitive audit
        before anything internal is verified would be the same overreach this
        rebuild removed everywhere else.
      */}
      <p className="faint" style={{ lineHeight: 1.7 }}>
        Built from what you just told us, alongside what we could see publicly. It is a map of
        where to look, not a verified audit — none of it is confirmed until we have seen the
        real numbers with you.
      </p>

      {BAND_ORDER.map((band) => {
        const items = map.filter((m) => m.band === band);
        if (items.length === 0) return null;
        return (
          <div key={band} style={{ marginTop: 20 }}>
            <h3 style={{ marginBottom: 8 }}>{BAND_LABEL[band]}</h3>
            {items.map((m) => (
              <article key={m.area} className="card" style={{ marginBottom: 12 }}>
                <h4 style={{ marginTop: 0, marginBottom: 8 }}>{m.heading}</h4>

                <Small label={PROVENANCE_HEADINGS.reported}>
                  {m.reported.detail || "You flagged this area."}
                  {m.reported.frequency ? ` · ${m.reported.frequency}` : ""}
                  {m.reported.affects ? ` · affects ${m.reported.affects}` : ""}
                </Small>

                <Small label="What may be causing it">{m.possibleCauses.join(" · ")}</Small>
                <Small label="Where value may be leaking">{m.whereValueLeaks}</Small>
                <Small label={PROVENANCE_HEADINGS.unverified}>{m.toVerify.join(" · ")}</Small>
                <Small label="Ways it tends to get fixed">{m.solutionDirections.join(" · ")}</Small>
                {m.canDemonstrate && (
                  <Small label="What we could show you privately">{m.canDemonstrate}</Small>
                )}
                <Small label="What this would need from you">
                  {m.needsPermission
                    ? "Access to one of your systems, with your permission, before anything could be built."
                    : "Nothing — we can put an example together from public information."}
                </Small>
                <Small label="Effort and timing">
                  {m.difficulty} effort · first visible result in {m.timeToSignal.toLowerCase()} ·{" "}
                  confidence {m.confidence}
                </Small>
              </article>
            ))}
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
        <button className="btn" onClick={onBuild}>
          Build me a private example
        </button>
        <button className="btn-ghost" onClick={onTalk}>
          Talk through this with me
        </button>
      </div>
    </section>
  );
}

function Small({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div className="faint" style={{ fontSize: "0.75rem", letterSpacing: "0.05em" }}>
        {label.toUpperCase()}
      </div>
      <div style={{ lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* next steps                                                                 */
/* -------------------------------------------------------------------------- */

function NextSteps({
  interested,
  busy,
  onWalkthrough,
  onExplore,
}: {
  interested: boolean;
  busy: boolean;
  onWalkthrough: (kind: "phone" | "video" | "recorded") => void;
  onExplore: () => void;
}) {
  return (
    <section>
      <h2 style={{ marginTop: 0 }}>What happens next</h2>
      <ul style={{ lineHeight: 1.8, paddingLeft: 20 }}>
        <li>We put together the personalised example and send you a private link.</li>
        <li>
          <strong>Nothing in your live business changes</strong> — no systems touched, no
          settings altered, no messages sent to your customers — unless you explicitly ask.
        </li>
        <li>You can look through it on your own, or have somebody walk you through it.</li>
      </ul>

      <h3 style={{ marginTop: 22 }}>However suits you</h3>
      <div style={{ display: "grid", gap: 10 }}>
        <button className="btn-ghost" disabled={busy} onClick={() => onWalkthrough("phone")}>
          Schedule a phone call
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => onWalkthrough("video")}>
          Schedule a video call
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => onWalkthrough("recorded")}>
          Send me a recorded walkthrough — nothing to attend
        </button>
        <button className="btn-ghost" onClick={onExplore}>
          I would rather keep looking on my own
        </button>
      </div>

      {!interested && (
        <p className="faint" style={{ lineHeight: 1.6, marginTop: 16 }}>
          Asking for a walkthrough does not commit you to anything either.
        </p>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */

export function WorkshopShell({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}
