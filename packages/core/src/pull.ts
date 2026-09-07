import type { Event, EventStore } from "./index.js";
import type { OwedNow } from "./board.js";

export interface PullResult {
  events: Event[];
  /** t-064: instructions to `me` taken back in this batch that I had pulled before it: the CLI warns about them. */
  taken_back_seen?: string[];
  /**
   * Instructions addressed to `me` **in this batch**, and only this batch — once the cursor moves they are gone
   * from here. Use it to say what just arrived, never to say what is still owed: that is `owed`, and mistaking one
   * for the other is what qa 06:32 caught in t-140.
   */
  for_me: Event[];
  cursor: string | null;
  /**
   * t-147: what this role owes at this instant, computed by the service from the state it already keeps and sent
   * with every pull, so a caller needs neither a full read of the log nor a second request. Optional because
   * core's own `pull` has no state to compute it from, and because a CLI may be talking to a server too old to
   * send it — a missing field means「不知道」, not「不欠」.
   */
  owed?: OwedNow;
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
