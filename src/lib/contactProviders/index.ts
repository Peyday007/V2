import "server-only";
import { peopleDataLabs } from "./peopleDataLabs";
import { apollo } from "./apollo";
import type { ContactProvider } from "./types";

export * from "./types";

/**
 * The provider waterfall.
 *
 * Ordered so anything that bills only on a hit runs before anything that bills
 * per request, then by cost. Adding a vendor means adding one file and one
 * entry here — nothing else in the pipeline changes.
 *
 * NEITHER ADAPTER HAS BEEN RUN AGAINST A LIVE ACCOUNT. Both were written from
 * documented request and response shapes; there are no credentials here to
 * test with. Verify the mapping against current vendor docs before relying on
 * a bill, and start with a small budget cap.
 */
export const PROVIDERS: ContactProvider[] = [peopleDataLabs, apollo].sort((a, b) => {
  if (a.billsOnlyOnHit !== b.billsOnlyOnHit) return a.billsOnlyOnHit ? -1 : 1;
  if (a.costPerHitCents !== b.costPerHitCents) return a.costPerHitCents - b.costPerHitCents;
  return a.order - b.order;
});

export function availableProviders(): ContactProvider[] {
  const only = (process.env.CONTACT_PROVIDERS || "").trim();
  const allowed = only ? new Set(only.split(",").map((s) => s.trim())) : null;
  return PROVIDERS.filter(
    (p) => p.isAvailable() && (!allowed || allowed.has(p.key))
  );
}

export function providerStatus(): {
  key: string;
  label: string;
  available: boolean;
  reason: string | null;
  billsOnlyOnHit: boolean;
  costPerHitCents: number;
}[] {
  return PROVIDERS.map((p) => ({
    key: p.key,
    label: p.label,
    available: p.isAvailable(),
    reason: p.unavailableReason(),
    billsOnlyOnHit: p.billsOnlyOnHit,
    costPerHitCents: p.costPerHitCents,
  }));
}

/** Said in words, so an admin knows why no direct numbers are appearing. */
export function directNumberCapability(): { available: boolean; reason: string } {
  const ready = availableProviders();
  if (ready.length > 0) {
    return {
      available: true,
      reason: `${ready.length} contact provider${ready.length === 1 ? "" : "s"} configured: ${ready
        .map((p) => p.label)
        .join(", ")}.`,
    };
  }
  return {
    available: false,
    reason:
      "No contact-data provider is configured, so no direct numbers can be discovered. Owner identification still runs from public sources; leads will grade C at best.",
  };
}
