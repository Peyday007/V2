"use client";

import { useCallback, useEffect, useState } from "react";
import FollowupsSection from "@/components/queue/FollowupsSection";
import ReviewSection from "@/components/queue/ReviewSection";
import AppointmentsSection from "@/components/queue/AppointmentsSection";

/*
 * Everything waiting on a person, in one place.
 *
 * This replaces three separate nav entries — Follow-ups, Review and
 * Appointments — that were each a queue of work nobody had done yet. To find
 * out whether anything needed you, you checked three pages, and the honest
 * answer most days was "no" on all three. So the check stopped happening, and
 * a callback promised on Tuesday sat there until somebody remembered it.
 *
 * The three are genuinely different kinds of work and the sections are kept
 * whole rather than blended into one list: a callback due at four o'clock and
 * an AI reading that could not be settled need different things from you, and
 * a merged list would sort them against each other as though they were
 * comparable. What is shared is the ANSWER TO THE QUESTION — is there anything
 * — and that now lives in one number on the nav.
 *
 * Each section still fetches its own data. They were working pages and there
 * was no reason to rewrite them; they lost their h1 and their width wrapper
 * and nothing else.
 */

type Counts = {
  callbacks: number;
  reviews: number;
  appointments: number;
  total: number;
  error: string | null;
};

const SECTIONS = [
  { key: "callbacks", label: "Callbacks due", hint: "Somebody said ring me back." },
  { key: "reviews", label: "Readings to settle", hint: "The AI could not decide on its own." },
  { key: "appointments", label: "Appointments to mark", hint: "Booked is not held." },
] as const;

export default function QueuePage() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/queue/counts");
      setCounts(await res.json());
    } catch {
      // The sections below fetch their own data and will show their own
      // errors. A failed count is a missing badge, not a broken page.
      setCounts(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /*
   * Opens on whichever section actually has work.
   *
   * A page that opens with everything collapsed makes you click three times to
   * learn there is nothing to do, which is the problem this page exists to
   * solve. With work in exactly one place it opens there; with work in several
   * it opens the first and shows the counts on the rest.
   */
  useEffect(() => {
    if (!counts || open !== null) return;
    const withWork = SECTIONS.filter((s) => counts[s.key] > 0);
    setOpen(withWork.length > 0 ? withWork[0].key : "");
  }, [counts, open]);

  const total = counts?.total ?? 0;

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Needs you</h1>
      <p className="faint" style={{ marginBottom: 20, lineHeight: 1.6 }}>
        {counts === null
          ? "Checking…"
          : total === 0
            ? "Nothing is waiting on you. Everything below is here so you can look, not because it needs you."
            : `${total} thing${total === 1 ? "" : "s"} waiting on you.`}{" "}
        These were three separate pages, which meant three checks to find out
        there was nothing to do — so the check stopped happening and a callback
        promised on Tuesday sat until somebody remembered it.
      </p>

      {counts?.error && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {counts.error}
        </div>
      )}

      {/* The summary strip: the whole point is that one glance answers it. */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        {SECTIONS.map((s) => {
          const n = counts?.[s.key] ?? 0;
          const isOpen = open === s.key;
          return (
            <button
              key={s.key}
              onClick={() => setOpen(isOpen ? "" : s.key)}
              title={s.hint}
              className="card"
              style={{
                flex: "1 1 200px",
                textAlign: "left",
                cursor: "pointer",
                borderColor: n > 0 ? "var(--amber)" : "var(--border)",
                borderLeft: isOpen ? "3px solid var(--amber)" : undefined,
                background: isOpen ? "var(--amber-soft)" : undefined,
              }}
            >
              <div
                style={{
                  fontSize: "1.6rem",
                  fontWeight: 700,
                  color: n > 0 ? "var(--amber)" : "var(--text-dim)",
                }}
              >
                {n}
              </div>
              <div style={{ fontWeight: 700, fontSize: "0.82rem" }}>{s.label}</div>
              <div className="faint" style={{ fontSize: "0.76rem", lineHeight: 1.4 }}>
                {s.hint}
              </div>
            </button>
          );
        })}
      </div>

      {open === "callbacks" && <FollowupsSection />}
      {open === "reviews" && <ReviewSection />}
      {open === "appointments" && <AppointmentsSection />}

      {open === "" && (
        <p className="muted" style={{ lineHeight: 1.6 }}>
          Pick one above to open it.
        </p>
      )}
    </div>
  );
}
