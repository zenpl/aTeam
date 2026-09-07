import {
  type Event, type Log, type Reading, type Instruction, type Note, type ReadingShape,
  FOCUS_KEY, TEAM_SURFACE, DEFAULT_SHAPES, DECLINE_PREFIX, SERVICE_ACTOR, isDefaultApplied, isDefaultMissed, type Reach, ABSORB_PREFIX, ABSORB_FORM_KEY, ABSORB_FORMS, PROJECT_SURFACE, type AbsorbForm, type SeamVerdict } from "./events.js";

export type TaskStatus = "open" | "working" | "blocked" | "done" | "verified" | "failed" | "withdrawn" | "obsolete";

export interface TaskState {
  /** t-171: 建它时承诺人会看到什么；`promise_none` 是明写了「不改变人看到的东西」。与 done 的 `shows` 分开。 */
  promise?: string;
  promise_none?: boolean;
  id: string;
  title: string;
  /** All criteria in order: the ones from create, then every addition. */
  criteria: string[];
  /** Who created the task (and its first criteria). */
  criteria_by: string;
  /** What the create event built on (refs): a sentence the human said, a requirement note. */
  refs: string[];
  /** Criteria added after creation: which index in `criteria`, by whom, when. */
  criteria_added: { index: number; by: string; at: string }[];
  created_at: string;
  /** Time of the last task event that touched it: what "most recent" means on the board. */
  updated_at: string;
  owner?: string;
  /** When the current owner last claimed it, and that claim event's id (t-067: what a seam is judged against; ids order the log). */
  /** t-092: where this task came from when it was carried in (the create event's `from`). */
  from?: string;
  /** t-096: what people call it (an old number, say). Not an identifier: the id is the id. */
  label?: string;
  claimed_at?: string;
  claimed_id?: string;
  touches: string[];
  status: TaskStatus;
  blocked_on?: string;
  /** Set once the task is withdrawn (terminal). The id stays in the log; nothing else happens to it. */
  withdrawn?: { by: string; at: string; reason: string };
  /** Set once a decision made the finished task moot (terminal). What was done and judged stays on record. */
  obsolete?: { by: string; at: string; decision: string; reason?: string };
  evidence?: string;
  /** How many times the owner has said done. Verifications belong to the round they were made in. */
  round: number;
  /** Every verification ever recorded, on every surface, in every round. Nothing is dropped. */
  verifications: TaskVerification[];
  /** Notes attached with `task`, in log order. */
  notes: Note[];
  /** One sentence for the owner: what a person can now see (from the latest done or passing verify that said so). */
  shows?: string;
  /** The task's rounds in order: every done (with its evidence), verify and reopen. Nothing is overwritten. */
  history: TaskHistoryEntry[];
}

export type TaskHistoryEntry =
  | { op: "done"; id: string; by: string; at: string; round: number; evidence?: string }
  | { op: "verify"; id: string; by: string; at: string; round: number; surface: string; pass: boolean; evidence?: string }
  | { op: "reopen"; id: string; by: string; at: string; round: number; reason: string };

export interface TaskVerification { id: string; surface: string; pass: boolean; by: string; at: string; evidence?: string; round: number }

/** Latest result per surface in the current round: what the board shows next to the task. */
export function surfaceResults(t: TaskState): { surface: string; pass: boolean }[] {
  const latest = new Map<string, boolean>();
  for (const v of t.verifications) if (v.round === t.round) latest.set(v.surface, v.pass);
  return [...latest].map(([surface, pass]) => ({ surface, pass }));
}

/** Everyone who wrote a criterion of this task: none of them may judge it met. */
export function criteriaAuthors(t: TaskState): string[] {
  return [...new Set([t.criteria_by, ...t.criteria_added.map((a) => a.by)])];
}

/** Has this surface already passed in the current round? A second pass there says nothing new. */
export function passedOn(t: TaskState, surface: string): boolean {
  return t.verifications.some((v) => v.round === t.round && v.surface === surface && v.pass);
}

/** t-076: surfaces where a pass in the current round was later overturned by a fail: who, when, why. */
export function overturnedOn(t: TaskState): { surface: string; by: string; at: string; evidence?: string; passed_by: string }[] {
  const out: { surface: string; by: string; at: string; evidence?: string; passed_by: string }[] = [];
  for (const surface of new Set(t.verifications.filter((v) => v.round === t.round).map((v) => v.surface))) {
    const vs = t.verifications.filter((v) => v.round === t.round && v.surface === surface);
    const lastPass = [...vs].reverse().find((v) => v.pass);
    const last = vs[vs.length - 1];
    if (lastPass && last && !last.pass && vs.indexOf(last) > vs.indexOf(lastPass)) out.push({ surface, by: last.by, at: last.at, evidence: last.evidence, passed_by: lastPass.by });
  }
  return out;
}

export interface ReadingState {
  reading: Reading;
  /** false when a later write hit one of depends_on, or when superseded by a newer reading of the same surface:key. */
  valid: boolean;
  invalidated_by?: string;
  superseded_by?: string;
  /** set at board time when valid_until has passed */
  expired?: boolean;
  /** t-089: why an imported reading is not current, for the board to show instead of each renderer inventing a phrase. */
  imported_why?: string;
}

