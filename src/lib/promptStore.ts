import "server-only";
import { supabase } from "./supabase";
import { resolvePrompt } from "./prompts";

/**
 * Fetch a prompt's saved override and render it.
 *
 * Never throws and never returns nothing usable: a missing table, a database
 * error or a broken override all fall back to the wording that shipped with
 * the app. An editable prompt must not be able to take a feature offline.
 */
export async function buildPrompt(
  key: string,
  vars: Record<string, string | number | null | undefined>
): Promise<string> {
  let override: string | null = null;
  try {
    const { data } = await supabase()
      .from("prompts")
      .select("template")
      .eq("key", key)
      .maybeSingle();
    override = data?.template ?? null;
  } catch {
    override = null;
  }

  const resolved = resolvePrompt(key, override, vars);
  if (resolved.reason) console.warn(`[prompts] ${key}: ${resolved.reason}`);
  return resolved.text;
}
