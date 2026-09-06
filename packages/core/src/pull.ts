import type { Event, EventStore } from "./index.js";

export interface PullResult {
  events: Event[];
  /** instructions addressed to `me` that are not yet acked (as of this pull) */
  for_me: Event[];
  cursor: string | null;
}

/**
 * The protocol step every agent runs at the start of a turn:
 * read since cursor, record deliveries of instructions to me, advance cursor (heartbeat).
 */
export async function pull(store: EventStore, me: string, after: string | null, now: Date = new Date()): Promise<PullResult> {
  const events = await store.since(after);
  const nowIso = now.toISOString();
  const for_me: Event[] = [];
  for (const e of events) {
    if (e.kind === "instruction" && e.to === me) {
      await store.recordDelivery({ event_id: e.id, to: me, at: nowIso });
      for_me.push(e);
    }
  }
  const cursor = events.length ? events[events.length - 1].id : after;
  await store.setCursor({ actor: me, last_event_id: cursor, at: nowIso });
  return { events, for_me, cursor };
}
