"use client";

import { use, useCallback, useEffect, useState } from "react";
import {
  WorkshopBody,
  WorkshopShell as Shell,
  AGREEMENT,
  type WorkshopPacket as Packet,
} from "@/components/WorkshopView";

// The page a business owner opens from a text message.
//
// The only screen in this application a member of the public ever sees, which
// changes what it has to be: no jargon, no internal vocabulary, readable on a
// phone in a van, and honest. It says only what the record actually supports —
// if there are no computable gaps, it shows none rather than filling the space.

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
      <WorkshopBody data={data} />

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
