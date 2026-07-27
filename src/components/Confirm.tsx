"use client";

import { useCallback, useState } from "react";

/**
 * In-app confirmation, replacing the browser's native confirm().
 *
 * Native confirm() is blocked outright by some browsers, embedded webviews and
 * extensions. When it is blocked it returns false silently, so every button
 * guarded by `if (!confirm(...)) return;` becomes a dead button that gives no
 * error and no feedback — which is exactly how the destructive actions here
 * were failing. This has no such dependency.
 */

export type ConfirmOptions = {
  title: string;
  /** Each string is its own paragraph. */
  body?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for anything destructive. */
  danger?: boolean;
};

export function useConfirm() {
  const [pending, setPending] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const ask = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ options, resolve })),
    []
  );

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  const dialog = pending ? (
    <div
      onClick={() => close(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
        padding: 20,
      }}
    >
      <div
        className="card"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 470, maxWidth: "94vw" }}
      >
        <h2 style={{ marginBottom: 10 }}>{pending.options.title}</h2>
        {(pending.options.body || []).map((line, i) => (
          <p
            key={i}
            style={{ fontSize: "0.88rem", lineHeight: 1.6, marginBottom: 10 }}
            className="muted"
          >
            {line}
          </p>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            className={pending.options.danger ? "btn-danger" : "btn"}
            onClick={() => close(true)}
            autoFocus
          >
            {pending.options.confirmLabel || "Yes, do it"}
          </button>
          <button className="btn-ghost" onClick={() => close(false)}>
            {pending.options.cancelLabel || "Cancel"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { ask, dialog };
}
