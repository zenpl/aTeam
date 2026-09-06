import { type Event, type NewEvent, type Log, type Cursor, type Delivery } from "./events.js";
import { ulid } from "./ulid.js";
import { reduce } from "./reduce.js";
import { validate } from "./rules.js";

export interface EventStore {
  /** Full log, oldest first. */
  read(): Promise<Log>;
  /** Events with id > after, oldest first. */
  since(after: string | null): Promise<Event[]>;
  appendRaw(e: Event): Promise<void>;
  setCursor(c: Cursor): Promise<void>;
  recordDelivery(d: Delivery): Promise<void>;
}

export interface AppendOptions {
  human: string;
  now?: Date;
}

/** Validate against the current state, then append. The one write path. */
export async function append(store: EventStore, ne: NewEvent, opts: AppendOptions): Promise<Event> {
  const now = opts.now ?? new Date();
  const log = await store.read();
  const state = reduce(log, now);
  validate(state, ne, opts.human);
  const e = { ...ne, id: ulid(now.getTime()), at: now.toISOString() } as Event;
  await store.appendRaw(e);
  return e;
}

export class MemoryStore implements EventStore {
  events: Event[] = [];
  cursors = new Map<string, Cursor>();
  deliveries: Delivery[] = [];

  async read(): Promise<Log> {
    return { events: [...this.events], cursors: [...this.cursors.values()], deliveries: [...this.deliveries] };
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
