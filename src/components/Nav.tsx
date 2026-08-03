"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin console only. The caller dialer lives at /dial with its own chrome
// and is intentionally NOT linked from here.
const links = [
  { href: "/", label: "Board" },
  { href: "/admin/sourcing", label: "Leads" },
  { href: "/admin/enrichment", label: "Enrichment" },
  { href: "/metrics", label: "Metrics" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/followups", label: "Follow-ups" },
  { href: "/admin/review", label: "Review" },
  { href: "/admin/learning", label: "Learning" },
  { href: "/admin/appointments", label: "Appointments" },
  { href: "/admin/callers", label: "Callers" },
  { href: "/admin/targets", label: "Targets" },
  { href: "/admin/timesheet", label: "Time" },
  { href: "/admin/campaigns", label: "Packets" },
  { href: "/admin/import", label: "Import" },
  { href: "/admin/suppressions", label: "Do Not Call" },
  { href: "/admin/prompts", label: "Prompts" },
  { href: "/admin/scripts", label: "Scripts" },
  { href: "/admin/recording", label: "Recording" },
  { href: "/admin/history", label: "History" },
];

export default function Nav({ protectedConsole }: { protectedConsole: boolean }) {
  const pathname = usePathname();
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
