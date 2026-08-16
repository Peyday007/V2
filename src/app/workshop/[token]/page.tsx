"use client";

import { use, useCallback, useEffect, useState } from "react";
import { WorkshopMiniSite, WorkshopShell, type Assessment } from "@/components/WorkshopView";

// The page a business owner opens from a text message.
//
// A thin shell now. It fetches the assessment and hands it to the mini-site;
// everything the owner reads is decided server-side and arrives already
// stripped of anything internal. Deliberately no loading skeleton pretending
// there is content — an owner who taps a link and sees a fake page is being
// told something untrue before they have read a word.

export default function WorkshopPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [data, setData] = useState<Assessment | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workshop/${token}`);
      if (res.status === 404) {
        setState("gone");
        return;
      }
      if (!res.ok) {
        setState("error");
        return;
      }
      setData(await res.json());
      setState("ready");
    } catch {
      setState("error");
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") {
    return (
      <WorkshopShell>
        <p className="muted" style={{ padding: 24 }}>
          Loading…
        </p>
      </WorkshopShell>
    );
  }

  if (state === "gone") {
    return (
      <WorkshopShell>
        <div style={{ maxWidth: 620, margin: "0 auto", padding: 24, lineHeight: 1.7 }}>
          <h1>This link is no longer available</h1>
          <p className="faint">
            It may have expired, or been replaced by a newer one. If somebody sent it to you
            recently, ask them for a fresh link.
          </p>
        </div>
      </WorkshopShell>
    );
  }

  if (state === "error" || !data) {
    return (
      <WorkshopShell>
        <div style={{ maxWidth: 620, margin: "0 auto", padding: 24, lineHeight: 1.7 }}>
          <h1>Something went wrong</h1>
          <p className="faint">
            We could not load this just now. Refreshing usually fixes it.
          </p>
        </div>
      </WorkshopShell>
    );
  }

  return (
    <WorkshopShell>
      <WorkshopMiniSite token={token} data={data} />
    </WorkshopShell>
  );
}
