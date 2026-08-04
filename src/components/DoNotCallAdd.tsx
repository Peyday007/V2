"use client";

import { useState } from "react";

// Adding a number to the do-not-call list by hand.
//
// This is the one thing the retired "Do not call" page could do that nothing
// else can. Everything else on that page was a list to look at, and the list
// was not the point — suppression is enforced in five independent places
// (building a packet, topping one up, importing, handing a lead to a caller,
// and logging an outcome) and none of them ever read that page.
//
// But a written request has to go somewhere. Somebody emails, or leaves a
// voicemail, or a letter arrives, and the number may not be in the system at
// all. Deleting the only path for that would mean the answer to "please stop
// calling me" is "run some SQL", which is not an answer.
//
// So the list went and this stayed, folded into the Leads page where the lead
// pool is managed.
//
// It suppresses on the NUMBER, not the lead record. The same business is
// routinely in the database more than once — imported twice, sourced under two
// trades — so suppressing one record would leave the duplicates dialable.

export default function DoNotCallAdd() {
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  async function add() {
    setSaving(true);
    setResult(null);
    setFailed(false);
    try {
      const res = await fetch("/api/suppressions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, reason, requested_by: "Owner / decision-maker" }),
      });
      const json = await res.json();
      setSaving(false);
      if (!res.ok) {
        setFailed(true);
        setResult(json.error || "Could not add that number.");
        return;
      }
      setResult(
        `Added. ${json.leads_suppressed} lead record${
          json.leads_suppressed === 1 ? "" : "s"
        } suppressed and pulled out of any open packet.`
      );
      setPhone("");
      setReason("");
    } catch (e) {
      setSaving(false);
      setFailed(true);
      setResult(e instanceof Error ? e.message : String(e));
    }
  }

  if (!open) {
    return (
      <button className="btn-ghost" onClick={() => setOpen(true)} style={{ marginTop: 8 }}>
        Add a number to do-not-call
      </button>
    );
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0, marginBottom: 6 }}>Add a number to do-not-call</h3>
      <p className="faint" style={{ marginBottom: 10, lineHeight: 1.6 }}>
        For a request that did not come in on a call — an email, a letter, a voicemail. A caller
        marking &ldquo;do not call&rdquo; on the phone already does this by itself.
        <br />
        It blocks the <strong>number</strong>, so every record sharing it is covered — the same
        business is often in here twice under two trades.
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="Phone number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          style={{ flex: "0 1 200px" }}
        />
        <input
          placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <button className="btn" onClick={add} disabled={saving || !phone.trim()}>
          {saving ? "Adding…" : "Add"}
        </button>
        <button className="btn-ghost" onClick={() => setOpen(false)} disabled={saving}>
          Close
        </button>
      </div>
      {result && (
        <p
          style={{
            marginTop: 10,
            fontSize: "0.85rem",
            lineHeight: 1.5,
            color: failed ? "var(--red)" : "var(--amber)",
          }}
        >
          {result}
        </p>
      )}
    </div>
  );
}
