"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function AdminLoginPage() {
  return (
    <Suspense fallback={null}>
      <AdminLogin />
    </Suspense>
  );
}

function AdminLogin() {
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Could not sign in.");
      setBusy(false);
      return;
    }
    // A full navigation, so middleware sees the new cookie.
    window.location.href = next;
  }

  return (
    <div style={{ maxWidth: 380, margin: "90px auto", textAlign: "center" }}>
      <div
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "var(--amber)",
          margin: "0 auto 18px",
        }}
      />
      <h1 style={{ marginBottom: 8 }}>Dispatch Board</h1>
      <p className="muted" style={{ marginBottom: 22 }}>
        Enter the admin passphrase
      </p>

      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && password && submit()}
        placeholder="Passphrase"
        autoFocus
        style={{ textAlign: "center", marginBottom: 12, width: "100%" }}
      />

      {error && (
        <p style={{ color: "var(--red)", marginBottom: 12, fontSize: "0.85rem" }}>
          {error}
        </p>
      )}

      <button
        className="btn"
        onClick={submit}
        disabled={busy || !password}
        style={{ width: "100%", justifyContent: "center" }}
      >
        {busy ? "Checking…" : "Sign in"}
      </button>

      <p className="faint" style={{ marginTop: 24, lineHeight: 1.6 }}>
        Callers do not need this. They go to <strong>/dial</strong> and sign in
        with their 6-digit PIN.
      </p>
    </div>
  );
}