export interface InstructionState {
  instruction: Instruction;
  delivered_at?: string;
  acked_at?: string;
  acked_by?: string;
  /** Set when the sender took it back (t-064). `seen`: the recipient had already pulled it, so it must be told. */
  withdrawn?: { by: string; at: string; reason: string; seen: boolean };
  /**
   * t-147: how far this instruction got, worked out rather than declared — 未读 / 已读未动 / 办了. `unread` is the
   * default because a cursor that has not passed it proves nothing was read.
   */
  reach: Reach;
  /** t-147: what the recipient wrote that shows they acted on it — the first such event's id. */
  acted_by_event?: string;
  /**
   * t-147: past ack_by with the answer it is owed still missing. Only a card with options can be overdue now: an
   * instruction nobody has read is t-139's presence problem, and counting it here as well counted it twice.
   */
  overdue?: boolean;
  /**
   * t-181: 到期了、没人点、而服务那条「默认生效」的事件还**没有**落下。这是一个故障态，不是一种正常状态——
   * 服务一扫到它就落事件，落完这个字段就是 false。牌桌在这一态照实说「过期了，默认还没生效」（判据 8 第二句）。
   */
  default_due?: boolean;
  /**
   * t-190: 服务记下的一次「本该按默认执行，我们没有执行」。这张卡回到等人答，**期限从人再看到那一刻重算**
   * （`ack_by_again`），而不是把那个默认追认下去。`at` 是记下这件事的时刻，`window_ms` 是原来那张卡给人的时长。
   */
  default_missed?: { at: string; window_ms: number; option: string };
  /** t-190: 重算后的期限。人自这次记录之后还没露过面时是 undefined——他还没看到，就还没开始算。 */
  ack_by_again?: string;
  /**
   * For instructions with options: the option picked, by whom, and the decision note that records it.
   * `by: "default"` (no note) means nobody chose before ack_by and the default took effect; the human may still override it.
   */
  chosen?: { option: string; by: string; at: string; note?: string };
}

export interface Presence { last_pull: string | null; last_event: string | null }

/** The later of the two: the old single "last seen". */
export function lastSeen(p: Presence | undefined): string | null {
  if (!p) return null;
  return [p.last_pull, p.last_event].filter((x): x is string => !!x).sort().pop() ?? null;
}

export interface SeamState {
  id: string;
  tasks: [string, string];
  overlap: string[];
  /**
   * Set when one side was already done before the other claimed: the later task stacks on the earlier one.
   * Informational; it blocks nobody's verification. Cleared if both sides come back in flight.
   */
  stacked?: { done: string; on: string };
  /** Both sides belong to the same owner: sequential work by one hand, visible but never a collision (t-045). */
  same_owner?: boolean;
  /** t-149: `verdict`/`missed` judge the *gate*, not the two tasks: was this one real, and did it also miss something. */
  resolution?: {
    by: string; at: string; text: string;
    /** t-149: `verdict`/`missed` judge the *gate*, not the two tasks: was this one real, and did it also miss something. */
    verdict?: SeamVerdict; missed?: boolean;
    /** Who judged the gate and when — may be a later event than the resolution, with its own reason. */
    judged_by?: string; judged_at?: string; judged_why?: string;
  };
  /** t-073: both sides done and the later absorbed the earlier, by the project's declared form; blocks nothing. */
  absorbed?: { later: string; earlier: string; basis: string; by?: string };
  /**
   * t-113: both sides named symbols in the file they share, and named different ones. Worth saying out loud to whoever
   * merges second; never a reason to hold a verification. Recomputed on every claim and done, like the overlap itself.
   */
  light?: boolean;
}

export interface State {
  /** Every event id in the log: a ref must name one of them. */
  ids: Set<string>;
  /** t-088: the first event carried in under each `from`, so the same import never lands twice. */
  from: Map<string, Event>;
  readings: Map<string, ReadingState>;
  /** surface:key -> event id of the latest reading */
  latestReading: Map<string, string>;
  /** surface:key -> the shape its first declaring reading gave it. Defaults (by key) live in DEFAULT_SHAPES; see shapeFor. */
  shapes: Map<string, ReadingShape>;
  instructions: Map<string, InstructionState>;
  tasks: Map<string, TaskState>;
  seams: Map<string, SeamState>;
  /** t-121: the seams each task is in, so judging them is a lookup rather than a walk of every seam in the log. */
  seamsOf: Map<string, Set<string>>;
  /** t-121: which tasks declared each path, so a seam is looked for only where one could be. Derived, never read directly. */
  byTouch: Map<string, Set<string>>;
  /** The paths each task currently declares, so the index can be updated when a task's touches change. */
  touchedBy: Map<string, Set<string>>;
  /** Tasks with a touch that could contain another one (a directory); they are always candidates. */
  dirTouchers: Set<string>;
  /**
   * t-128: the instructions whose standing still depends on the clock — nobody has acked, decided or taken them back,
   * so whether the default has fired and whether they are overdue is a question `settle` must ask again at every
   * moment. An instruction leaves this set the moment an event resolves it, and never comes back.
   */
  pending: Set<string>;
  /** t-128: the readings that carry a valid_until, the only ones whose expiry can change with the clock. */
  perishable: Set<string>;
  notes: Note[];
  /** actor -> when they last pulled (their cursor moved: they are listening) and when they last spoke (an event). */
  presence: Map<string, Presence>;
  /** t-147: actor -> the last event id their cursor has passed. What "they have read this" is computed from. */
  read_upto: Map<string, string>;
  /** t-147: instruction id -> the first event of its recipient that acted on it. Filled as events arrive. */
  acted: Map<string, string>;
  focus?: Reading;
}

/**
 * Do two declared touches overlap? Exact match; a `#symbol` suffix overlaps its file; a directory prefix overlaps
 * everything under it. Unrelated paths (or non-path touches like `GET /health`) only overlap when equal.
 */
export function touchesOverlap(a: string, b: string): boolean {
  const pa = a.split("#")[0].replace(/\/+$/, "");
  const pb = b.split("#")[0].replace(/\/+$/, "");
  if (pa === pb) return true;
  return pa.startsWith(pb + "/") || pb.startsWith(pa + "/");
}

