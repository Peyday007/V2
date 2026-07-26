import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dialer",
};

/**
 * Caller app chrome. Deliberately contains NO links to the admin console —
 * callers see the dialer and nothing else: no board, no sourcing engine,
 * no campaign costs, no other callers' numbers.
 */
export default function CallerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
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
          }}
        />
        <span
          style={{
            fontWeight: 700,
            fontSize: "0.95rem",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
          }}
        >
          Dialer
        </span>
      </header>
      <main style={{ padding: "20px 24px" }}>{children}</main>
    </>
  );
}
