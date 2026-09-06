import { PD_ACTOR, SAID_PREFIX, DEFER_PREFIX, TITLE_MAX_CHARS, ROLES_KEY, PROJECT_SURFACE, DEFAULT_ROLES, PRESENCE_WINDOW_MS, LISTEN_WINDOW_MS, UNDELIVERED_AFTER_MS, SERVICE_ACTOR, type Reading, type Instruction, type InstructionIntent } from "./events.js";
import { lastSeen } from "./reduce.js";
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

/** How an instruction to the human reads: asked, or derived (options → ask, otherwise do). */
export function instructionKind(i: Pick<Instruction, "intent" | "options">): InstructionIntent {
  return i.intent ?? (i.options?.length ? "ask" : "do");
}

/**
 * The first sentence (up to the first 。！？, colon, or line break) is the card title when it is at most 30 characters;
 * otherwise the title is empty and the whole body is the detail.
 */
export function splitTitle(body: string): { title: string; detail: string } {
  const text = body.trim();
  const m = /[。！？：:\n]/.exec(text);
  const first = (m ? text.slice(0, m.index) : text).trim();
  const rest = m ? text.slice(m.index + 1).trim() : "";
  if (!first || [...first].length > TITLE_MAX_CHARS) return { title: "", detail: text };
  return { title: first, detail: rest };
}

export type SaidStatus = "received" | "requirement" | "task" | "live";
export interface BoardSaid {
  id: string;
  /** The sentence as typed, without the "human 说：" prefix. */
  body: string;
  at: string;
  status: SaidStatus;
  /** Ready to show: 已收到 / 已成为需求 / 已成为任务：<标题> / 已上线 */
  label: string;
  links: { requirements: string[]; tasks: { id: string; title: string; status: string }[] };
}

export const SAID_LABEL: Record<SaidStatus, string> = { received: "已收到", requirement: "已成为需求", task: "已成为任务", live: "已上线" };

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
    /** ask: answer it; do: do it and say "done"; info: read it. */
    kind: InstructionIntent; id: string; from: string; body: string; title: string; detail: string; summary: string; since: string;
    options?: string[]; default?: string; chosen?: { option: string; by: string; at: string };
  }[];
  /** Instructions nobody has pulled yet, 5 minutes after they were sent, by recipient: who is not receiving (t-048). */
  undelivered: { to: string; count: number; oldest_sent: string; listening: boolean }[];
  /** Instructions to non-human actors that are past ack_by and still unacked. The team's problem, not the human's. */
  overdue: { instruction: string; to: string; from: string; body: string; ack_by: string; age_s: number }[];
  /**
   * What is true on production right now, from valid readings and production verifications.
   * `since_sha` is the previous deployed sha (null before the second deploy); `recent` are the tasks verified on
   * production since the current sha was recorded, `earlier` the rest. With no previous deploy, everything is recent.
   */
  live: {
    deployed_sha: string | null;
    /** Who recorded the current deployed sha: a role (the team pushed) or the human. */
    deployed_by: string | null;
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
  /** What the human said on the board, newest first, each with where it went so far. */
  said: BoardSaid[];
  /** Every task that is not finished, grouped by status (open, working, blocked, done, failed): all of them, plus the 5 most recently touched for a folded view. */
  in_flight: Record<string, { total: number; shown: BoardInFlight[]; all: BoardInFlight[] }>;
  instructions: {
    id: string; from: string; to: string; body: string; status: "pending" | "delivered" | "acked" | "overdue";
    sent: string; delivered?: string; acked?: string;
    /** For instructions to the human: how it reads on the board, and the first sentence as a title. */
    kind?: InstructionIntent; title?: string; detail?: string;
    /** The human acked with "not now" and said why. */
    deferred?: { note: string; body: string; at: string };
    /** present when the instruction asks the human to choose */
    options?: string[]; default?: string; chosen?: { option: string; by: string; at: string };
  }[];
  readings: {
    id: string; key: string; surface: string; value: unknown; at: string; by: string; valid: boolean; why?: string; assumptions?: string[];
    /** When the world was measured (equal to `at` unless the reading said otherwise), and how long after it was written down. */
    measured_at: string; recorded_after_s: number;
    /** The record came more than half the validity period after the measurement: treat with care. */
    late: boolean;
    valid_until?: string;
  }[];
  tasks: Record<string, BoardTask[]>;
  /** `open` seams block verification until someone owns them. `stacked` names the task that was done first and the one that claimed on top of it; such a seam blocks nothing. */
  seams: { id: string; tasks: [string, string]; overlap: string[]; open: boolean; resolved?: string; stacked?: { done: string; on: string }; same_owner?: boolean }[];
  /** One row per declared role (fact project:roles, default five), plus any other actor seen: present when heard from within the window. */
  presence: BoardPresence[];
  /** The project's declared roles, in assignment order. */
  roles: string[];
  /** The invite link the human forwards; filled by the server for the admin, absent otherwise. */
  invite_url?: string;
}

