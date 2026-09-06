import type { Event, EventStore } from "./index.js";

export interface PullResult {
  events: Event[];
  /** t-064: instructions to `me` taken back in this batch that I had pulled before it: the CLI warns about them. */
  taken_back_seen?: string[];
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
  // an instruction taken back in the same batch was never something to do (t-064); a delivery is still recorded, since it was read
  const takenBack = new Set(events.filter((e) => e.kind === "untell").map((e) => (e as { of: string }).of));
  for (const e of events) {
    if (e.kind === "instruction" && e.to === me && takenBack.has(e.id)) { await store.recordDelivery({ event_id: e.id, to: me, at: nowIso }); continue; }
    if (e.kind === "instruction" && e.to === me) {
      await store.recordDelivery({ event_id: e.id, to: me, at: nowIso });
      for_me.push(e);
    }
  }
  const cursor = events.length ? events[events.length - 1].id : after;
  const inBatch = new Set(events.map((e) => e.id));
  const earlier = [...takenBack].filter((id) => !inBatch.has(id));
  let taken_back_seen: string[] | undefined;
  if (earlier.length) {
    const { events: all } = await store.read();
    taken_back_seen = earlier.filter((id) => all.some((e) => e.id === id && e.kind === "instruction" && e.to === me));
  }
  await store.setCursor({ actor: me, last_event_id: cursor, at: nowIso });
  return { events, for_me, cursor, ...(taken_back_seen?.length ? { taken_back_seen } : {}) };
}
