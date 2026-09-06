import type { Reading } from "./events.js";
import { surfaceResults, type State, type TaskState, type InstructionState, type ReadingState, type SeamState, type TaskHistoryEntry } from "./reduce.js";

/** One task as the board shows it, with everything `ateam task show` needs. */
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  criteria: string[];
  criteria_by: string;
  /** Criteria added after creation: index into `criteria`, by whom, when. */
  criteria_added: { index: number; by: string; at: string }[];
  created_at: string;
  owner?: string;
  touches: string[];
  blocked_on?: string;
  withdrawn?: { by: string; at: string; reason: string };
  evidence?: string;
  verifications: { surface: string; pass: boolean; by: string; at: string; evidence?: string; round: number }[];
  /** Every done, verify and reopen in order, with the round each belongs to. */
  history: TaskHistoryEntry[];
  /** Latest result per surface since the task was last done, e.g. repo ✓ production ✗. */
  surfaces: { surface: string; pass: boolean }[];
  /** Surfaces whose latest result since the task was last done is a pass. */
  verified_on: string[];
  /** Notes attached with --task, in log order. */
  notes: { id: string; actor: string; at: string; body: string; decision?: boolean }[];
}

export interface BoardInFlight { id: string; title: string; owner?: string; updated_at: string }

export interface BoardRelease {
  task: string;
  title: string;
  /** First git sha named in the done evidence (7-40 hex chars); null when the evidence names none. */
  evidence_sha: string | null;
  /** Surface -> who verified it there, current round, passes only. */
  verified_by: Record<string, string>;
  /** Surfaces passed in the current round. */
  surfaces: string[];
  done_at: string;
}

/** The first git sha in a piece of evidence, as a whole word, so "added" or "t-001" never count. */
export function evidenceSha(evidence: string | undefined): string | null {
  const m = /(?:^|[^0-9a-zA-Z])([0-9a-f]{7,40})(?![0-9a-zA-Z])/.exec(evidence ?? "");
  return m ? m[1] : null;
}

/** How many in-flight items a folded group shows before "N more". */
export const IN_FLIGHT_SHOWN = 5;

/** What every session reads first. Derived; nobody moves cards. */
export interface Board {
  now: string;
  focus?: { body: unknown; set_by: string; at: string };
  /** Only what the human must answer: open instructions addressed to the human. Nothing else, ever. */
  needs_human: {
    kind: "instruction"; id: string; from: string; body: string; summary: string; since: string;
    options?: string[]; default?: string; chosen?: { option: string; by: string; at: string };
  }[];
  /** Instructions to non-human actors that are past ack_by and still unacked. The team's problem, not the human's. */
  overdue: { instruction: string; to: string; from: string; body: string; ack_by: string; age_s: number }[];
  /**
   * What is true on production right now, from valid readings and production verifications.
   * `since_sha` is the previous deployed sha (null before the second deploy); `recent` are the tasks verified on
   * production since the current sha was recorded, `earlier` the rest. With no previous deploy, everything is recent.
   */
  live: {
    deployed_sha: string | null;
    since_sha: string | null;
    verified_on_production: { id: string; title: string }[];
    recent: { id: string; title: string }[];
    earlier: { id: string; title: string }[];
  };
  /**
   * What is ready to ship: tasks that passed on repo in their current round and have not passed on production,
   * oldest done first, each with the sha its evidence names and who verified it where. The human reads this before a deploy.
   */
  release: { deployed_sha: string | null; candidates: BoardRelease[] };
  /** Every task that is not finished, grouped by status (open, working, blocked, done, failed): all of them, plus the 5 most recently touched for a folded view. */
  in_flight: Record<string, { total: number; shown: BoardInFlight[]; all: BoardInFlight[] }>;
  instructions: {
    id: string; from: string; to: string; body: string; status: "pending" | "delivered" | "acked" | "overdue";
    sent: string; delivered?: string; acked?: string;
    /** present when the instruction asks the human to choose */
    options?: string[]; default?: string; chosen?: { option: string; by: string; at: string };
  }[];
  readings: { id: string; key: string; surface: string; value: unknown; at: string; by: string; valid: boolean; why?: string; assumptions?: string[] }[];
  tasks: Record<string, BoardTask[]>;
  /** `open` seams block verification until someone owns them. `stacked` names the task that was done first and the one that claimed on top of it; such a seam blocks nothing. */
  seams: { id: string; tasks: [string, string]; overlap: string[]; open: boolean; resolved?: string; stacked?: { done: string; on: string } }[];
  presence: { actor: string; last_seen: string; idle_s: number }[];
}