export interface BoardPresence {
  actor: string;
  /** The role this row is (same as actor for roles; undefined for an actor outside the role set, e.g. the human). */
  role?: string;
  /** listening: pulled within the listen window. deaf: spoke recently but is not pulling, so instructions do not reach it. missing: neither. */
  status: "listening" | "deaf" | "missing";
  /** Same as listening: only a node that pulls counts as here (t-047). */
  present: boolean;
  listening: boolean;
  last_pull: string | null;
  last_event: string | null;
  idle_pull_s: number | null;
  idle_event_s: number | null;
  /** The later of last_pull and last_event. */
  last_seen: string | null;
  idle_s: number | null;
  /** Missing or deaf since its last pull (null if it never pulled); listening since its last pull. */
  since: string | null;
}

export interface BoardOptions { /** How long since the last pull a node still counts as listening; default 5 minutes. */ listenWindowMs?: number }

/** The role a service card is about, from its first words; undefined for any other instruction. */
export function missingRoleOf(body: string): string | undefined {
  return /^(\S+) (已经缺了|没在听了|可能失联) /.exec(body)?.[1];
}

/** Is nobody listening as this role: no pull within the listen window? Never pulled counts as missing (t-047). */
export function isMissing(s: State, role: string, now: Date, listenWindowMs = LISTEN_WINDOW_MS): boolean {
  const last = s.presence.get(role)?.last_pull;
  return !last || now.getTime() - Date.parse(last) > listenWindowMs;
}

/** The project's roles: the latest valid `project:roles` reading, else the default five. */
export function projectRoles(s: State): string[] {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ROLES_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v as string[];
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean);
  return DEFAULT_ROLES;
}

