"use client";

import { useEffect, useState } from "react";
import { getToken, setToken } from "@/lib/api";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export default function LoginGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setLoggedIn(!!getToken());
    setReady(true);
  }, []);

  async function login() {
    setError("");
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setError("Invalid credentials");
      return;
    }
    const j = await res.json();
    setToken(j.token);
    setLoggedIn(true);
  }

  if (!ready) return null;

  if (!loggedIn) {
    return (
      <div style={{ maxWidth: 340, margin: "80px auto" }}>
        <h1 style={{ marginBottom: 20, textAlign: "center" }}>Sign in</h1>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            placeholder="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
          {error && <p style={{ color: "var(--red)" }}>{error}</p>}
          <button className="btn" onClick={login} style={{ justifyContent: "center" }}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
