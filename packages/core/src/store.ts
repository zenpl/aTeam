import { type Event, type NewEvent, type Log, type Cursor, type Delivery } from "./events.js";
import { ulid } from "./ulid.js";
import { reduce, advance, settle, empty, type State } from "./reduce.js";
import { validate } from "./rules.js";

export interface EventStore {
  /** Full log, oldest first. */
  read(): Promise<Log>;
  /** Events with id > after, oldest first. */
  since(after: string | null): Promise<Event[]>;
  /**
   * t-128: what has landed since `mark`, and where to resume. `events` is how many the store holds in total — the one
   * check that a caller folding incrementally has not missed something that arrived behind its mark (a second writer
   * whose clock ran backwards, a log edited underneath it); when it disagrees, the caller rebuilds.
   * Optional: a store that cannot answer omits it, and every caller falls back to reading the whole log.
   */
  readSince?(mark: LogMark | null): Promise<{ log: Log; mark: LogMark; events: number }>;
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

/**
 * t-128: how far a reduction has consumed a store. `event` is the newest event id it folded; `delivery` the newest
 * delivery time — deliveries share timestamps and arrive out of order, so that instant is re-read rather than skipped,
 * which costs a handful of rows and is exact, because applying a delivery twice does nothing.
 */
export interface LogMark { event: string | null; delivery: string | null }

/**
 * t-128 (P0): one reduction that moves forward with a store instead of being rebuilt for every call.
 *
 * It cannot go stale, and so nothing invalidates it: every answer starts by asking the store what has landed since it
 * last looked, and folding only that. What it holds is the event-only part of a reduction (`advance`), which depends on
 * the log and nothing else; the clock-dependent part (`settle`) is recomputed for the moment being asked about, so two
 * callers asking about two different moments both get the right answer.
 *
 * A reduction is mutable and is settled in place, so a holder must not share it with anyone who could hold its state
 * across an await. Each path keeps its own: the write path's is keyed on the store below, the read path's is the
 * server's, one per project.
 */
export class Reduction {
  private s: State = empty();
  private mark: LogMark | null = null;
  constructor(private store: EventStore) {}

  async at(now: Date): Promise<State> {
    if (!this.store.readSince) return reduce(await this.store.read(), now);
    let got = await this.store.readSince(this.mark);
    advance(this.s, got.log);
    if (got.events !== this.s.ids.size) {
      // Something is in the store that we never folded. Rebuild rather than serve a state that disagrees with the log.
      this.s = empty();
      got = await this.store.readSince(null);
      advance(this.s, got.log);
    }
    this.mark = got.mark;
    return settle(this.s, now);
  }
}

/** t-128: the write path's reduction for each store, kept alive exactly as long as the store is. */
const writing = new WeakMap<EventStore, Reduction>();
function reductionFor(store: EventStore): Reduction {
  let r = writing.get(store);
  if (!r) writing.set(store, (r = new Reduction(store)));
  return r;
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
  // t-128: nothing is awaited between here and the append, so the reduction cannot be settled at another moment underneath us.
  const state = await reductionFor(store).at(now);
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
  async since(after: string | null): Promise<Event[]> {
    return this.events.filter((e) => !after || e.id > after);
  }
  async readSince(mark: LogMark | null): Promise<{ log: Log; mark: LogMark; events: number }> {
    const events = mark?.event ? this.events.filter((e) => e.id > mark.event!) : [...this.events];
    const deliveries = mark?.delivery ? this.deliveries.filter((d) => d.at >= mark.delivery!) : [...this.deliveries];
    return {
      log: { events, cursors: [...this.cursors.values()], deliveries },
      mark: {
        event: this.events[this.events.length - 1]?.id ?? mark?.event ?? null,
        delivery: this.deliveries.reduce<string | null>((a, d) => (a && a > d.at ? a : d.at), mark?.delivery ?? null),
      },
      events: this.events.length,
    };
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