export function board(s: State, human: string, now: Date = new Date(), opts: BoardOptions = {}): Board {
  const listenWindow = opts.listenWindowMs ?? LISTEN_WINDOW_MS;
  const nowIso = now.toISOString();
  const b: Board = {
    now: nowIso,
    needs_human: [],
    undelivered: [],
    overdue: [],
    instructions: [],
    readings: [],
    tasks: {},
    in_flight: {},
    live: { deployed_sha: null, deployed_by: null, since_sha: null, verified_on_production: [], recent: [], earlier: [] },
    release: { deployed_sha: null, candidates: [] },
    said: [],
    seams: [],
    presence: [],
    roles: projectRoles(s),
  };

  if (s.focus) b.focus = { body: s.focus.value, set_by: s.focus.actor, at: s.focus.at };

  for (const st of [...s.instructions.values()].sort(byId((x) => x.instruction.id))) {
    const i = st.instruction;
    const status = st.acked_at ? "acked" : st.overdue ? "overdue" : st.delivered_at ? "delivered" : "pending";
    const toHuman = i.to === human;
    const deferNote = toHuman ? s.notes.find((n) => n.actor === human && n.body.startsWith(DEFER_PREFIX) && n.refs?.includes(i.id)) : undefined;
    b.instructions.push({
      id: i.id, from: i.actor, to: i.to, body: i.body, status, sent: i.at, delivered: st.delivered_at, acked: st.acked_at,
      kind: toHuman ? instructionKind(i) : undefined, ...(toHuman ? splitTitle(i.body) : {}),
      deferred: deferNote ? { note: deferNote.id, body: deferNote.body.slice(DEFER_PREFIX.length).trim(), at: deferNote.at } : undefined,
      options: i.options, default: i.default,
      chosen: st.chosen ? { option: st.chosen.option, by: st.chosen.by, at: st.chosen.at } : undefined,
    });
    if (status === "acked") continue;
    if (st.chosen) continue; // decided (by someone, or by its default at ack_by): nothing left to ask
    if (i.actor === SERVICE_ACTOR && missingRoleOf(i.body) && !isMissing(s, missingRoleOf(i.body)!, now, listenWindow)) continue; // the role is back
    if (i.to === human) {
      const ask = i.options?.length ? `  [${i.options.join(" | ")}${i.default ? `; default ${i.default}` : ""}]` : "";
      b.needs_human.push({
        kind: instructionKind(i), ...splitTitle(i.body), id: i.id, from: i.actor, body: i.body, summary: `${i.actor}: ${i.body}${ask}`, since: i.at,
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
    const measured = r.measured_at ?? r.at;
    const recordedAfter = Math.max(0, Math.round((Date.parse(r.at) - Date.parse(measured)) / 1000));
    const validFor = r.valid_until ? Date.parse(r.valid_until) - Date.parse(measured) : undefined;
    b.readings.push({
      id: r.id, key: r.key, surface: r.surface, value: r.value, at: r.at, by: r.actor, valid,
      measured_at: measured, recorded_after_s: recordedAfter, late: validFor !== undefined && recordedAfter * 1000 > validFor / 2, valid_until: r.valid_until,
      why: valid ? undefined : rs.superseded_by ? `superseded by ${rs.superseded_by}` : rs.invalidated_by ? `invalidated by ${rs.invalidated_by}` : "expired",
      assumptions: r.assumptions,
    });
  }
  // Deploys, oldest first: the current sha is the latest valid reading; the previous one is the last different value before it.
  const deploys = [...s.readings.values()].map((x) => x.reading)
    .filter((r) => r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string")
    .sort(byId((r) => r.id));
  const current = deploys.length && s.readings.get(deploys[deploys.length - 1].id)!.valid && !s.readings.get(deploys[deploys.length - 1].id)!.expired ? deploys[deploys.length - 1] : undefined;
  // shas compare by their first 7 characters: a short and a long form of the same commit are the same deploy (pd, t-026)
  const sameSha = (a: unknown, b: unknown) => String(a).slice(0, 7) === String(b).slice(0, 7);
  if (current) {
    b.live.deployed_sha = current.value as string;
    b.live.deployed_by = current.actor;
    const previous = [...deploys].reverse().find((r) => !sameSha(r.value, current.value));
    b.live.since_sha = previous ? (previous.value as string) : null;
  }
  // when the current sha was first recorded (the same sha re-measured later, short or long, does not move the line)
  const currentSince = current ? deploys.find((r) => sameSha(r.value, current.value))!.at : undefined;

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
    // Only a task that is done or verified can ship: a reopened one is being changed, so its old repo pass is not a candidate.
    if ((t.status === "done" || t.status === "verified") && results.some((r) => r.surface === "repo" && r.pass) && !results.some((r) => r.surface === "production" && r.pass)) {
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
  // What the human said, and where each sentence went: a pd decision note or a task that refs it, then production.
  const tasks = [...s.tasks.values()];
  for (const n of s.notes) {
    if (n.actor !== human || !n.body.startsWith(SAID_PREFIX)) continue;
    const requirements = s.notes.filter((x) => x.actor === PD_ACTOR && x.decision && x.refs?.includes(n.id)).map((x) => x.id);
    const linked = tasks.filter((t) => t.refs.includes(n.id));
    const live = linked.filter((t) => surfaceResults(t).some((r) => r.surface === "production" && r.pass));
    const status: SaidStatus = live.length ? "live" : linked.length ? "task" : requirements.length ? "requirement" : "received";
    const label = status === "task" ? `${SAID_LABEL.task}：${linked.map((t) => t.title).join("、")}`
      : status === "live" ? `${SAID_LABEL.live}：${live.map((t) => t.title).join("、")}` : SAID_LABEL[status];
    b.said.push({
      id: n.id, body: n.body.slice(SAID_PREFIX.length).trim(), at: n.at, status, label,
      links: { requirements, tasks: linked.map((t) => ({ id: t.id, title: t.title, status: t.status })) },
    });
  }
  b.said.sort((x, y) => y.id.localeCompare(x.id));

  b.release.deployed_sha = b.live.deployed_sha;
  b.release.candidates.sort((x, y) => x.done_at.localeCompare(y.done_at) || x.task.localeCompare(y.task));
  for (const g of Object.values(b.in_flight)) {
    g.total = g.all.length;
    g.shown = [...g.all].sort((x, y) => y.updated_at.localeCompare(x.updated_at) || y.id.localeCompare(x.id)).slice(0, IN_FLIGHT_SHOWN);
  }

  for (const seam of s.seams.values()) {
    b.seams.push({ id: seam.id, tasks: seam.tasks, overlap: seam.overlap, open: !seam.resolution && !seam.stacked && !seam.same_owner, resolved: seam.resolution?.by, stacked: seam.stacked, same_owner: seam.same_owner || undefined });
  }

  // who is not receiving: pending (never pulled) instructions older than 5 minutes, by recipient
  const pendingBy = new Map<string, string[]>();
  for (const st of s.instructions.values()) {
    const i = st.instruction;
    if (st.delivered_at || st.acked_at || i.to === human) continue;
    if (now.getTime() - Date.parse(i.at) < UNDELIVERED_AFTER_MS) continue;
    (pendingBy.get(i.to) ?? pendingBy.set(i.to, []).get(i.to)!).push(i.at);
  }
  for (const [to, sent] of [...pendingBy].sort()) {
    b.undelivered.push({ to, count: sent.length, oldest_sent: sent.sort()[0], listening: !isMissing(s, to, now, listenWindow) });
  }

  const seen = new Set<string>();
  const row = (actor: string, role: string | undefined): BoardPresence => {
    const p = s.presence.get(actor);
    const idleOf = (iso: string | null) => (iso ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000)) : null);
    const last_pull = p?.last_pull ?? null, last_event = p?.last_event ?? null, last = lastSeen(p);
    const idle_pull_s = idleOf(last_pull), idle_event_s = idleOf(last_event);
    const listening = idle_pull_s !== null && idle_pull_s * 1000 <= listenWindow;
    const spoke = idle_event_s !== null && idle_event_s * 1000 <= PRESENCE_WINDOW_MS;
    const status = listening ? "listening" : spoke ? "deaf" : "missing";
    return { actor, role, status, present: listening, listening, last_pull, last_event, idle_pull_s, idle_event_s, last_seen: last, idle_s: idleOf(last), since: last_pull };
  };
  for (const role of b.roles) { seen.add(role); b.presence.push(row(role, role)); }
  for (const actor of [...s.presence.keys()].sort()) {
    if (seen.has(actor) || actor === SERVICE_ACTOR) continue;
    b.presence.push(row(actor, undefined));
  }
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
