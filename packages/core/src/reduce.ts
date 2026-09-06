import {
  type Event, type Log, type Reading, type Instruction, type Note, type ReadingShape,
  FOCUS_KEY, TEAM_SURFACE, DEFAULT_SHAPES,
} from "./events.js";

export type TaskStatus = "open" | "working" | "blocked" | "done" | "verified" | "failed" | "withdrawn";

export interface TaskState {
  id: string;
  title: string;
  criteria: string[];
  criteria_by: string;
  created_at: string;
  owner?: string;
  touches: string[];
  status: TaskStatus;
  blocked_on?: string;
  /** Set once the task is withdrawn (terminal). The id stays in the log; nothing else happens to it. */
  withdrawn?: { by: string; at: string; reason: string };
  evidence?: string;
  /** How many times the owner has said done. Verifications belong to the round they were made in. */
  round: number;
  /** Every verification ever recorded, on every surface, in every round. Nothing is dropped. */
  verifications: TaskVerification[];
  /** Notes attached with `task`, in log order. */
  notes: Note[];
}

export interface TaskVerification { surface: string; pass: boolean; by: string; at: string; evidence?: string; round: number }

/** Latest result per surface in the current round: what the board shows next to the task. */
export function surfaceResults(t: TaskState): { surface: string; pass: boolean }[] {
  const latest = new Map<string, boolean>();
  for (const v of t.verifications) if (v.round === t.round) latest.set(v.surface, v.pass);
  return [...latest].map(([surface, pass]) => ({ surface, pass }));
}

/** Has this surface already passed in the current round? A second pass there says nothing new. */
export function passedOn(t: TaskState, surface: string): boolean {
  return t.verifications.some((v) => v.round === t.round && v.surface === surface && v.pass);
}

export interface ReadingState {
  reading: Reading;
  /** false when a later write hit one of depends_on, or when superseded by a newer reading of the same surface:key. */
  valid: boolean;
  invalidated_by?: string;
  superseded_by?: string;
  /** set at board time when valid_until has passed */
  expired?: boolean;
}

export interface InstructionState {
  instruction: Instruction;
  delivered_at?: string;
  acked_at?: string;
  acked_by?: string;
  /** now > ack_by and not acked */
  overdue?: boolean;
  /** For instructions with options: the option picked, by whom, and the decision note that records it. */
  chosen?: { option: string; by: string; at: string; note: string };
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
  resolution?: { by: string; at: string; text: string };
}

export interface State {
  readings: Map<string, ReadingState>;
  /** surface:key -> event id of the latest reading */
  latestReading: Map<string, string>;
  /** key -> declared value shape (defaults plus the first reading that declared one) */
  shapes: Map<string, ReadingShape>;
  instructions: Map<string, InstructionState>;
  tasks: Map<string, TaskState>;
  seams: Map<string, SeamState>;
  notes: Note[];
  /** actor -> last time we heard from them (event or cursor) */
  presence: Map<string, string>;
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

export function seamId(a: string, b: string): string {
  return "seam:" + [a, b].sort().join("+");
}

function readingKey(r: Reading): string {
  return `${r.surface}:${r.key}`;
}

export function reduce(log: Log, now: Date = new Date()): State {
  const s: State = {
    readings: new Map(),
    latestReading: new Map(),
    shapes: new Map(Object.entries(DEFAULT_SHAPES)),
    instructions: new Map(),
    tasks: new Map(),
    seams: new Map(),
    notes: [],
    presence: new Map(),
  };

  for (const e of log.events) {
    s.presence.set(e.actor, e.at);
    if (e.writes?.length) invalidate(s, e);
    switch (e.kind) {
      case "reading": applyReading(s, e); break;
      case "instruction": s.instructions.set(e.id, { instruction: e }); break;
      case "ack": {
        const st = s.instructions.get(e.of);
        if (st && !st.acked_at) { st.acked_at = e.at; st.acked_by = e.actor; }
        break;
      }
      case "note": {
        s.notes.push(e);
        const st = e.decides ? s.instructions.get(e.decides.of) : undefined;
        if (st && !st.chosen) st.chosen = { option: e.decides!.option, by: e.actor, at: e.at, note: e.id };
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
    const prev = s.presence.get(c.actor);
    if (!prev || prev < c.at) s.presence.set(c.actor, c.at);
  }

  const nowIso = now.toISOString();
  for (const st of s.instructions.values()) {
    st.overdue = !st.acked_at && st.instruction.ack_by < nowIso;
  }
  for (const rs of s.readings.values()) {
    if (rs.reading.valid_until && rs.reading.valid_until < nowIso) rs.expired = true;
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

function applyReading(s: State, r: Reading) {
  if (r.shape && !s.shapes.has(r.key)) s.shapes.set(r.key, r.shape);
  const key = readingKey(r);
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
        id: e.task, title: e.title, criteria: e.criteria, criteria_by: e.actor,
        created_at: e.at, touches: [], status: "open", round: 0, verifications: [], notes: [],
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
  switch (e.op) {
    case "claim":
      // the owner claiming again widens the declaration; anyone else claiming takes over an open/failed task
      t.touches = t.status === "working" && t.owner === e.actor ? [...new Set([...t.touches, ...e.touches])] : e.touches;
      t.owner = e.actor; t.status = "working";
      detectSeams(s, t);
      return;
    case "done":
      t.status = "done"; t.evidence = e.evidence; t.round += 1; return;
    case "verify": {
      // A fail on a later surface after a pass elsewhere sends the task back to done (the earlier pass still
      // stands, per surface); a fail with nothing passed yet is a plain failed.
      const passedBefore = surfaceResults(t).some((r) => r.pass);
      t.verifications.push({ surface: e.surface, pass: e.pass, by: e.actor, at: e.at, evidence: e.evidence, round: t.round });
      t.status = e.pass ? "verified" : passedBefore ? "done" : "failed";
      return;
    }
    case "block":
      t.status = "blocked"; t.blocked_on = e.on; return;
    case "unblock":
      t.status = t.owner ? "working" : "open"; t.blocked_on = undefined; return;
    case "withdraw":
      t.status = "withdrawn"; t.blocked_on = undefined;
      t.withdrawn = { by: e.actor, at: e.at, reason: e.reason };
      // a withdrawn task touches nothing any more: its seams go with it
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
    if (other.id === t.id || other.status === "verified" || other.status === "withdrawn" || !other.touches.length) continue;
    const overlap = overlapOf(t.touches, other.touches);
    if (!overlap.length) continue;
    const id = seamId(t.id, other.id);
    const stacked = other.status === "done" ? { done: other.id, on: t.id } : undefined;
    const existing = s.seams.get(id);
    if (existing) { existing.overlap = overlap; existing.stacked = stacked; continue; }
    s.seams.set(id, { id, tasks: [t.id, other.id], overlap, stacked });
  }
}

/** Seams that block verifying `task`: unresolved and not stacked. */
export function openSeamsFor(s: State, task: string): SeamState[] {
  return [...s.seams.values()].filter((x) => !x.resolution && !x.stacked && x.tasks.includes(task));
}