/** The touches of either task that overlap something the other declared. */
export function overlapOf(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  // t-121 (pm 02:43): our own rules push touch counts up — claim wide, revise at done, name symbols. So the pairwise
  // comparison has to stop being pairwise. Without a directory in play, two touches meet exactly when their paths are
  // equal, which a set answers in one step instead of a scan. A directory can contain anything, so that case still walks.
  if (!a.some(dirLike) && !b.some(dirLike)) {
    const bPaths = new Set(b.map(touchPath));
    const aPaths = new Set(a.map(touchPath));
    for (const x of a) if (bPaths.has(touchPath(x))) out.add(x);
    for (const y of b) if (aPaths.has(touchPath(y))) out.add(y);
    return [...out];
  }
  for (const x of a) if (b.some((y) => touchesOverlap(x, y))) out.add(x);
  for (const y of b) if (a.some((x) => touchesOverlap(x, y))) out.add(y);
  return [...out];
}

const pathOf = (t: string) => t.split("#")[0].replace(/\/+$/, "");
const symbolOf = (t: string) => (t.includes("#") ? t.slice(t.indexOf("#") + 1) : null);

/**
 * t-113 (pd 00:59): judge a seam at the finest granularity **both** sides declared. Two tasks that each named the
 * symbols they would touch in one file, and named different ones, are not colliding — blocking them teaches people to
 * declare less, which is the opposite of what the seam is for. It takes both sides: a side that only said "this file"
 * has not told you which half of it, so anything it overlaps is still a collision.
 *
 * A directory-prefix overlap is never light: nobody declared symbols for a whole directory.
 * No whitelist, no path pattern — a test file is not special, a declaration is (pm 01:00; the omitted lesson).
 */
export function overlapIsLight(a: string[], b: string[]): boolean {
  const paths = new Set<string>();
  let any = false;
  // t-121: the same set trick — a shared path is what both sides must have named for the question to arise at all.
  if (!a.some(dirLike) && !b.some(dirLike)) {
    const bPaths = new Set(b.map(pathOf));
    for (const x of a) if (bPaths.has(pathOf(x))) { any = true; paths.add(pathOf(x)); }
  } else {
    for (const x of a) for (const y of b) {
      if (!touchesOverlap(x, y)) continue;
      any = true;
      if (pathOf(x) !== pathOf(y)) return false;   // a directory containing the other: no symbols were ever declared for it
      paths.add(pathOf(x));
    }
  }
  if (!any) return false;
  for (const p of paths) {
    const syms = (side: string[]) => side.filter((t) => pathOf(t) === p).map(symbolOf);
    const as = syms(a), bs = syms(b);
    if (as.includes(null) || bs.includes(null)) return false;            // one side only said "this file"
    if (as.some((x) => bs.includes(x))) return false;                    // both named symbols, and they meet
  }
  return true;
}

/** The `chosen.by` of a decision that nobody made: the default took effect when ack_by passed. */
export const DEFAULT_DECIDER = "default";

export function seamId(a: string, b: string): string {
  return "seam:" + [a, b].sort().join("+");
}

function readingKey(r: Reading): string {
  return `${r.surface}:${r.key}`;
}

/** t-128: a reduction that has consumed nothing. `advance` moves it forward; `settle` reads it at a moment in time. */
export function empty(): State {
  return {
    ids: new Set(),
    from: new Map(),
    readings: new Map(),
    latestReading: new Map(),
    shapes: new Map(),
    instructions: new Map(),
    tasks: new Map(),
    seams: new Map(),
    seamsOf: new Map(),
    byTouch: new Map(),
    touchedBy: new Map(),
    dirTouchers: new Set(),
    pending: new Set(),
    perishable: new Set(),
    read_upto: new Map(),
    acted: new Map(),
    notes: [],
    presence: new Map(),
  };
}

/**
 * t-128 (P0, the write path's half of t-121): fold `log` into `s`, skipping anything it has already consumed.
 *
 * Nothing in here reads the clock. That is the whole point: a state advanced by three events is the same state a full
 * fold of the whole log would have produced, so it can be kept between calls instead of rebuilt — which is what turns
 * "every append re-reduces the log" (O(events) per write, O(events squared) for a day of them) into "every append
 * folds what it has not seen". Events must arrive in id order, as the log stores them.
 */
