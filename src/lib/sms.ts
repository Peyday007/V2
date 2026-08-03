import "server-only";
import twilio from "twilio";

// Sending an SMS, for real, through Twilio.
//
// Same shape as every other provider in this codebase: an explicit capability
// check that explains itself, and a send that reports what actually happened
// rather than swallowing it. The one thing this must never do is report a
// success it did not have — a packet marked "sent" that never arrived is worse
// than a visible failure, because the caller stops chasing it.
//
// Credentials come from the environment and are never logged. Vercel bakes
// environment variables in at build time, so adding them needs a redeploy.

export type SmsCapability = {
  available: boolean;
  reason: string;
  /** Which variables are missing, so an admin can act without guessing. */
  missing: string[];
};

const REQUIRED = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const;

export function smsCapability(): SmsCapability {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length === 0) {
    return {
      available: true,
      reason: `Texting from ${process.env.TWILIO_FROM_NUMBER}.`,
      missing: [],
    };
  }
  return {
    available: false,
    reason:
      `Texting is not configured — ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ` +
      `not set. Add ${missing.length === 1 ? "it" : "them"} in Vercel → Settings → ` +
      `Environment Variables and redeploy. Use "Copy link" until then.`,
    missing: [...missing],
  };
}

/**
 * An Account SID is always 34 characters starting AC. Checked here because the
 * Twilio client throws a confusing constructor error on a malformed one, and
 * "username is required" is not a message anybody can act on.
 */
function credentialProblem(): string | null {
  const sid = process.env.TWILIO_ACCOUNT_SID || "";
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) {
    return "TWILIO_ACCOUNT_SID does not look like a Twilio Account SID (it should start with AC and be 34 characters). Check you did not paste the API Key SID instead.";
  }
  if ((process.env.TWILIO_AUTH_TOKEN || "").length < 16) {
    return "TWILIO_AUTH_TOKEN looks too short to be a Twilio auth token.";
  }
  return null;
}

export type SmsResult =
  | { ok: true; messageId: string; to: string; segments: number }
  | { ok: false; error: string; retryable: boolean };

/** Twilio error codes worth explaining in the sender's own words. */
const KNOWN_ERRORS: Record<number, { message: string; retryable: boolean }> = {
  21211: { message: "That is not a valid phone number.", retryable: false },
  21212: {
    message: "The TWILIO_FROM_NUMBER is not a valid number Twilio will send from.",
    retryable: false,
  },
  21214: { message: "Twilio could not reach that number.", retryable: false },
  21408: {
    message:
      "Your Twilio account is not permitted to send to that region. Enable it under Messaging → Geo permissions.",
    retryable: false,
  },
  21606: {
    message:
      "The TWILIO_FROM_NUMBER cannot send SMS. Buy an SMS-capable number, or verify this one.",
    retryable: false,
  },
  21610: {
    message: "That number replied STOP to an earlier message. Twilio will not deliver to it.",
    retryable: false,
  },
  21614: { message: "That number cannot receive text messages — it looks like a landline.", retryable: false },
  // The two that a new account actually hits, in the order it hits them.
  21608: {
    message:
      "This is a Twilio TRIAL account, which can only text numbers you have verified in the Twilio console. A cold prospect will never be verified — upgrade the account to text real leads. Use Copy link until then.",
    retryable: false,
  },
  30034: {
    message:
      "The Twilio number is not registered for A2P 10DLC, so US carriers are blocking it. Register it in Twilio under Messaging → Regulatory Compliance, or use a verified toll-free number.",
    retryable: false,
  },
  20003: {
    message: "Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.",
    retryable: false,
  },
  20429: { message: "Twilio is rate-limiting us. Try again in a moment.", retryable: true },
};

function describe(e: unknown): { error: string; retryable: boolean } {
  const err = e as { code?: number; status?: number; message?: string };
  if (typeof err?.code === "number" && KNOWN_ERRORS[err.code]) {
    const known = KNOWN_ERRORS[err.code];
    return { error: `${known.message} (Twilio ${err.code})`, retryable: known.retryable };
  }
  // A 5xx from Twilio is theirs, not ours, and is worth retrying.
  const retryable = typeof err?.status === "number" && err.status >= 500;
  return {
    error: err?.message ? String(err.message).slice(0, 300) : "Twilio rejected the message.",
    retryable,
  };
}

/**
 * Send one message.
 *
 * Never throws. Every failure comes back as `ok: false` with something the
 * caller can read on screen, because this is called from a button a VA presses
 * mid-conversation and an unhandled exception there is a 500 and a lost lead.
 */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const capability = smsCapability();
  if (!capability.available) {
    return { ok: false, error: capability.reason, retryable: false };
  }
  const bad = credentialProblem();
  if (bad) return { ok: false, error: bad, retryable: false };

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const message = await client.messages.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER!,
      body,
    });

    // Twilio accepts a message and *then* fails it asynchronously. A status of
    // "failed" here is a rejection at submission, and must not be reported as
    // a send — the whole point of this function is that "sent" means sent.
    if (message.status === "failed" || message.status === "undelivered") {
      return {
        ok: false,
        error: `Twilio could not send it: ${message.errorMessage || message.status}`,
        retryable: false,
      };
    }

    return {
      ok: true,
      messageId: message.sid,
      to,
      segments: Number(message.numSegments) || 1,
    };
  } catch (e) {
    return { ok: false, ...describe(e) };
  }
}
