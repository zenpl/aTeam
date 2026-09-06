import {
  type Event, type Log, type Reading, type Instruction, type Note, type ReadingShape,
  FOCUS_KEY, TEAM_SURFACE, DEFAULT_SHAPES, ABSORB_PREFIX, ABSORB_FORM_KEY, ABSORB_FORMS, PROJECT_SURFACE, type AbsorbForm } from "./events.js";

export type TaskStatus = "open" | "working" | "blocked" | "done" | "verified" | "failed" | "withdrawn" | "obsolete";

export interface TaskState {
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
  /** now > ack_by and not acked */
  overdue?: boolean;
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
  resolution?: { by: string; at: string; text: string };
  /** t-073: both sides done and the later absorbed the earlier, by the project's declared form; blocks nothing. */
  absorbed?: { later: string; earlier: string; basis: string; by?: string };
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
  notes: Note[];
  /** actor -> when they last pulled (their cursor moved: they are listening) and when they last spoke (an event). */
  presence: Map<string, Presence>;
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
  for (const x of a) if (b.some((y) => touchesOverlap(x, y))) out.add(x);
  for (const y of b) if (a.some((x) => touchesOverlap(x, y))) out.add(y);
  return [...out];
}

/** The `chosen.by` of a decision that nobody made: the default took effect when ack_by passed. */
export const DEFAULT_DECIDER = "default";

export function seamId(a: string, b: string): string {
  return "seam:" + [a, b].sort().join("+");
}

function readingKey(r: Reading): string {
  return `${r.surface}:${r.key}`;
}

export function reduce(log: Log, now: Date = new Date()): State {
  const s: State = {
    ids: new Set(),
    from: new Map(),
    readings: new Map(),
    latestReading: new Map(),
    shapes: new Map(),
    instructions: new Map(),
    tasks: new Map(),
    seams: new Map(),
    notes: [],
    presence: new Map(),
  };

  for (const e of log.events) {
    s.ids.add(e.id);
    if (e.from && !s.from.has(e.from)) s.from.set(e.from, e);
    const pe = s.presence.get(e.actor) ?? { last_pull: null, last_event: null };
    if (!pe.last_event || pe.last_event < e.at) pe.last_event = e.at;
    s.presence.set(e.actor, pe);
    if (e.writes?.length) invalidate(s, e);
    switch (e.kind) {
      case "reading": applyReading(s, e); break;
      case "instruction": s.instructions.set(e.id, { instruction: e }); break;
      case "ack": {
        const st = s.instructions.get(e.of);
        if (st && !st.acked_at) { st.acked_at = e.at; st.acked_by = e.actor; }
        break;
      }
      case "untell": {
        const st = s.instructions.get(e.of);
        if (st && !st.withdrawn) st.withdrawn = { by: e.actor, at: e.at, reason: e.reason, seen: false };
        break;
      }
      case "note": {
        s.notes.push(e);
        const st = e.decides ? s.instructions.get(e.decides.of) : undefined;
        if (st && (!st.chosen || st.chosen.by === DEFAULT_DECIDER)) st.chosen = { option: e.decides!.option, by: e.actor, at: e.at, note: e.id };
        if (e.task) s.tasks.get(e.task)?.notes.push(e);
        break;
      }
      case "task": applyTask(s, e); break;
    }
  }

  for (const d of log.deliveries) {
    const st = s.instructions.get(d.event_id);
    if (st && !st.delivered_at) st.delivered_at = d.at;
  }
  for (const c of log.cursors) {
    const pc = s.presence.get(c.actor) ?? { last_pull: null, last_event: null };
    if (!pc.last_pull || pc.last_pull < c.at) pc.last_pull = c.at;
    s.presence.set(c.actor, pc);
  }

  for (const seam of s.seams.values()) judgeSeam(s, seam); // t-067: a seam is judged on the tasks as they stand now

  const nowIso = now.toISOString();
  for (const st of s.instructions.values()) {
    const i = st.instruction;
    // An ask with a default answers itself at ack_by: the human's silence is the default, and it stays overridable.
    if (st.withdrawn) { st.withdrawn.seen = !!st.delivered_at && st.delivered_at < st.withdrawn.at; st.overdue = false; continue; } // taken back: nothing is due, no default fires
    if (!st.chosen && !st.acked_at && i.default !== undefined && i.options?.length && i.ack_by < nowIso) {
      st.chosen = { option: i.default, by: DEFAULT_DECIDER, at: i.ack_by };
    }
    st.overdue = !st.acked_at && i.ack_by < nowIso && !st.chosen;
  }
  for (const rs of s.readings.values()) {
    if (rs.reading.valid_until && rs.reading.valid_until < nowIso) rs.expired = true;
    if (rs.reading.from) { rs.expired = true; rs.valid = false; rs.imported_why = "搬进来的数字：在这里没有测过，谁用谁重测"; } // t-089
  }
  const focusId = s.latestReading.get(`${TEAM_SURFACE}:${FOCUS_KEY}`);
  if (focusId) s.focus = s.readings.get(focusId)!.reading;

  return s;
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
  s.readings.set(r.id, { reading: r, valid: true });
  s.latestReading.set(key, r.id);
}