export function advance(s: State, log: Log): State {
  const dirty = new Set<string>();  // seams this batch could have changed the judgement of
  let judgeAll = false;
  const markSeams = (task: string) => { for (const id of s.seamsOf.get(task) ?? []) dirty.add(id); };
  /** An event resolved this instruction: nothing about it is a question for the clock any more. */
  const resolved = (st: InstructionState) => {
    s.pending.delete(st.instruction.id);
    // t-181：这里原来把「到期算出来的那个默认」抹掉——因为它本来就不是一条记录，只是读的时候算出来的。
    // 现在默认是服务写下的一条真事件：**一个 ack 不能抹掉它**，否则人刚翻案的那条依据就消失了。要抹的只有
    // 「到期了还没落下」这个故障态：这件事被 ack 结掉了，就不再是一个等着服务去落的默认。
    st.default_due = false;
    st.overdue = false;
  };

  for (const e of log.events) {
    if (s.ids.has(e.id)) continue;
    s.ids.add(e.id);
    if (e.from && !s.from.has(e.from)) s.from.set(e.from, e);
    const pe = s.presence.get(e.actor) ?? { last_pull: null, last_event: null };
    if (!pe.last_event || pe.last_event < e.at) pe.last_event = e.at;
    s.presence.set(e.actor, pe);
    if (e.writes?.length) invalidate(s, e);
    didAct(s, e);   // t-147: acting on an instruction is something its recipient writes down, not a receipt
    switch (e.kind) {
      case "reading":
        applyReading(s, e);
        if (readingKey(e) === `${PROJECT_SURFACE}:${ABSORB_FORM_KEY}`) judgeAll = true;  // it decides how every seam is read
        break;
      case "instruction":
        s.instructions.set(e.id, { instruction: e, reach: "unread" });
        s.pending.add(e.id);
        break;
      case "ack": {
        const st = s.instructions.get(e.of);
        if (st && !st.acked_at) { st.acked_at = e.at; st.acked_by = e.actor; resolved(st); }
        break;
      }
      case "untell": {
        const st = s.instructions.get(e.of);
        if (st && !st.withdrawn) {
          st.withdrawn = { by: e.actor, at: e.at, reason: e.reason, seen: !!st.delivered_at && st.delivered_at < e.at };
          resolved(st);
        }
        break;
      }
      case "note": {
        s.notes.push(e);
        // t-147: 「不办：<原因>」 is an answer — refusing is information, and it settles the instruction it names.
        if (e.body.startsWith(DECLINE_PREFIX)) for (const id of e.refs ?? []) {
          const st = s.instructions.get(id);
          if (st && st.instruction.to === e.actor && !st.chosen) { st.chosen = { option: DECLINE_PREFIX, by: e.actor, at: e.at, note: e.id }; s.pending.delete(id); st.overdue = false; }
        }
        // t-190：服务记下「本该按默认执行，我们没有执行」——这张卡回到等人答，不追认那个默认。
        if (e.actor === SERVICE_ACTOR && isDefaultMissed(e.body)) for (const id of e.refs ?? []) {
          const missed = s.instructions.get(id);
          if (!missed || missed.chosen) continue;
          const i0 = missed.instruction;
          missed.default_missed = { at: e.at, window_ms: Math.max(0, Date.parse(i0.ack_by) - Date.parse(i0.at)), option: i0.default ?? "" };
          s.pending.add(id);
        }
        const st = e.decides ? s.instructions.get(e.decides.of) : undefined;
        if (st && (!st.chosen || st.chosen.by === DEFAULT_DECIDER)) {
          // t-181：服务落下的那条「没人点，按默认 X」记成 DEFAULT_DECIDER，不记成服务自己——因为它不是一个
          // 决定，是一个到期。这样 R1b 里「默认可以被真人推翻」那一条照旧成立，人还是能翻案。
          const byDefault = e.actor === SERVICE_ACTOR && isDefaultApplied(e.body);
          st.chosen = { option: e.decides!.option, by: byDefault ? DEFAULT_DECIDER : e.actor, at: e.at, note: e.id };
          s.pending.delete(st.instruction.id);
          st.overdue = false;
          st.default_due = false;
        }
        if (e.task) s.tasks.get(e.task)?.notes.push(e);
        break;
      }
      case "task":
        applyTask(s, e);
        if (e.op === "seam") dirty.add(seamId(e.tasks[0], e.tasks[1]));
        else markSeams(e.task);
        break;
    }
  }

  for (const d of log.deliveries) {
    const st = s.instructions.get(d.event_id);
    if (st && !st.delivered_at) {
      st.delivered_at = d.at;
      if (st.withdrawn) st.withdrawn.seen = d.at < st.withdrawn.at;
    }
  }
  for (const c of log.cursors) {
    const pc = s.presence.get(c.actor) ?? { last_pull: null, last_event: null };
    if (!pc.last_pull || pc.last_pull < c.at) pc.last_pull = c.at;
    s.presence.set(c.actor, pc);
    // t-147: how far this actor has read. Ids order the log, so "their cursor passed it" is a comparison.
    const seen = s.read_upto.get(c.actor);
    if (c.last_event_id && (!seen || c.last_event_id > seen)) s.read_upto.set(c.actor, c.last_event_id);
  }
  reach(s);

  // t-067: a seam is judged on the tasks as they stand. Only the seams this batch could have moved are re-judged;
  // detectSeams has already judged the ones it built, and re-judging is idempotent, so a seam in both lists is free.
  for (const seam of judgeAll ? s.seams.values() : dirtySeams(s, dirty)) judgeSeam(s, seam);
  return s;
}

/**
 * t-147 (pd 05:40): set each instruction's state from what the log already knows.
 *
 * Read is a comparison — ids order the log, so a cursor that has passed the instruction's id has read it. Acted is
 * evidence the recipient left, gathered as their events arrive (see `didAct`), never by scanning afterwards.
 */
function reach(s: State): void {
  for (const st of s.instructions.values()) {
    const upto = s.read_upto.get(st.instruction.to);
    const did = s.acted.get(st.instruction.id);
    st.acted_by_event = did;
    st.reach = did ? "acted" : upto && upto >= st.instruction.id ? "read" : "unread";
  }
}

/** A ULID as it appears in prose: 26 of Crockford's base32. How an instruction gets named in a body. */
const ULID_IN_TEXT = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

/**
 * t-147: did this event show its actor acting on an instruction sent to them? Three ways, all decidable: it names it
 * in `refs`, it acks or takes it back, or it names its id in its own words.
 *
 * What is deliberately not counted: a task event that merely happens to come after one. Guessing that a `done` was
 * "because of" an instruction would make this a judgement, and the point of it is that it is a fact.
 */
function didAct(s: State, e: Event): void {
  const mine = (id: string) => s.instructions.get(id)?.instruction.to === e.actor && !s.acted.has(id);
  for (const id of e.refs ?? []) if (mine(id)) s.acted.set(id, e.id);
  if ((e.kind === "ack" || e.kind === "untell") && mine(e.of)) s.acted.set(e.of, e.id);
  const body = e.kind === "note" || e.kind === "instruction" ? e.body : undefined;
  if (body) for (const m of body.matchAll(ULID_IN_TEXT)) if (mine(m[0])) s.acted.set(m[0], e.id);
}

function* dirtySeams(s: State, ids: Set<string>): Generator<SeamState> {
  for (const id of ids) { const seam = s.seams.get(id); if (seam) yield seam; }
}

/**
 * t-128: everything in a reduction that depends on what time it is, and nothing else. It is a function of `now`, not
 * an accumulation: run it twice at two moments and the second answer is the right one for the second moment, so an
 * advanced state can be settled again and again without being rebuilt. It walks only what the clock can still change
 * — the unresolved instructions and the readings that carry a valid_until — never the whole log.
 */
