"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getToken, setToken } from "@/lib/api";
import { useEffect, useState } from "react";

const links = [
  { href: "/", label: "Businesses" },
  { href: "/import", label: "Import" },
];

export default function Nav() {
  const pathname = usePathname();
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(!!getToken());
  }, [pathname]);

  return (
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
          marginRight: 28,
          fontSize: "0.95rem",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
        }}
      >
        Enrichment Desk
      </span>
      {links.map((l) => {
        const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
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
              borderBottom: active ? "2px solid var(--amber)" : "2px solid transparent",
            }}
          >
            {l.label}
          </Link>
        );
      })}
      <div style={{ flex: 1 }} />
      {loggedIn && (
        <button
          className="btn-ghost"
          style={{ padding: "4px 12px" }}
          onClick={() => {
            setToken(null);
            window.location.href = "/";
          }}
        >
          Sign out
        </button>
      )}
    </nav>
  );
}
