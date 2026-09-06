import {
  type Event, type Log, type Reading, type Instruction, type Note,
  FOCUS_KEY, TEAM_SURFACE,
} from "./events.js";

export type TaskStatus = "open" | "working" | "blocked" | "done" | "verified" | "failed";

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
  evidence?: string;
  verifications: { surface: string; pass: boolean; by: string; at: string; evidence?: string }[];
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
}

export interface SeamState {
  id: string;
  tasks: [string, string];
  overlap: string[];
  resolution?: { by: string; at: string; text: string };
}

export interface State {
  readings: Map<string, ReadingState>;
  /** surface:key -> event id of the latest reading */
  latestReading: Map<string, string>;
  instructions: Map<string, InstructionState>;
  tasks: Map<string, TaskState>;
  seams: Map<string, SeamState>;
  notes: Note[];
  /** actor -> last time we heard from them (event or cursor) */
  presence: Map<string, string>;
  focus?: Reading;
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
      case "note": s.notes.push(e); break;
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
        created_at: e.at, touches: [], status: "open", verifications: [],
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
      t.owner = e.actor; t.touches = e.touches; t.status = "working";
      detectSeams(s, t);
      return;
    case "done":
      t.status = "done"; t.evidence = e.evidence; return;
    case "verify":
      t.verifications.push({ surface: e.surface, pass: e.pass, by: e.actor, at: e.at, evidence: e.evidence });
      t.status = e.pass ? "verified" : "failed";
      return;
    case "block":
      t.status = "blocked"; t.blocked_on = e.on; return;
    case "unblock":
      t.status = t.owner ? "working" : "open"; t.blocked_on = undefined; return;
  }
}

/** Two in-flight tasks whose declared touches intersect share a seam that someone must own. */
function detectSeams(s: State, t: TaskState) {
  for (const other of s.tasks.values()) {
    if (other.id === t.id || other.status === "verified" || !other.touches.length) continue;
    const overlap = t.touches.filter((x) => other.touches.includes(x));
    if (!overlap.length) continue;
    const id = seamId(t.id, other.id);
    const existing = s.seams.get(id);
    if (existing) { existing.overlap = overlap; continue; }
    s.seams.set(id, { id, tasks: [t.id, other.id], overlap });
  }
}

export function openSeamsFor(s: State, task: string): SeamState[] {
  return [...s.seams.values()].filter((x) => !x.resolution && x.tasks.includes(task));
}
