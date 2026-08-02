"use client";

import { useCallback, useEffect, useState } from "react";
import type { MetricDef, SuggestedTarget, Target } from "@/lib/benchmarks";

type Payload = {
  metrics: MetricDef[];
  targets: Target[];
  missing: MetricDef[];
  suggested: SuggestedTarget[];
  suggestedSource: string;
  error: string | null;
};

export default function TargetsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [seeding, setSeeding] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/targets");
      const j = await res.json();
      // Defaults, not assumptions. A page whose job is to report a problem
      // must not be the thing that breaks when the payload is short.
      setData({
        metrics: j.metrics ?? [],
        targets: j.targets ?? [],
        missing: j.missing ?? [],
        suggested: j.suggested ?? [],
        suggestedSource: j.suggestedSource ?? "",
        error: j.error ?? null,
      });
      setErr(j.error ?? "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setData({ metrics: [], targets: [], missing: [], suggested: [], suggestedSource: "", error: msg });
      setErr(msg);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function useSuggested() {
    setSeeding(true);
    const res = await fetch("/api/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "use_suggested" }),
    });
    const j = await res.json();
    setSeeding(false);
    if (!res.ok) {
      setErr(j.error || "Could not set those.");
      return;
    }
    setMsg(
      j.added === 0
        ? "Every metric already has a target — nothing was overwritten."
        : `Filled in ${j.added} starting ${j.added === 1 ? "target" : "targets"}. They are marked as borrowed until you replace them.`
    );
    load();
  }

  if (!data) return <p className="muted">Loading…</p>;

  const byMetric = new Map(data.targets.map((t) => [t.metric, t]));
  const suggestedBy = new Map((data.suggested || []).map((s) => [s.metric, s]));
  const borrowedCount = data.targets.filter((t) => t.source === data.suggestedSource).length;

  return (
    <div style={{ maxWidth: 880, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 6 }}>Targets</h1>
      <p className="faint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        Everything else in this platform compares a caller against{" "}
        <strong>the rest of your team</strong>. That answers &ldquo;who is
        stronger&rdquo; but not &ldquo;is this any good&rdquo; — with a small
        team the average is both noisy and possibly poor, so the best of a weak
        group reads as strong.
      </p>
      <p className="faint" style={{ marginBottom: 14, lineHeight: 1.6 }}>
        Setting a target fixes that. Once a metric has one, the app leads with
        whether the bar was met — and says plainly when someone is ahead of the
        team but the whole team is under target.
      </p>
      <p className="faint" style={{ marginBottom: 22, lineHeight: 1.6 }}>
        <strong>Two kinds of number live here.</strong> Ones you set, and the
        borrowed starting figures below. The borrowed ones come from published
        cold-calling ranges — mostly measured on software teams calling office
        workers, not on people ringing owner-operated trades. They are a place to
        start, not a verdict, so anywhere the app uses one it says the bar is
        borrowed, and once you have around 500 calls of your own it asks you to
        replace it.
      </p>

      {err && (
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)", marginBottom: 16 }}>
          {err}
        </div>
      )}
      {msg && (
        <div className="card" style={{ borderColor: "var(--amber-dim)", color: "var(--amber)", marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {data.missing.length > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <strong>{data.missing.length} metrics have no target.</strong>
          <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
            Those are reported team-relative only, and the app will say there is
            nothing to judge them against. You can fill them with the borrowed
            starting figures and adjust as you learn — anything you have already
            set is left alone.
          </p>
          <button className="btn" onClick={useSuggested} disabled={seeding} style={{ marginTop: 10 }}>
            {seeding ? "Setting…" : "Use the starting figures for these"}
          </button>
        </div>
      )}

      {borrowedCount > 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <strong>
            {borrowedCount} {borrowedCount === 1 ? "target is" : "targets are"} still borrowed.
          </strong>
          <p className="faint" style={{ marginTop: 4, lineHeight: 1.55 }}>
            They work, but they were not measured on your business. Overwrite one
            the moment you have a reason to — your own number beats a general one
            every time.
          </p>
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {data.metrics.map((m) => (
          <TargetRow
            key={m.key}
            metric={m}
            existing={byMetric.get(m.key) ?? null}
            suggested={suggestedBy.get(m.key) ?? null}
            suggestedSource={data.suggestedSource}
            onSaved={(text) => {
              setMsg(text);
              load();
            }}
            onError={setErr}
          />
        ))}
      </div>
    </div>
  );
}

function TargetRow({
  metric,
  existing,
  suggested,
  suggestedSource,
  onSaved,
  onError,
}: {
  metric: MetricDef;
  existing: Target | null;
  suggested: SuggestedTarget | null;
  suggestedSource: string;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isRate = metric.kind === "rate";
  const toField = (n: number) => (isRate ? String(Math.round(n * 100)) : String(n));
  const borrowed = !!existing && existing.source === suggestedSource;

  const [value, setValue] = useState(existing ? toField(existing.target) : "");
  const [source, setSource] = useState(borrowed ? "" : (existing?.source ?? ""));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const numeric = isRate ? Number(value) / 100 : Number(value);
    const res = await fetch("/api/targets", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metric: metric.key, target: numeric, source }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) {
      onError(j.error || "Could not save that.");
      return;
    }
    onSaved(`Target set for ${metric.label}.`);
  }

  async function clear() {
    setBusy(true);
    await fetch(`/api/targets?metric=${metric.key}`, { method: "DELETE" });
    setBusy(false);
    setValue("");
    setSource("");
    onSaved(`${metric.label} has no target again.`);
  }

  const unit = isRate ? "%" : metric.kind === "duration_minutes" ? "minutes" : "per day";
  const range = suggested
    ? isRate
      ? `${Math.round(suggested.low * 100)}–${Math.round(suggested.high * 100)}%`
      : `${suggested.low}–${suggested.high}`
    : null;

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>{metric.label}</strong>
        {existing ? (
          <span className="tag">
            target {isRate ? `${Math.round(existing.target * 100)}%` : existing.target}
          </span>
        ) : (
          <span className="tag-dim">no target</span>
        )}
        {borrowed && <span className="tag-dim">borrowed starting figure</span>}
        {metric.lowerIsBetter && <span className="faint">lower is better</span>}
      </div>
      <p className="faint" style={{ marginTop: 3, lineHeight: 1.5 }}>
        {metric.meaning}
      </p>

      {suggested && (
        <p className="faint" style={{ marginTop: 6, lineHeight: 1.5 }}>
          Commonly quoted: <strong>{range}</strong> ({suggested.basis}){" "}
          {!existing && (
            <button
              className="btn-ghost"
              onClick={() => {
                setValue(toField(suggested.value));
                setSource(suggestedSource);
              }}
              style={{ marginLeft: 4 }}
            >
              use {isRate ? `${Math.round(suggested.value * 100)}%` : suggested.value}
            </button>
          )}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={suggested ? toField(suggested.value) : isRate ? "30" : "40"}
          style={{ maxWidth: 90 }}
          min={0}
        />
        <span className="faint">{unit}</span>
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={borrowed ? "Replace with your own reason" : "Where did this number come from?"}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button className="btn" onClick={save} disabled={busy || !value || !source.trim()}>
          {busy ? "Saving…" : "Save"}
        </button>
        {existing && (
          <button className="btn-ghost" onClick={clear} disabled={busy}>
            Clear
          </button>
        )}
      </div>
      {existing?.source && (
        <p className="faint" style={{ marginTop: 8 }}>
          Current source: {existing.source}
        </p>
      )}
    </div>
  );
}