/**
 * t-190: `who` 在 `at` 之后第一次露面的时刻，没有就是 undefined。露面 = 拉过一次日志，或自己写过一条事件——
 * 两者都证明这个人此刻在看，而「人再看到那一刻」正是期限该重新开始算的那一刻（判据 2）。
 */
function seenAfter(s: State, who: string, at: string): string | undefined {
  const p = s.presence.get(who);
  const times = [p?.last_pull, p?.last_event].filter((x): x is string => !!x && x >= at).sort();
  return times[0];
}

export function settle(s: State, now: Date): State {
  const nowIso = now.toISOString();
  for (const id of s.perishable) {
    const rs = s.readings.get(id);
    if (rs) rs.expired = rs.reading.valid_until! < nowIso || undefined;
  }
  for (const id of s.pending) {
    const st = s.instructions.get(id)!;
    const i = st.instruction;
    // t-181 (pd 09:18)：**默认到期不再由这里凭空算出来。**
    //
    // 以前这一段看见 ack_by 过了就把 `chosen` 填成默认值，于是牌桌显示「已按 A」而日志里一个字都没有——别人
    // sync 读不到，人也无从翻案，而我们已经对他说了那句话。现在默认生效是服务写下的一条 note（`defaultApplied`），
    // 它经 R1b 落进 `chosen`，`by` 记成 DEFAULT_DECIDER（真人仍可推翻）。这里只算**时间说了什么**：
    // 到期了、还没人点、那条事件也还没落下 —— 那是一个故障态，牌桌要照实说（DEFAULT_LINES.stuck）。
    // t-190 判据 2：记过一次「没执行」之后，期限从**人再看到那一刻**重算。人自那以后还没露过面，就还没开始
    // 算——他没看到的时间不该算进他的期限里。`deadline` 因此是 undefined，这张卡既不到期也不算晚。
    // 收件人就是人本身：带选项的卡只能发给人（rules.ts），所以不必另把 human 传进来。
    const seenAgain = st.default_missed ? seenAfter(s, i.to, st.default_missed.at) : undefined;
    st.ack_by_again = st.default_missed && seenAgain ? new Date(Date.parse(seenAgain) + st.default_missed.window_ms).toISOString() : undefined;
    const deadline = st.default_missed ? st.ack_by_again : i.ack_by;
    st.default_due = !st.chosen && i.default !== undefined && !!i.options?.length && !!deadline && deadline < nowIso;
    // t-147 判据 3 + 判据 7 (pm 07:04): overdue is a card with options, past its deadline, still unanswered.
    //
    // 判据 3 had a 「读到了」 clause and 判据 7 removed it, for a reason worth keeping next to the code: for an agent,
    // overdue means 「你欠着」, and something it never read is not owed — that is pd's 「不由回执证明」. For the human
    // the subject changes: an overdue card says 「我们还在等一个到不了的人」, and the hours nobody opened the board are
    // exactly the ones that most need saying. Treating unread as not-late would let an absence silence itself — today
    // the whole team went quiet for 4.4 hours and the board would have shown 「什么都不晚」.
    //
    // Options may only be addressed to the human (rules.ts), so this branch is only ever about the human's cards; the
    // agents' side is `owedTo` and t-139's three presence states, and nothing is counted in both.
    st.overdue = !!deadline && deadline < nowIso && !!i.options?.length && !st.chosen;
  }
  const focusId = s.latestReading.get(`${TEAM_SURFACE}:${FOCUS_KEY}`);
  s.focus = focusId ? s.readings.get(focusId)!.reading : undefined;
  return s;
}

/** The whole log, reduced at a moment: what every caller that holds no state of its own still asks for. */
export function reduce(log: Log, now: Date = new Date()): State {
  return settle(advance(empty(), log), now);
}

function invalidate(s: State, e: Event) {
  const hit = new Set(e.writes);
  for (const rs of s.readings.values()) {
    if (!rs.valid || rs.reading.id === e.id) continue;
    if (rs.reading.depends_on?.some((d) => hit.has(d))) {
      rs.valid = false;
      rs.invalidated_by = e.id;
    }
  }
}

/** The shape a reading on `surface:key` must match: what that surface:key declared, else the key's default, else none. */
export function shapeFor(s: State, surface: string, key: string): ReadingShape | undefined {
  return s.shapes.get(`${surface}:${key}`) ?? DEFAULT_SHAPES[key];
}

function applyReading(s: State, r: Reading) {
  const key = readingKey(r);
  if (r.shape && !s.shapes.has(key)) s.shapes.set(key, r.shape);
  const prevId = s.latestReading.get(key);
  if (prevId) {
    const prev = s.readings.get(prevId)!;
    if (prev.valid) { prev.valid = false; prev.superseded_by = r.id; }
  }
  const rs: ReadingState = { reading: r, valid: true };
  // t-089: a number carried in from somewhere else was never measured here. That does not depend on what time it is,
  // so it is settled once, on arrival, and the clock never has to look at it again (t-128).
  if (r.from) { rs.valid = false; rs.expired = true; rs.imported_why = "搬进来的数字：在这里没有测过，谁用谁重测"; }
  else if (r.valid_until) s.perishable.add(r.id);
  s.readings.set(r.id, rs);
  s.latestReading.set(key, r.id);
}

