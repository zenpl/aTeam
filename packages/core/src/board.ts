import type { Reading } from "./events.js";
import { surfaceResults, type State, type TaskState, type InstructionState, type ReadingState, type SeamState } from "./reduce.js";

/** One task as the board shows it, with everything `ateam task show` needs. */
export interface BoardTask {
  id: string;
  title: string;
  status: string;
  criteria: string[];
  criteria_by: string;
  created_at: string;
  owner?: string;
  touches: string[];
  blocked_on?: string;
  withdrawn?: { by: string; at: string; reason: string };
  evidence?: string;
  verifications: { surface: string; pass: boolean; by: string; at: string; evidence?: string; round: number }[];
  /** Latest result per surface since the task was last done, e.g. repo ✓ production ✗. */
  surfaces: { surface: string; pass: boolean }[];
  /** Surfaces whose latest result since the task was last done is a pass. */
  verified_on: string[];
}

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
  /** What is true on production right now, from valid readings and production verifications. */
  live: { deployed_sha: string | null; verified_on_production: { id: string; title: string }[] };
  /** Every task that is not finished, grouped by status: open, working, blocked, done, failed. */
  in_flight: Record<string, { id: string; title: string; owner?: string }[]>;
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
    live: { deployed_sha: null, verified_on_production: [] },
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
    if (valid && r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string") b.live.deployed_sha = r.value;
  }

  for (const t of [...s.tasks.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    (b.tasks[t.status] ??= []).push({
      id: t.id, title: t.title, status: t.status, criteria: t.criteria, criteria_by: t.criteria_by, created_at: t.created_at,
      owner: t.owner, touches: t.touches, blocked_on: t.blocked_on, withdrawn: t.withdrawn, evidence: t.evidence, verifications: t.verifications,
      surfaces: surfaceResults(t),
      verified_on: surfaceResults(t).filter((r) => r.pass).map((r) => r.surface),
    });
    if (surfaceResults(t).some((r) => r.surface === "production" && r.pass)) b.live.verified_on_production.push({ id: t.id, title: t.title });
    if (t.status !== "verified" && t.status !== "withdrawn") (b.in_flight[t.status] ??= []).push({ id: t.id, title: t.title, owner: t.owner });
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
