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
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: "0.68rem",
            color: "var(--text-faint)",
            letterSpacing: "0.05em",
          }}
          title="Deployed commit — quote this if something looks out of date"
        >
          build {(process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7)}
        </span>
      </header>
      <main style={{ padding: "20px 24px" }}>{children}</main>
    </>
  );
}
