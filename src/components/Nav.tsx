"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Board" },
  { href: "/dial", label: "Dial" },
  { href: "/metrics", label: "Metrics" },
  { href: "/admin/campaigns", label: "Campaigns" },
  { href: "/admin/callers", label: "Callers" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "12px 24px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-raised)",
      }}
    >
      <span
        style={{
          fontWeight: 700,
          color: "var(--amber)",
          marginRight: 20,
          fontSize: "1.05rem",
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
              padding: "6px 12px",
              borderRadius: 6,
              color: active ? "var(--amber)" : "var(--text-dim)",
              background: active ? "var(--amber-soft)" : "transparent",
              fontWeight: active ? 600 : 500,
              textDecoration: "none",
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
