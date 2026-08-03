"use client";

import { use, useCallback, useEffect, useState } from "react";

// The page a business owner opens from a text message.
//
// The only screen in this application a member of the public ever sees, which
// changes what it has to be: no jargon, no internal vocabulary, readable on a
// phone in a van, and honest. It says only what the record actually supports —
// if there are no computable gaps, it shows none rather than filling the space.

type Gap = { key: string; headline: string; detail: string; basis: string };
type Recommendation = { key: string; title: string; detail: string; basis: string };

type Packet = {
  businessName: string;
  city: string | null;
  state: string | null;
  gaps: Gap[];
  recommendations: Recommendation[];
  contact: { name: string; phone: string; email: string };
  alreadyRequested: boolean;
  requestedAt: string | null;
};

const AGREEMENT = "I agree to a free 7-day trial, no cost, cancel anytime";

export default function WorkshopPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Packet | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workshop/${token}`);
      if (res.status === 404) {
        setState("gone");
        return;
      }
      if (!res.ok) {
        setState("error");
        return;
      }
      const j: Packet = await res.json();
      setData(j);
      setForm({ name: j.contact.name, phone: j.contact.phone, email: j.contact.email });
      setDone(j.alreadyRequested);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/workshop/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, agreed, agreement_text: AGREEMENT }),
    });
    const j = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(j.error || "Something went wrong. Please try again.");
      return;
    }
    setDone(true);
  }

  if (state === "loading") {
    return <Shell><p className="muted">Loading…</p></Shell>;
  }

  // Not found and expired read the same on purpose — telling them apart would
  // let somebody test guessed tokens against this page.
  if (state === "gone") {
    return (
      <Shell>
        <h1 style={{ marginBottom: 10 }}>This link is no longer active</h1>
        <p style={{ lineHeight: 1.6, fontSize: "1.05rem" }}>
          Links expire and get replaced. If somebody from our team sent you this,
          give them a ring back and they will send a fresh one.
        </p>
      </Shell>
    );
  }

  if (state === "error" || !data) {
    return (
      <Shell>
        <h1 style={{ marginBottom: 10 }}>We cannot load this right now</h1>
        <p style={{ lineHeight: 1.6, fontSize: "1.05rem" }}>
          Something on our end is having a moment. Please try again in a few minutes.
        </p>
      </Shell>
    );
  }

  const where = [data.city, data.state].filter(Boolean).join(", ");

  if (done) {
    return (
      <Shell>
        <div
          style={{
            border: "1px solid var(--amber)",
            background: "var(--amber-soft)",
            borderRadius: 6,
            padding: "26px 24px",
          }}
        >
          <h1 style={{ marginBottom: 10, color: "var(--amber)" }}>You&rsquo;re booked in</h1>
          <p style={{ lineHeight: 1.65, fontSize: "1.05rem" }}>
            Thanks{form.name ? `, ${form.name.split(" ")[0]}` : ""}. Somebody from
            our team will call you to get {data.businessName} switched on. There
            is nothing to pay and nothing to set up before then.
          </p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
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
              <div
                key={g.key}
                style={{
                  borderLeft: "3px solid var(--amber)",
                  paddingLeft: 14,
                }}
              >
                <div style={{ fontWeight: 700, fontSize: "1.05rem", marginBottom: 3 }}>
                  {g.headline}
                </div>
                <p style={{ lineHeight: 1.6 }}>{g.detail}</p>
              </div>
            ))}
          </div>
        </>
      ) : (
        // No fabricated bullets. The offer stands on its own.
        <p style={{ lineHeight: 1.65, marginBottom: 30, fontSize: "1.05rem" }}>
          We help local service businesses stop losing work to missed calls — the
          ones that come in after hours, at the weekend, or while you are already
          on a job.
        </p>
      )}

      {/* --------------------------- what we would do -------------------------- */}
      {data.recommendations.length > 0 && (
        <>
          <h2 style={{ marginBottom: 4 }}>What we&rsquo;d set up for you</h2>
          <p className="faint" style={{ marginBottom: 14, lineHeight: 1.55 }}>
            All of it runs on your existing number. Nothing to install.
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

      {/* -------------------------------- the CTA ----------------------------- */}
      {!showForm ? (
        <button
          className="btn"
          onClick={() => setShowForm(true)}
          style={{ fontSize: "1.05rem", padding: "14px 26px" }}
        >
          Start my free 7-day trial
        </button>
      ) : (
        <div
          style={{
            border: "1px solid var(--border-strong)",
            borderRadius: 6,
            padding: "20px 22px",
            maxWidth: 460,
          }}
        >
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>Start the trial</h2>
          <p className="faint" style={{ marginBottom: 16, lineHeight: 1.55 }}>
            We will call you to switch it on. Nothing is charged and there is no
            card to enter.
          </p>
          <div style={{ display: "grid", gap: 10 }}>
            <input
              placeholder="Your name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              autoComplete="name"
            />
            <input
              placeholder="Best phone number"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              inputMode="tel"
              autoComplete="tel"
            />
            <input
              placeholder="Email (optional)"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              inputMode="email"
              autoComplete="email"
            />
            <label
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                lineHeight: 1.5,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                style={{ width: "auto", marginTop: 3 }}
              />
              <span>{AGREEMENT}</span>
            </label>
          </div>
          {error && (
            <p style={{ color: "var(--red)", marginTop: 12, lineHeight: 1.5 }}>{error}</p>
          )}
          <button
            className="btn"
            onClick={submit}
            disabled={saving || !agreed || !form.name.trim() || !form.phone.trim()}
            style={{ marginTop: 16, fontSize: "1rem", padding: "12px 22px" }}
          >
            {saving ? "One moment…" : "Start my free trial"}
          </button>
        </div>
      )}
    </Shell>
  );
}

/** No navigation, no admin chrome. A prospect sees this and nothing else. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main
      style={{
        maxWidth: 680,
        margin: "0 auto",
        padding: "48px 22px 80px",
      }}
    >
      {children}
    </main>
  );
}
