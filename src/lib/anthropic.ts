import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function anthropic(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

export const APPROACH_MODEL = "claude-haiku-4-5-20251001";
export const PRIORITIZER_MODEL = "claude-sonnet-4-6";

/**
 * Reading call transcripts. Sonnet rather than Haiku: this reading is applied
 * without a human checking it, so the cost of being wrong is higher than the
 * cost of the token.
 */
export const TRANSCRIPT_ANALYSIS_MODEL = "claude-sonnet-4-6";
