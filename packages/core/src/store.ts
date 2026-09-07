import { type Event, type NewEvent, type Log, type Cursor, type Delivery } from "./events.js";
import { ulid } from "./ulid.js";
import { reduce } from "./reduce.js";
import { validate } from "./rules.js";

export interface EventStore {
  /** Full log, oldest first. */
  read(): Promise<Log>;
  /** Events with id > after, oldest first. */
  since(after: string | null): Promise<Event[]>;
  /**
   * t-121: a token that changes whenever anything in this store changes — a new event, a moved cursor, a delivery.
   * It is the cheapest possible answer to "has anything changed?", which is what lets a caller reuse work it already
   * did. A reduction depends on all three, so a token that covered only events would go stale the moment someone
   * pulled. Optional: a store that cannot answer cheaply omits it, and every caller falls back to reading.
   */
  version?(): Promise<string | null>;
  appendRaw(e: Event): Promise<void>;
  setCursor(c: Cursor): Promise<void>;
  recordDelivery(d: Delivery): Promise<void>;
}

/** t-088: what `append` did — a new event, or the one that already carried this `from`. */
export interface Appended { event: Event; created: boolean }

export interface AppendOptions {
  human: string;
  now?: Date;
  /** How to mint the id; default the process-monotonic ulid. */
  mint?: (ms: number) => string;
}

/** Validate against the current state, then append. The one write path. */
export async function append(store: EventStore, ne: NewEvent, opts: AppendOptions): Promise<Event> {
  return (await appendFrom(store, ne, opts)).event;
}

/**
 * The one write path, saying whether it wrote (t-088). An event that carries `from` is written once: if the log already
 * holds one with that exact `from`, the existing event comes back with created=false and nothing is appended.
 */
export async function appendFrom(store: EventStore, ne: NewEvent, opts: AppendOptions): Promise<Appended> {
  const now = opts.now ?? new Date();
  const log = await store.read();
  const state = reduce(log, now);
  if (ne.from) {
    const seen = state.from.get(ne.from);
    if (seen) return { event: seen, created: false };
  }
  validate(state, ne, opts.human, now);
  const e = { ...ne, id: (opts.mint ?? ulid)(now.getTime()), at: now.toISOString() } as Event;
  await store.appendRaw(e);
  return { event: e, created: true };
}

export class MemoryStore implements EventStore {
  events: Event[] = [];
  cursors = new Map<string, Cursor>();
  deliveries: Delivery[] = [];

  async read(): Promise<Log> {
    return { events: [...this.events], cursors: [...this.cursors.values()], deliveries: [...this.deliveries] };
  }
  async version(): Promise<string | null> {
    const cursors = [...this.cursors.values()].map((c) => `${c.actor}@${c.last_event_id ?? ""}`).sort().join(",");
    return `${this.events.length}:${this.events[this.events.length - 1]?.id ?? ""}:${cursors}:${this.deliveries.length}`;
  }
  async since(after: string | null): Promise<Event[]> {
    return this.events.filter((e) => !after || e.id > after);
  }
  async appendRaw(e: Event): Promise<void> {
    this.events.push(e);
  }
  async setCursor(c: Cursor): Promise<void> {
    this.cursors.set(c.actor, c);
  }
  async recordDelivery(d: Delivery): Promise<void> {
    if (!this.deliveries.some((x) => x.event_id === d.event_id && x.to === d.to)) this.deliveries.push(d);
  }
}
