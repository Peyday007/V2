import { supabase } from "./supabase";

export async function logEvent(
  eventType: string,
  entityType: string,
  entityId: string | null,
  data: Record<string, unknown> = {}
) {
  const { error } = await supabase().from("events").insert({
    event_type: eventType,
    entity_type: entityType,
    entity_id: entityId,
    data,
  });
  if (error) {
    console.error("logEvent failed:", eventType, error.message);
  }
}
