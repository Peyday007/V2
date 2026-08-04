"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Admin console only. The caller dialer lives at /dial with its own chrome
// and is intentionally NOT linked from here.
const links = [
  { href: "/", label: "Board" },
  { href: "/admin/sourcing", label: "Leads" },
  { href: "/admin/enrichment", label: "Enrichment" },
  // Analytics absorbed two neighbours. "Metrics" read one table and produced
  // counts this page already had with more rigour; "Targets" held the bar with
  // no number beside it. Splitting what-happened, is-that-good and what-should
  // -it-be across three pages meant holding two in your head to read the third.
  { href: "/admin/analytics", label: "Analytics" },
  // Follow-ups, Review and Appointments were three queues of work waiting on a
  // person. Finding out whether anything needed you cost three page loads, and
  // the honest answer was usually "no" three times — so the check stopped
  // happening. One page, one badge.
  { href: "/admin/queue", label: "Needs you" },
  { href: "/admin/learning", label: "Learning" },
  { href: "/admin/callers", label: "Callers" },
  { href: "/admin/timesheet", label: "Time" },
  { href: "/admin/campaigns", label: "Packets" },
  { href: "/admin/email", label: "Email" },
  { href: "/admin/import", label: "Import" },
  // No "Do Not Call" entry. The list was a page you looked at and never acted
  // on: suppression is enforced when a packet is built, topped up, imported,
  // handed to a caller and logged against — five places, none of which read
  // that page. The one thing it could uniquely do, adding a number by hand for
  // a request that did not arrive on a call, moved onto the Leads page.
  { href: "/admin/updates", label: "Updates" },
  { href: "/admin/prompts", label: "Prompts" },
  { href: "/admin/scripts", label: "Scripts" },
  { href: "/admin/recording", label: "Recording" },
  { href: "/admin/history", label: "History" },
];

export default function Nav({ protectedConsole }: { protectedConsole: boolean }) {
  const pathname = usePathname();
  const [waiting, setWaiting] = useState(0);

  /*
   * How much is waiting on a person, polled quietly.
   *
   * A minute is plenty — these are a handful of items a day — and a failure
   * leaves the badge at zero rather than putting an error in the navigation,
   * which is not a place anybody can act on one.
   */
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const res = await fetch("/api/queue/counts");
        const j = await res.json();
        if (live) setWaiting(Number(j?.total) || 0);
      } catch {
        /* a missing badge is better than a broken nav */
      }
    };
    read();
    const id = setInterval(read, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pathname]);
  return (
    <>
      {!protectedConsole && (
        <div
          style={{
            background: "var(--red)",
            color: "#fff",
            padding: "7px 24px",
            fontSize: "0.78rem",
            fontWeight: 700,
            letterSpacing: "0.04em",
          }}
        >
          Anyone with this link can see every page here, including your callers.
          Set ADMIN_PASSWORD in Vercel → Settings → Environment Variables, then
          redeploy.
        </div>
      )}
    {/*
      Wraps rather than overflowing.

      Seventeen links no longer fit on one line, and without this the nav forced
      the whole page wider than the window — so every admin page sat scrolled a
      little to the right, with "DISPATCH BOARD" chopped off at the left edge
      and the last link chopped off at the right. A navigation bar that pushes
      the page it navigates out of view is worse than a second row.
    */}
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        rowGap: 4,
        gap: 8,
        padding: "14px 24px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "var(--amber)",
          marginRight: 8,
        }}
      />
      <span
        style={{
          fontWeight: 700,
          color: "var(--text)",
          marginRight: 28,
          fontSize: "0.95rem",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
        }}
      >
        Dispatch Board
      </span>
      {links.map((l) => {
        const active =
          l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
        // The only nav item that carries a number. It is the one that answers
        // "does anything need me right now", and it is worth a glance rather
        // than a visit.
        const badge = l.href === "/admin/queue" && waiting > 0 ? waiting : null;
        return (
          <Link
            key={l.href}
            href={l.href}
            style={{
              padding: "6px 2px",
              marginRight: 10,
              color: active ? "var(--amber)" : "var(--text-dim)",
              fontWeight: 700,
              fontSize: "0.8rem",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              textDecoration: "none",
              borderBottom: active
                ? "2px solid var(--amber)"
                : "2px solid transparent",
            }}
          >
            {l.label}
            {badge !== null && (
              <span
                style={{
                  marginLeft: 5,
                  padding: "1px 5px",
                  borderRadius: 8,
                  background: "var(--amber)",
                  color: "var(--bg)",
                  fontSize: "0.68rem",
                }}
              >
                {badge}
              </span>
            )}
          </Link>
        );
      })}
      <div style={{ flex: 1 }} />
      {protectedConsole && (
        <button
          className="btn-ghost"
          style={{ padding: "4px 12px", fontSize: "0.7rem" }}
          onClick={async () => {
            await fetch("/api/admin/logout", { method: "POST" });
            window.location.href = "/admin-login";
          }}
        >
          Sign out
        </button>
      )}
    </nav>
    </>
  );
}