function applyTask(s: State, e: Event & { kind: "task" }) {
  switch (e.op) {
    case "create":
      s.tasks.set(e.task, {
        id: e.task, title: e.title, criteria: [...e.criteria], criteria_by: e.actor, criteria_added: [], refs: e.refs ?? [],
        created_at: e.at, updated_at: e.at, touches: [], status: "open", round: 0, verifications: [], history: [], notes: [],
        from: e.from, label: e.label, // t-092, t-096
        // t-171: 建这件任务的时候承诺了什么。它与 done 时的 `shows` 是两件事：一个是说好要给人什么，
        // 一个是最后真给了什么。两个都留着，牌桌才看得出承诺和交付有没有对上。
        promise: e.shows?.trim() || undefined, promise_none: e.no_human_impact || undefined,
      });
      return;
    case "seam": {
      const id = seamId(e.tasks[0], e.tasks[1]);
      const seam = s.seams.get(id) ?? { id, tasks: e.tasks, overlap: [] };
      // t-149: a second event on a resolved seam only ever adds the verdict on the gate; the resolution itself —
      // its text, its author, its time — is history and is never rewritten.
      if (seam.resolution) seam.resolution = { ...seam.resolution, verdict: e.verdict, missed: e.missed || undefined, judged_by: e.actor, judged_at: e.at, judged_why: e.resolution };
      else seam.resolution = { by: e.actor, at: e.at, text: e.resolution, verdict: e.verdict, missed: e.missed || undefined, ...(e.verdict || e.missed ? { judged_by: e.actor, judged_at: e.at } : {}) };
      s.seams.set(id, seam);
      return;
    }
  }
  const t = s.tasks.get(e.task);
  if (!t) return;
  t.updated_at = e.at;
  switch (e.op) {
    case "label":
      t.label = e.label.trim() || undefined; // t-096: a display name changes freely; the id never does
      return;
    case "claim":
      // the owner claiming again widens the declaration; anyone else claiming takes over an open/failed task
      t.touches = t.status === "working" && t.owner === e.actor ? [...new Set([...t.touches, ...e.touches])] : e.touches;
      indexTouches(s, t);   // t-121: the index follows the declaration, always
      t.owner = e.actor; t.status = "working"; t.claimed_at = e.at; t.claimed_id = e.id;
      detectSeams(s, t);
      return;
    case "done":
      t.status = "done"; t.evidence = e.evidence; t.round += 1;
      if (e.shows?.trim()) t.shows = e.shows.trim();
      t.history.push({ op: "done", id: e.id, by: e.actor, at: e.at, round: t.round, evidence: e.evidence });
      // t-105: done's touches are the final value, and seams are recomputed from it — the same rules, nothing new.
      // `undefined` says nothing; `[]` says "it touched nothing", which is a fact like any other (qa 00:29)
      if (e.touches !== undefined) { t.touches = [...new Set(e.touches.map((x) => x.trim()).filter(Boolean))]; indexTouches(s, t); detectSeams(s, t); }
      return;
    case "reopen":
      // same owner, same touches; the next done starts a new round, so every surface must be judged again
      t.status = "working"; t.blocked_on = undefined;
      t.history.push({ op: "reopen", id: e.id, by: e.actor, at: e.at, round: t.round, reason: e.reason });
      detectSeams(s, t);
      return;
    case "verify": {
      // A fail on a later surface after a pass elsewhere sends the task back to done (the earlier pass still
      // stands, per surface); a fail with nothing passed yet is a plain failed.
      const passedBefore = surfaceResults(t).some((r) => r.pass);
      t.verifications.push({ id: e.id, surface: e.surface, pass: e.pass, by: e.actor, at: e.at, evidence: e.evidence, round: t.round });
      if (e.pass && e.shows?.trim()) t.shows = e.shows.trim();
      t.history.push({ op: "verify", id: e.id, by: e.actor, at: e.at, round: t.round, surface: e.surface, pass: e.pass, evidence: e.evidence });
      t.status = e.pass ? "verified" : passedBefore ? "done" : "failed";
      return;
    }
    case "block":
      t.status = "blocked"; t.blocked_on = e.on; return;
    case "unblock":
      t.status = t.owner ? "working" : "open"; t.blocked_on = undefined; return;
    case "criteria":
      for (const text of e.add) { t.criteria.push(text); t.criteria_added.push({ index: t.criteria.length - 1, by: e.actor, at: e.at }); }
      return;
    case "withdraw":
      t.status = "withdrawn"; t.blocked_on = undefined;
      t.withdrawn = { by: e.actor, at: e.at, reason: e.reason };
      // a withdrawn task touches nothing any more: its seams go with it
      for (const id of [...(s.seamsOf.get(t.id) ?? [])]) dropSeam(s, id);
      return;
    case "obsolete":
      t.status = "obsolete"; t.blocked_on = undefined;
      t.obsolete = { by: e.actor, at: e.at, decision: e.decision, reason: e.reason };
      // nothing will be merged or verified: its seams go with it
      for (const id of [...(s.seamsOf.get(t.id) ?? [])]) dropSeam(s, id);
      return;
  }
}

/**
 * Two in-flight tasks whose declared touches intersect share a seam that someone must own.
 * If the other task was already done when this one claimed, this one stacks on it: the seam is recorded but blocks nothing.
 */
function detectSeams(s: State, t: TaskState) {
  for (const other of seamCandidates(s, t.id, t.touches)) {
    if (other.id === t.id || other.status === "verified" || other.status === "withdrawn" || other.status === "obsolete" || !other.touches.length) continue;
    const overlap = overlapOf(t.touches, other.touches);
    if (!overlap.length) {
      // t-105: recomputing is not only "find more". A revision that narrows the touches can leave a seam describing an
      // overlap that no longer exists, and a seam nobody actually has is one more thing blocking a verify for nothing.
      dropSeam(s, seamId(t.id, other.id));
      continue;
    }
    const id = seamId(t.id, other.id);
    const same_owner = !!t.owner && t.owner === other.owner;
    const light = overlapIsLight(t.touches, other.touches) || undefined;
    const existing = s.seams.get(id);
    if (existing) { existing.overlap = overlap; existing.same_owner = same_owner; existing.light = light; continue; }
    s.seams.set(id, { id, tasks: [t.id, other.id], overlap, same_owner, light });
    for (const who of [t.id, other.id]) { let ids = s.seamsOf.get(who); if (!ids) s.seamsOf.set(who, (ids = new Set())); ids.add(id); }
  }
  for (const id of s.seamsOf.get(t.id) ?? []) { const seam = s.seams.get(id); if (seam) judgeSeam(s, seam); }
}