export function board(s: State, human: string, now: Date = new Date()): Board {
  const nowIso = now.toISOString();
  const b: Board = {
    now: nowIso,
    needs_human: [],
    overdue: [],
    instructions: [],
    readings: [],
    tasks: {},
    in_flight: {},
    live: { deployed_sha: null, since_sha: null, verified_on_production: [], recent: [], earlier: [] },
    release: { deployed_sha: null, candidates: [] },
    seams: [],
    presence: [],
  };

  if (s.focus) b.focus = { body: s.focus.value, set_by: s.focus.actor, at: s.focus.at };

  for (const st of [...s.instructions.values()].sort(byId((x) => x.instruction.id))) {
    const i = st.instruction;
    const status = st.acked_at ? "acked" : st.overdue ? "overdue" : st.delivered_at ? "delivered" : "pending";
    b.instructions.push({
      id: i.id, from: i.actor, to: i.to, body: i.body, status, sent: i.at, delivered: st.delivered_at, acked: st.acked_at,
      options: i.options, default: i.default,
      chosen: st.chosen ? { option: st.chosen.option, by: st.chosen.by, at: st.chosen.at } : undefined,
    });
    if (status === "acked") continue;
    if (st.chosen) continue; // decided (by someone, or by its default at ack_by): nothing left to ask
    if (i.to === human) {
      const ask = i.options?.length ? `  [${i.options.join(" | ")}${i.default ? `; default ${i.default}` : ""}]` : "";
      b.needs_human.push({
        kind: "instruction", id: i.id, from: i.actor, body: i.body, summary: `${i.actor}: ${i.body}${ask}`, since: i.at,
        options: i.options, default: i.default,
        chosen: undefined, // a decided ask never reaches needs_human; the field stays for consumers that read one shape
      });
    }
    else if (status === "overdue") b.overdue.push({ instruction: i.id, to: i.to, from: i.actor, body: i.body, ack_by: i.ack_by, age_s: Math.max(0, Math.round((now.getTime() - Date.parse(i.ack_by)) / 1000)) });
  }

  for (const rs of [...s.readings.values()].sort(byId((x) => x.reading.id))) {
    const r = rs.reading;
    if (r.surface === "team" && r.key === "focus") continue;
    const valid = rs.valid && !rs.expired;
    b.readings.push({
      id: r.id, key: r.key, surface: r.surface, value: r.value, at: r.at, by: r.actor, valid,
      why: valid ? undefined : rs.superseded_by ? `superseded by ${rs.superseded_by}` : rs.invalidated_by ? `invalidated by ${rs.invalidated_by}` : "expired",
      assumptions: r.assumptions,
    });
  }
  // Deploys, oldest first: the current sha is the latest valid reading; the previous one is the last different value before it.
  const deploys = [...s.readings.values()].map((x) => x.reading)
    .filter((r) => r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string")
    .sort(byId((r) => r.id));
  const current = deploys.length && s.readings.get(deploys[deploys.length - 1].id)!.valid && !s.readings.get(deploys[deploys.length - 1].id)!.expired ? deploys[deploys.length - 1] : undefined;
  if (current) {
    b.live.deployed_sha = current.value as string;
    const previous = [...deploys].reverse().find((r) => r.value !== current.value);
    b.live.since_sha = previous ? (previous.value as string) : null;
  }
  // when the current sha was first recorded (the same sha re-measured later does not move the line)
  const currentSince = current ? deploys.find((r) => r.value === current.value)!.at : undefined;

  for (const t of [...s.tasks.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    (b.tasks[t.status] ??= []).push({
      id: t.id, title: t.title, status: t.status, criteria: t.criteria, criteria_by: t.criteria_by, criteria_added: t.criteria_added, created_at: t.created_at,
      owner: t.owner, touches: t.touches, blocked_on: t.blocked_on, withdrawn: t.withdrawn, evidence: t.evidence, verifications: t.verifications, history: t.history,
      surfaces: surfaceResults(t),
      verified_on: surfaceResults(t).filter((r) => r.pass).map((r) => r.surface),
      notes: t.notes.map((n) => ({ id: n.id, actor: n.actor, at: n.at, body: n.body, decision: n.decision })),
    });
    if (surfaceResults(t).some((r) => r.surface === "production" && r.pass)) {
      b.live.verified_on_production.push({ id: t.id, title: t.title });
      const passedAt = t.verifications.filter((v) => v.round === t.round && v.surface === "production" && v.pass).map((v) => v.at).sort().pop()!;
      const recent = b.live.since_sha === null || currentSince === undefined || passedAt >= currentSince;
      (recent ? b.live.recent : b.live.earlier).push({ id: t.id, title: t.title });
    }
    const results = surfaceResults(t);
    if (results.some((r) => r.surface === "repo" && r.pass) && !results.some((r) => r.surface === "production" && r.pass)) {
      const verified_by: Record<string, string> = {};
      for (const v of t.verifications) if (v.round === t.round && v.pass) verified_by[v.surface] = v.by;
      const lastDone = [...t.history].reverse().find((h) => h.op === "done");
      b.release.candidates.push({
        task: t.id, title: t.title, evidence_sha: evidenceSha(t.evidence), verified_by,
        surfaces: results.filter((r) => r.pass).map((r) => r.surface), done_at: lastDone?.at ?? t.updated_at,
      });
    }
    if (t.status !== "verified" && t.status !== "withdrawn") {
      const g = (b.in_flight[t.status] ??= { total: 0, shown: [], all: [] });
      g.all.push({ id: t.id, title: t.title, owner: t.owner, updated_at: t.updated_at });
    }
  }
  b.release.deployed_sha = b.live.deployed_sha;
  b.release.candidates.sort((x, y) => x.done_at.localeCompare(y.done_at) || x.task.localeCompare(y.task));
  for (const g of Object.values(b.in_flight)) {
    g.total = g.all.length;
    g.shown = [...g.all].sort((x, y) => y.updated_at.localeCompare(x.updated_at) || y.id.localeCompare(x.id)).slice(0, IN_FLIGHT_SHOWN);
  }

  for (const seam of s.seams.values()) {
    b.seams.push({ id: seam.id, tasks: seam.tasks, overlap: seam.overlap, open: !seam.resolution && !seam.stacked, resolved: seam.resolution?.by, stacked: seam.stacked });
  }

  for (const [actor, last] of s.presence) {
    b.presence.push({ actor, last_seen: last, idle_s: Math.max(0, Math.round((now.getTime() - Date.parse(last)) / 1000)) });
  }
  b.presence.sort((a, b) => a.actor.localeCompare(b.actor));
  return b;
}

/** Find one task on the board by id, whatever its status. */
export function boardTask(b: Board, id: string): BoardTask | undefined {
  for (const list of Object.values(b.tasks)) for (const t of list) if (t.id === id) return t;
  return undefined;
}

function byId<T>(get: (x: T) => string) {
  return (a: T, b: T) => get(a).localeCompare(get(b));
}

export type { TaskState, InstructionState, ReadingState, SeamState, Reading };
