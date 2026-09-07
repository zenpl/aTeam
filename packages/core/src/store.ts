import { type Event, type NewEvent, type Log, type Cursor, type Delivery, type Refused, refusedOp } from "./events.js";
import { ulid } from "./ulid.js";
import { reduce, advance, settle, empty, type State } from "./reduce.js";
import { validate, Rejected } from "./rules.js";

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
  /**
   * t-212：记下一次被规则挡掉的写入。**可选**：答不出的存储就是数不出来——「不知道」不是「零次」，
   * 读它的地方据此说「说不出」而不是报一个假的 0。
   */
  recordRefusal?(r: Refused): Promise<void>;
  /** t-212：至今被挡掉的那些，老的在前。 */
  refusals?(): Promise<Refused[]>;
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
    // t-196：一批里带着署名更正就整个重建。一条更正可以指向早就折进去的事件，而**已经算进状态的东西是收不
    // 回来的**——增量折叠只会往前加。更正很少见，重建一次的代价换的是「增量与全量给出同一个答案」这条不变式。
    const disowning = got.log.events.some((e) => e.kind === "disown");
    if (disowning) { this.s = empty(); got = await this.store.readSince(null); }
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
  // t-212：**拒绝也落一条**。记在这里而不是 HTTP 处理器里，是因为这里是唯一的写入路径——服务、core 自己的
  // Builder、用例，谁走这条路都被数进去；记在处理器里就只数得到走 HTTP 那一半。
  // 这条记录**不过 validate**（它自己被规则拒了就成了死循环），直接落；也因此客户端伪造不出来——`refused`
  // 这种 kind 在形状闸里根本不是合法的输入。
  try {
    validate(state, ne, opts.human, now);
  } catch (err) {
    if (err instanceof Rejected && store.recordRefusal) {
      await store.recordRefusal({ kind: "refused", who: ne.actor ?? null, rule: err.rule,
        op: refusedOp(ne as { kind?: unknown; op?: unknown }), id: (opts.mint ?? ulid)(now.getTime()), at: now.toISOString() });
      err.recorded = true;   // t-212：外层那个出口据此跳过，同一次拒绝不记两遍
    }
    throw err;
  }
  const e = { ...ne, id: (opts.mint ?? ulid)(now.getTime()), at: now.toISOString() } as Event;
  await store.appendRaw(e);
  return { event: e, created: true };
}

export class MemoryStore implements EventStore {
  events: Event[] = [];
  refused: Refused[] = [];
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
  async recordRefusal(r: Refused): Promise<void> {
    this.refused.push(r);
  }
  async refusals(): Promise<Refused[]> {
    return [...this.refused];
  }
  async setCursor(c: Cursor): Promise<void> {
    this.cursors.set(c.actor, c);
  }
  async recordDelivery(d: Delivery): Promise<void> {
    if (!this.deliveries.some((x) => x.event_id === d.event_id && x.to === d.to)) this.deliveries.push(d);
  }
}