/**
 * t-121 (P0): which tasks could possibly share a touch with `t`. Comparing every task against every other, and every
 * touch against every other touch, is O(tasks squared x touches squared) over a log that grows all day: 120 tasks with
 * 2 touches each reduce in 50ms, the same 120 tasks with 6 touches take 429ms — same number of events, 8x the work.
 *
 * Almost every one of those pairs shares nothing, and an index says so without comparing anything. Two touches can only
 * overlap if they name the same path, or if one names a directory containing the other; the first is an exact lookup,
 * and the second can only come from a touch whose last segment has no file extension, which is rare enough to keep in
 * a small set and always consider. Nothing else can match, so nothing else is looked at.
 */
/** t-121: forget a seam, and forget that either side was in it. */
function dropSeam(s: State, id: string) {
  const seam = s.seams.get(id);
  if (!seam) return;
  s.seams.delete(id);
  for (const who of seam.tasks) s.seamsOf.get(who)?.delete(id);
}

function seamCandidates(s: State, id: string, touches: string[]): Iterable<TaskState> {
  // A task that names a directory could contain anything, so it is the one case that still looks at everyone.
  if (touches.some(dirLike)) return s.tasks.values();
  const out = new Map<string, TaskState>();
  const add = (other: string) => { const o = s.tasks.get(other); if (o && o.id !== id) out.set(other, o); };
  for (const touch of touches) for (const other of s.byTouch.get(touchPath(touch)) ?? []) add(other);
  for (const other of s.dirTouchers) add(other);   // and anyone who named a directory could contain us
  return out.values();
}

const touchPath = (t: string) => t.split("#")[0].replace(/\/+$/, "");
/** A touch that could contain another: no file extension on its last segment ("packages/core/test/", "docs"). */
const dirLike = (t: string) => !t.includes("#") && !/\.[A-Za-z0-9]+$/.test(touchPath(t));

/** Keep the index in step with a task's declared touches; called wherever `touches` is set. */
function indexTouches(s: State, t: TaskState) {
  for (const path of s.touchedBy.get(t.id) ?? []) {
    const ids = s.byTouch.get(path);
    if (ids) { ids.delete(t.id); if (!ids.size) s.byTouch.delete(path); }
  }
  const mine = new Set<string>();
  s.dirTouchers.delete(t.id);
  for (const touch of t.touches) {
    const path = touchPath(touch);
    mine.add(path);
    let ids = s.byTouch.get(path);
    if (!ids) s.byTouch.set(path, (ids = new Set()));
    ids.add(t.id);
    if (dirLike(touch)) s.dirTouchers.add(t.id);
  }
  s.touchedBy.set(t.id, mine);
}

/** The latest done a task stands on: none while it is back in flight (reopened, reclaimed), so the seam is judged afresh (t-067). */
function standingDone(t: TaskState): string | undefined {
  if (t.status !== "done" && t.status !== "verified" && t.status !== "failed") return undefined;
  return [...t.history].reverse().find((h) => h.op === "done")?.id; // the event id: log order, even inside one millisecond
}

/**
 * t-160：`t` 有没有**任何一次** done 早于 `claimId`。
 *
 * 原来这里读的是 `standingDone`——最新的那一次。于是一件做完的活只要再交一次（reopen 之后重 done，今晚我为了
 * 换一个 sha 就做了两回），它与「在它第一次 done 之后才 claim 的那件」之间的接缝就重新变成开的，**它的验收当场
 * 被一件还没写代码的任务挡住**。今晚这一幕花掉三次：每次都是 qa 一次自查、pm 一次裁定、两条 tell。
 *
 * 时序说的是「那一刻这块地是不是已经有主」：后者按下 claim 的时候，前者已经是一件交出去的活——这件事**后来
 * 发生什么都不会改变它**。所以读的是历史，不是当下。后者的合并义务一点没变（判据 2）：CLI 那头对的是前者
 * **此刻**的证据 sha，前者又交了一轮，后者要合的就是新的那一轮。
 */
function doneBefore(t: TaskState, claimId: string | undefined): string | undefined {
  if (!claimId) return undefined;
  return t.history.find((h) => h.op === "done" && h.id < claimId)?.id;
}

/**
 * t-067 (absorbing t-009): a side whose done precedes the other side's claim stacks; the later side builds
 * on it and must merge it (the CLI checks that at done). Both in flight at the same time is a collision, whoever owns them.
 *
 * **t-160 判据 4：这里有两条各自独立的放行，它们不互相取代，也不互为退路。**
 * · **按时序放行**（这里的 `stacked`）：后者按下 claim 的那一刻，前者已经是一件交出去的活。放行的理由是**先后**，
 *   与两边碰了多少东西无关——重叠得再多也放行，因为后者是在一个已完成的东西上面开工的。
 * · **按重叠程度放行**（t-113 的 `light`）：两边都在途，但各自声明到了符号一级且不撞在同一个符号上。放行的理由是
 *   **粒度**，与谁先谁后无关。
 * 一条接缝可能只满足其中一条，`openSeamsFor` 对两者都放行。把它们合成一条会同时弄坏两边：只按时序，两个同时
 * 在途、明明不碰同一处的人会被无谓地挡住；只按重叠，一件做完的活又会被一件还没写代码的活挡住——那正是 t-160。
 */
