"use client";

import { useCallback, useEffect, useState } from "react";

// The Send Packet panel.
//
// One component, two homes: the caller's dialer (where it is actually used,
// mid-call) and the admin lead record. They post to different endpoints
// because callers and admins authenticate differently, so the endpoint is a
// prop — everything else is identical, and neither copy can drift.

type PacketStatus = "not_sent" | "sent" | "opened" | "trial_requested";

const STATUS_LABEL: Record<PacketStatus, string> = {
  not_sent: "Not sent",
  sent: "Sent",
  opened: "Opened",
  trial_requested: "Trial requested",
};

const STATUS_COLOUR: Record<PacketStatus, string> = {
  not_sent: "var(--text-dim)",
  sent: "var(--text)",
  opened: "var(--amber)",
  trial_requested: "var(--amber)",
};

type Packet = {
  id: string;
  status: PacketStatus;
  delivery_method: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  sent_by_name: string | null;
  last_send_error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  trial_requested_at: string | null;
};

type Payload = {
  packet: Packet | null;
  defaults: { name: string; phone: string };
  /** Only do-not-call / bad-number. A missing name or mobile is NOT this. */
  suppressedReason: string | null;
  sms: { available: boolean; reason: string };
  error: string | null;
};

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

export default function PacketPanel({
  leadId,
  businessName,
  endpoint,
  senderName,
  compact,
}: {
  leadId: string;
  businessName: string;
  /** "/api/dial/packet" for callers, "/api/workshop-packets" for admins. */
  endpoint: string;
  /** Only the admin endpoint needs this; the caller's name comes from the session. */
  senderName?: string;
  compact?: boolean;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${endpoint}?lead_id=${encodeURIComponent(leadId)}`);
      const j = await res.json();
      const payload: Payload = {
        packet: j.packet ?? null,
        defaults: j.defaults ?? { name: "", phone: "" },
        suppressedReason: j.suppressedReason ?? null,
        sms: j.sms ?? { available: false, reason: "" },
        error: j.error ?? null,
      };
      setData(payload);
      setName(payload.packet?.owner_name || payload.defaults.name || "");
      setPhone(payload.packet?.owner_phone || payload.defaults.phone || "");
    } catch (e) {
      setData({
        packet: null,
        defaults: { name: "", phone: "" },
        suppressedReason: null,
        sms: { available: false, reason: "" },
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [endpoint, leadId]);

  useEffect(() => {
    load();
  }, [load]);

  async function post(linkOnly: boolean) {
    setBusy(true);
    setMessage("");
    setFailure("");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: leadId,
        owner_name: name,
        owner_phone: phone,
        sender_name: senderName,
        link_only: linkOnly,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);

    if (j.link) setLink(j.link);
    if (j.error) {
      // The status is left exactly where it was, so this reads as "fix the
      // number and press it again" rather than "it went, probably".
      setFailure(j.error);
      if (j.packet) setData((d) => (d ? { ...d, packet: j.packet } : d));
      return;
    }

    if (linkOnly) {
      // Actually copy it. Pressing a button called "Copy link" and having a
      // text box appear instead is not copying, and it is why this looked
      // broken. The box below stays as a fallback for when the clipboard is
      // blocked, which browsers do outside a secure context.
      let copiedOk = false;
      try {
        await navigator.clipboard.writeText(j.link);
        copiedOk = true;
      } catch {
        copiedOk = false;
      }
      setCopied(copiedOk);
      if (copiedOk) setTimeout(() => setCopied(false), 2000);
      setMessage(
        copiedOk
          ? "Link copied — paste it into your own text message."
          : "Link ready. Your browser blocked the clipboard, so copy it from the box below."
      );
    } else {
      setMessage(
        `Texted to ${phone}${j.segments && j.segments > 1 ? ` (${j.segments} parts)` : ""}.`
      );
      setEditing(false);
    }
    load();
  }

  if (!data) return <p className="faint">Loading packet…</p>;

  const status: PacketStatus = data.packet?.status ?? "not_sent";
  // Suppression blocks everything. Only the do-not-call and bad-number reasons
  // do that — a missing name or number stops a TEXT, not a link.
  const suppressed = !!data.suppressedReason;
  const canLink = !suppressed;
  const canText = canLink && !!name.trim() && !!phone.trim() && data.sms.available;

  return (
    <div
      style={{
        border: "1px solid var(--border-strong)",
        borderRadius: 4,
        padding: compact ? "12px 14px" : "16px 18px",
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ letterSpacing: "0.08em", fontSize: "0.78rem" }}>PACKET</strong>
        <span style={{ color: STATUS_COLOUR[status], fontWeight: 700, fontSize: "0.82rem" }}>
          {STATUS_LABEL[status]}
        </span>
        {status === "trial_requested" && (
          <span className="tag" style={{ color: "var(--amber)" }}>
            they agreed — {when(data.packet?.trial_requested_at ?? null)}
          </span>
        )}
      </div>

      {data.error && (
        <p style={{ color: "var(--red)", marginTop: 8, lineHeight: 1.5 }}>{data.error}</p>
      )}

      <p className="faint" style={{ marginTop: 4 }}>
        {name || "no owner name yet"} — {businessName}
      </p>

      {/* Who it goes to. Editable, because the number on the record is often the
          switchboard and the mobile only comes up during the call itself. */}
      {(editing || status === "not_sent") && (
        <div style={{ display: "grid", gap: 6, marginTop: 10, maxWidth: 320 }}>
          <input
            placeholder="Owner's name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Mobile to text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
          />
        </div>
      )}

      {suppressed && (
        <p style={{ color: "var(--red)", marginTop: 8, lineHeight: 1.5 }}>
          {data.suppressedReason}
        </p>
      )}

      {!suppressed && !canText && (
        <p className="faint" style={{ marginTop: 8, lineHeight: 1.5 }}>
          {!name.trim() || !phone.trim()
            ? "No mobile on file yet — ask for it at step 5, or use Copy link and send it yourself."
            : ""}
        </p>
      )}

      {!data.sms.available && !suppressed && (
        <p className="faint" style={{ marginTop: 8, lineHeight: 1.5, color: "var(--red)" }}>
          {data.sms.reason}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button
          className="btn"
          onClick={() => post(false)}
          disabled={busy || !canText}
          title={
            suppressed
              ? data.suppressedReason || ""
              : !name.trim() || !phone.trim()
                ? "Needs the owner's name and a mobile number"
                : !data.sms.available
                  ? data.sms.reason
                  : "Texts the link straight to them"
          }
        >
          {busy ? "Sending…" : status === "not_sent" ? "Send packet" : "Send again"}
        </button>

        <button
          className="btn-ghost"
          onClick={() => post(true)}
          disabled={busy || !canLink}
          title={
            suppressed
              ? data.suppressedReason || ""
              : "Copies the link to your clipboard. No name or number needed — send it however you like."
          }
        >
          Copy link
        </button>

        {!editing && status !== "not_sent" && (
          <button className="btn-ghost" onClick={() => setEditing(true)}>
            Change number
          </button>
        )}
      </div>

      {link && (
        <div style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}>
          <input readOnly value={link} style={{ flex: 1, minWidth: 0, fontSize: "0.75rem" }} />
          <button
            className="btn-ghost"
            style={{ padding: "5px 12px" }}
            onClick={() => {
              navigator.clipboard?.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
      )}

      {message && (
        <p style={{ marginTop: 8, color: "var(--amber)", lineHeight: 1.5 }}>{message}</p>
      )}
      {(failure || data.packet?.last_send_error) && (
        <p style={{ marginTop: 8, color: "var(--red)", lineHeight: 1.5 }}>
          {failure || data.packet?.last_send_error}
        </p>
      )}

      {/* The delivery trail, so nobody has to guess whether it went. */}
      {data.packet && status !== "not_sent" && (
        <p className="faint" style={{ marginTop: 8, lineHeight: 1.55 }}>
          {data.packet.delivery_method === "text" ? "Texted" : "Link created"}
          {data.packet.sent_by_name ? ` by ${data.packet.sent_by_name}` : ""}
          {when(data.packet.sent_at) ? ` · ${when(data.packet.sent_at)}` : ""}
          {when(data.packet.opened_at) ? ` · opened ${when(data.packet.opened_at)}` : ""}
        </p>
      )}
    </div>
  );
}