function applyTask(s: State, e: Event & { kind: "task" }) {
  switch (e.op) {
    case "create":
      s.tasks.set(e.task, {
        id: e.task, title: e.title, criteria: [...e.criteria], criteria_by: e.actor, criteria_added: [], refs: e.refs ?? [],
        created_at: e.at, updated_at: e.at, touches: [], status: "open", round: 0, verifications: [], history: [], notes: [],
        from: e.from, label: e.label, // t-092, t-096
      });
      return;
    case "seam": {
      const id = seamId(e.tasks[0], e.tasks[1]);
      const seam = s.seams.get(id) ?? { id, tasks: e.tasks, overlap: [] };
      seam.resolution = { by: e.actor, at: e.at, text: e.resolution };
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
      t.owner = e.actor; t.status = "working"; t.claimed_at = e.at; t.claimed_id = e.id;
      detectSeams(s, t);
      return;
    case "done":
      t.status = "done"; t.evidence = e.evidence; t.round += 1;
      if (e.shows?.trim()) t.shows = e.shows.trim();
      t.history.push({ op: "done", id: e.id, by: e.actor, at: e.at, round: t.round, evidence: e.evidence });
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
      for (const [id, seam] of s.seams) if (seam.tasks.includes(t.id)) s.seams.delete(id);
      return;
    case "obsolete":
      t.status = "obsolete"; t.blocked_on = undefined;
      t.obsolete = { by: e.actor, at: e.at, decision: e.decision, reason: e.reason };
      // nothing will be merged or verified: its seams go with it
      for (const [id, seam] of s.seams) if (seam.tasks.includes(t.id)) s.seams.delete(id);
      return;
  }
}

/**
 * Two in-flight tasks whose declared touches intersect share a seam that someone must own.
 * If the other task was already done when this one claimed, this one stacks on it: the seam is recorded but blocks nothing.
 */
function detectSeams(s: State, t: TaskState) {
  for (const other of s.tasks.values()) {
    if (other.id === t.id || other.status === "verified" || other.status === "withdrawn" || other.status === "obsolete" || !other.touches.length) continue;
    const overlap = overlapOf(t.touches, other.touches);
    if (!overlap.length) continue;
    const id = seamId(t.id, other.id);
    const same_owner = !!t.owner && t.owner === other.owner;
    const existing = s.seams.get(id);
    if (existing) { existing.overlap = overlap; existing.same_owner = same_owner; continue; }
    s.seams.set(id, { id, tasks: [t.id, other.id], overlap, same_owner });
  }
  for (const seam of s.seams.values()) if (seam.tasks.includes(t.id)) judgeSeam(s, seam);
}

/** The latest done a task stands on: none while it is back in flight (reopened, reclaimed), so the seam is judged afresh (t-067). */
function standingDone(t: TaskState): string | undefined {
  if (t.status !== "done" && t.status !== "verified" && t.status !== "failed") return undefined;
  return [...t.history].reverse().find((h) => h.op === "done")?.id; // the event id: log order, even inside one millisecond
}

/**
 * t-067 (absorbing t-009): a side whose standing done precedes the other side's claim stacks; the later side builds
 * on it and must merge it (the CLI checks that at done). Both in flight at the same time is a collision, whoever owns them.
 */
function judgeSeam(s: State, seam: SeamState) {
  const [a, b] = seam.tasks.map((id) => s.tasks.get(id));
  seam.stacked = undefined;
  seam.absorbed = undefined;
  if (!a || !b) return;
  const doneA = standingDone(a), doneB = standingDone(b);
  if (doneA && b.claimed_id && doneA < b.claimed_id) seam.stacked = { done: a.id, on: b.id };
  else if (doneB && a.claimed_id && doneB < a.claimed_id) seam.stacked = { done: b.id, on: a.id };
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

/** Seams that block verifying `task`: unresolved, not stacked (t-067: done before the other side claimed), and not one owner's own sequence (t-045). */
export function openSeamsFor(s: State, task: string): SeamState[] {
  return [...s.seams.values()].filter((x) => !x.resolution && !x.stacked && !x.same_owner && !x.absorbed && x.tasks.includes(task));
}