function judgeSeam(s: State, seam: SeamState) {
  const [a, b] = seam.tasks.map((id) => s.tasks.get(id));
  seam.stacked = undefined;
  seam.absorbed = undefined;
  if (!a || !b) return;
  const doneA = standingDone(a), doneB = standingDone(b);
  // t-160：**时序按历史判，在途与否按当下判。**两半缺一不可：
  // · `doneA` 还是当下的——一件被 reopen、此刻又回到在途的活，不是「已经交出去的东西」，那是真碰车（t-009/t-028）。
  // · 时序用 `doneBefore` 读历史——后者按下 claim 的那一刻这块地已经有主，前者后来又交了一轮不改变那一刻。
  if (doneA && doneBefore(a, b.claimed_id)) seam.stacked = { done: a.id, on: b.id };
  else if (doneB && doneBefore(b, a.claimed_id)) seam.stacked = { done: b.id, on: a.id };
  // t-073: a resolution the rule wrote (the doer's CLI checked git) says who absorbed whom
  const written = seam.resolution && seam.resolution.text.startsWith(ABSORB_PREFIX) ? /后者 (\S+) 含前者 (\S+)/.exec(seam.resolution.text) : null;
  if (written && doneA && doneB) {
    const later = doneA > doneB ? a : b, earlier = later === a ? b : a;
    seam.absorbed = { later: later.id, earlier: earlier.id, basis: seam.resolution!.text.slice(ABSORB_PREFIX.length), by: seam.resolution!.by };
    return;
  }
  // t-073, named-sha form: judged from the log alone — the later side's evidence names the earlier side's sha
  if (!seam.resolution && doneA && doneB && absorbForm(s) === "named-sha") {
    const later = doneA > doneB ? a : b, earlier = later === a ? b : a;
    const theirs = evidenceShaOf(earlier.evidence);
    if (theirs && namesSha(later.evidence ?? "", theirs)) seam.absorbed = { later: later.id, earlier: earlier.id, basis: `后者证据写明含前者 ${theirs.slice(0, 7)}（named-sha）` };
  }
}

/** The project's declared absorb form (fact project:absorb.form), or null. */
export function absorbForm(s: State): AbsorbForm | null {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ABSORB_FORM_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  return typeof v === "string" && (ABSORB_FORMS as readonly string[]).includes(v) ? (v as AbsorbForm) : null;
}
function evidenceShaOf(evidence: string | undefined): string | null {
  const m = /(?:^|[^0-9a-zA-Z])([0-9a-f]{7,40})(?![0-9a-zA-Z])/.exec(evidence ?? "");
  return m ? m[1] : null;
}
/** The evidence names `sha` in short or long form. */
export function namesSha(evidence: string, sha: string): boolean {
  return [...evidence.matchAll(/[0-9a-f]{7,40}/g)].some((m) => sha.startsWith(m[0]) || m[0].startsWith(sha));
}

/**
 * t-105: which seams would block `t` if its touches were `touches` and it were done right now? Used to judge a revision
 * *before* it is written, so the answer must come from the same rules the log already runs — detectSeams/judgeSeam —
 * not a second judgement. Pure: the shadow state it walks is thrown away, the real one is untouched.
 */
export function blockingSeamsIfTouches(s: State, t: TaskState, touches: string[]): { with: string; overlap: string[] }[] {
  const AFTER_EVERYTHING = "\uffff"; // a done happening now cannot precede a claim already in the log
  const mine: TaskState = { ...t, touches: [...new Set(touches.map((x) => x.trim()).filter(Boolean))], status: "done",
    history: [...t.history, { op: "done", id: AFTER_EVERYTHING, by: t.owner ?? "", at: AFTER_EVERYTHING, round: t.round + 1, evidence: t.evidence }] };
  // The shadow differs from the real state in one task's touches. The touch index is only ever consulted to find
  // *other* candidates, and this task is excluded from those anyway, so it is shared rather than copied (t-121).
  const shadow: State = { ...s, tasks: new Map(s.tasks), seams: new Map([...s.seams].map(([id, x]) => [id, { ...x }])),
    seamsOf: new Map([...s.seamsOf].map(([k, v]) => [k, new Set(v)])) };
  shadow.tasks.set(t.id, mine);
  detectSeams(shadow, mine);
  return openSeamsFor(shadow, t.id).map((x) => ({ with: x.tasks.find((id) => id !== t.id) ?? "", overlap: x.overlap }));
}

/**
 * t-164 (human 点名，pd 07:57)：这块地上还有谁。
 *
 * 一进门就看见屋里有人——**不是把门锁上**。空闲的角色去别人的地盘不是错，错的是它到 done 的时候才发现屋里
 * 一直有人。所以这里只回答一个问题：我要动的这些东西，此刻还有谁正在动。
 *
 * 三条边界都在这一个函数里，不在调用方：
 * ① **只看在途**（`working`）——已经 done 的不是「还有谁在」，那是接缝要判的事，不是这里。
 * ② **排除自己**：同一个角色手上的别的活不算撞车，它自己排得开。
 * ③ **不阻塞**：返回一个列表，没有任何判定。要不要因此改主意，是看见的人自己决定。
 *
 * `exclude` 是提问者自己那件（claim 之后问，就是刚 claim 的那件）；不传就是还没有那件——`ateam touches` 的用法，
 * 在决定做不做之前就能问。
 */
export function whoElseTouches(s: State, touches: string[], me: string, exclude?: string): { actor: string; task: string; title: string; overlap: string[] }[] {
  const mine = [...new Set(touches.map((x) => x.trim()).filter(Boolean))];
  if (!mine.length) return [];
  const out: { actor: string; task: string; title: string; overlap: string[] }[] = [];
  for (const t of [...s.tasks.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (t.id === exclude || t.status !== "working" || !t.owner || t.owner === me || !t.touches.length) continue;
    const overlap = overlapOf(mine, t.touches);
    if (overlap.length) out.push({ actor: t.owner, task: t.id, title: t.title, overlap: overlap.sort() });
  }
  return out;
}

/** Seams that block verifying `task`: unresolved, not stacked (t-067: done before the other side claimed), and not one owner's own sequence (t-045). */
export function openSeamsFor(s: State, task: string): SeamState[] {
  return [...s.seams.values()].filter((x) => !x.resolution && !x.stacked && !x.same_owner && !x.absorbed && !x.light && x.tasks.includes(task));
}
