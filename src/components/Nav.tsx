"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin console only. The caller dialer lives at /dial with its own chrome
// and is intentionally NOT linked from here.
const links = [
  { href: "/", label: "Board" },
  { href: "/admin/sourcing", label: "Leads" },
  { href: "/metrics", label: "Metrics" },
  { href: "/admin/analytics", label: "Analytics" },
  { href: "/admin/followups", label: "Follow-ups" },
  { href: "/admin/appointments", label: "Appointments" },
  { href: "/admin/callers", label: "Callers" },
  { href: "/admin/targets", label: "Targets" },
  { href: "/admin/timesheet", label: "Time" },
  { href: "/admin/campaigns", label: "Packets" },
  { href: "/admin/import", label: "Import" },
  { href: "/admin/suppressions", label: "Do Not Call" },
  { href: "/admin/prompts", label: "Prompts" },
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
    <nav
      style={{
        display: "flex",
        alignItems: "center",
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
              marginRight: 18,
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
