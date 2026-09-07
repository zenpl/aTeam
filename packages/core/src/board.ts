import { PD_ACTOR, SAID_PREFIX, DEFER_PREFIX, TITLE_MAX_CHARS, ROLES_KEY, PROJECT_SURFACE, DEFAULT_ROLES, PRESENCE_WINDOW_MS, LISTEN_WINDOW_MS, UNDELIVERED_AFTER_MS, SERVICE_ACTOR, FAIL_NOTICE, VERIFY_ASK, CONTACT_ASK, isContactAsk, CONTACT_SKIP, CONTACT_SKIP_WAS, ALERT_WEBHOOK_KEY, ALERT_REACHED_KEY, ALERT_NOTE_PREFIX, ALERT_FAILED, DEPLOYED_TASKS_KEY, BOARD_SHAPE, PUSH_LEVELS, NODE_SURFACE, capabilityKey, RESPONSIBILITIES, DEFAULT_RESPONSIBILITIES, type PushLevel, type Reading, type Instruction, type InstructionIntent } from "./events.js";
import { lastSeen, overturnedOn } from "./reduce.js";
import { allocation, allocationSummary, type AllocationWarning } from "./allocation.js";
import { surfaceResults, type State, type TaskState, type InstructionState, type ReadingState, type SeamState, type TaskHistoryEntry } from "./reduce.js";

/** One task as the board shows it, with everything `ateam task show` needs. */
export interface BoardTask {
  id: string;
  title: string;
  /** t-096: what people call it (an old number, say); absent when nobody set one. References are always by id. */
  label?: string;
  /** t-088: where this task came from when it was carried in; absent for one created here. */
  from?: string;
  status: string;
  /** Absent on the slim board (t-070): GET /task/<id> has them. */
  criteria?: string[];
  criteria_by?: string;
  /** Criteria added after creation: index into `criteria`, by whom, when. */
  criteria_added?: { index: number; by: string; at: string }[];
  created_at?: string;
  owner?: string;
  touches?: string[];
  blocked_on?: string;
  withdrawn?: { by: string; at: string; reason: string };
  /** Set once a decision superseded the finished task (t-057). */
  obsolete?: { by: string; at: string; decision: string; reason?: string };
  evidence?: string;
  /** The sha in the evidence, if any: what release and the seam check need without the text (t-070). */
  evidence_sha?: string;
  /** One sentence for the owner, above the evidence (t-056). */
  shows?: string;
  verifications?: { surface: string; pass: boolean; by: string; at: string; evidence?: string; round: number }[];
  /** Every done, verify and reopen in order, with the round each belongs to. */
  history?: TaskHistoryEntry[];
  /** Latest result per surface since the task was last done, e.g. repo ✓ production ✗. */
  surfaces: { surface: string; pass: boolean }[];
  /** t-076: surfaces whose pass was later overturned by a fail, with who, when and why. */
  overturned?: { surface: string; by: string; at: string; evidence?: string; passed_by: string }[];
  /** Surfaces whose latest result since the task was last done is a pass. */
  verified_on: string[];
  /** Notes attached with --task, in log order. */
  notes?: { id: string; actor: string; at: string; body: string; decision?: boolean; /** t-096 */ label?: string }[];
  /**
   * t-068: which layer of the page the task belongs to. this_version: brought by the current deploy or still in flight
   * (criteria and evidence inlined); earlier: verified on production before the current sha, or ended before it
   * (title and one line only; the rest is GET /task/<id>).
   */
  era: "this_version" | "earlier";
  /** One line for the earlier layer: status, and where it was verified. */
  summary: string;
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
    kind: InstructionIntent; id: string; from: string; body: string; title: string; /** absent on the slim board (t-077) */ detail?: string; summary: string; since: string;
    options?: string[]; default?: string; chosen?: { option: string; by: string; at: string };
  }[];
  /**
   * t-106: the name to show for a role id, wherever a person reads one — presence, a task's owner, an instruction's
   * sender and recipient, the source of a needs-you card. One map rather than a name beside every mention: a list kept
   * apart from what it describes drifts (the omitted lesson). Absent id = show the id, which is what ids are for.
   */
  role_names: Record<string, string>;
  /**
   * t-103: whether this board has an owner who can speak for themselves. `none` — nobody was ever given the address;
   * `issued` — it was given out and never opened; `in_use` — the owner has arrived, and from then on nothing else may
   * speak as them. Filled in by the server (the log knows nothing about keys), absent when it did not look.
   */
  owner_key?: { state: "none" | "issued" | "in_use"; since?: string };
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
    /** t-083: who recorded the sha by hand (a measurement, not a push); null when the push recorded it or the source is unknown. */
    checked_by: string | null;
    /** t-083: when that reading was written, so the line can say how long ago it was pushed or checked. */
    at: string | null;
    since_sha: string | null;
    verified_on_production: { id: string; title: string; shows?: string }[];
    recent: { id: string; title: string; shows?: string }[];
    earlier: { id: string; title: string; shows?: string }[];
  };
  /**
   * What is ready to ship: tasks that passed on repo in their current round and have not passed on production,
   * oldest done first, each with the sha its evidence names and who verified it where. The human reads this before a deploy.
   */
  release: {
    deployed_sha: string | null;
    /** absent on the slim board: derived from the tasks (t-070/t-077) */
    candidates?: BoardRelease[];
    /** t-078: candidates whose code is not in production yet (by the containment fact). Absent on the slim board. */
    pending_deploy?: BoardRelease[];
    /** t-078: candidates whose code runs in production with no production verification yet. Absent on the slim board. */
    deployed_unverified?: BoardRelease[];
    /** t-078: candidates the board cannot place, each with why. Absent on the slim board. */
    unknown?: (BoardRelease & { reason: string })[];
    /** t-078: the three counts, on every board. */
    counts: { pending_deploy: number; deployed_unverified: number; unknown: number };
    /** t-078: what the split rests on: the containment fact used, or why there is none. */
    basis: string;
  };
  /** What the human said on the board, newest first, each with where it went so far. */
  said: BoardSaid[];
  /** Every task that is not finished, grouped by status (open, working, blocked, done, failed): all of them, plus the 5 most recently touched for a folded view. */
  in_flight: Record<string, { total: number; /** absent on the slim board (t-077) */ shown?: BoardInFlight[]; all: BoardInFlight[] }>;
  instructions: {
    id: string; from: string; to: string; body: string; status: "pending" | "delivered" | "acked" | "overdue" | "withdrawn";
    /** t-087: set when a service notice stopped being true, with why and who took over. */
    stale?: NoticeStaleness;
    /** t-064: the sender took it back; `seen` when the recipient had already pulled it. */
    withdrawn?: { by: string; at: string; reason: string; seen: boolean };
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
  seams: { id: string; tasks: [string, string]; /** absent on the slim board for seams that are not open (t-077) */ overlap?: string[]; open: boolean; resolved?: string; stacked?: { done: string; on: string }; same_owner?: boolean; /** t-073 */ absorbed?: { later: string; earlier: string; basis: string; by?: string };
    /** t-113: both sides named symbols in the shared file and named different ones. `open` stays false: it holds nothing up. */
    light?: boolean }[];
  /** One row per declared role (fact project:roles, default five), plus any other actor seen: present when heard from within the window. */
  presence: BoardPresence[];
  /** The project's declared roles, in assignment order. */
  roles: string[];
  /** Every responsibility a role can hold, and whether someone actually holds it right now (t-059). */
  coverage: BoardCoverage[];
  /** t-069: how to reach the human when away. set: the fact exists (however it got there); skipped: 先不要 and no fact; else unanswered. */
  /**
   * t-119 (pd 01:21 的通则)：安全兜底的状态由**可达性**证明，不由字符串存在证明。四态说的都是「你收不收得到」，
   * 不是「配没配」——人关心的是有事时会不会响。`unproven` 是配上之后的默认落点，形状对也不跳过去。
   */
  alert: {
    status: "unanswered" | "skipped" | "misconfigured" | "unproven" | "reachable";
    value?: string;
    source?: "given";
    /** When the last call actually got through to this address (reachable), or last did (unproven, if ever). */
    since?: string;
    /** t-084/t-119: the one line the board shows under 线上; not a card, not clickable, never in 需要你. */
    line?: string;
  };
  /** 分配预警 (t-061): the five patterns, at most one each, and the one-line summary for the dig layer. */
  allocation: { warnings: AllocationWarning[]; summary: string };
  /** The invite link the human forwards; filled by the server for the admin, absent otherwise. */
  invite_url?: string;
  /**
   * t-077: field paths this response left out (the slim board), so "not there" can be told from "empty". An omitted field is
   * absent (undefined), never an empty value; a field that is really empty is sent as [] or null as always. Full board: [].
   */
  omitted: string[];
  /** t-080: the shape version of this board (BOARD_SHAPE). */
  shape: number;
}

export type CoverageStatus = "held" | "unheld" | "unclaimed" | "blocked";
export interface BoardCoverage {
  responsibility: string;
  name: string;
  /** held: a present role holds it. unheld: declared, nobody present. unclaimed: no role declares it. blocked: held, but a precondition fails. */
  status: CoverageStatus;
  /** Roles that declare it, and those of them present (listening) now. */
  holders: string[];
  present: string[];
  /** Why it is not held, in the team's words; empty when held. */
  reason: string;
  /** One sentence for the human, e.g. 没人管上线：pm 声明了但缺推送许可. */
  line: string;
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
  /** What this node said it may push when it joined (fact node:<role>:能力 → push); none when it never said (t-058). */
  push: PushLevel;
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

/**
 * A fail notice (t-054) or a verify ask (t-055) is about one round of one task; once the owner did the task again
 * (a newer round) or the task is no longer waiting, the instruction is true no more and leaves the lists by itself.
 */
export function serviceNoticeStale(s: State, i: Instruction): boolean {
  return !!noticeStaleness(s, i);
}

/** Why a service notice is no longer true, in the data (t-087), so every surface reads the reason instead of inventing one. */
export interface NoticeStaleness {
  /** redone: a newer round; taken_over: someone else claimed it; moved_on: the task is no longer waiting for this. */
  reason: "redone" | "taken_over" | "moved_on";
  task: string;
  /** taken_over: who took it and the claim event that says so. */
  by?: string;
  claim?: string;
}

export function noticeStaleness(s: State, i: Instruction): NoticeStaleness | null {
  const ref = i.refs?.[0];
  if (!ref) return null;
  if (i.body.includes(FAIL_NOTICE)) {
    for (const t of s.tasks.values()) {
      const v = t.verifications.find((x) => x.id === ref);
      if (!v) continue;
      if (t.round !== v.round) return { reason: "redone", task: t.id };
      // t-087: another role took the task over in this same round — the one who was asked to fix it is not on it any more
      if (t.owner && t.owner !== i.to && t.claimed_id && t.claimed_id > v.id) return { reason: "taken_over", task: t.id, by: t.owner, claim: t.claimed_id };
      return null;
    }
    return null;
  }
  if (i.body.includes(VERIFY_ASK)) {
    for (const t of s.tasks.values()) {
      const d = t.history.find((h) => h.op === "done" && h.id === ref);
      if (!d) continue;
      if (t.round !== d.round) return { reason: "redone", task: t.id };
      return t.status !== "done" ? { reason: "moved_on", task: t.id } : null;
    }
    return null;
  }
  return null;
}

/**
 * t-092: what an import actually put in this log, counted from the events that carry `from` — never from what the
 * importer claimed. In-flight tasks, decisions that still stand, imported facts, questions the human has not answered.
 */
export interface ImportCounts { tasks: number; decisions: number; readings: number; asks: number }
export function importCounts(s: State): ImportCounts {
  const superseded = new Set(s.notes.filter((n) => n.supersedes).map((n) => n.supersedes!));
  return {
    tasks: [...s.tasks.values()].filter((t) => t.from && !["verified", "withdrawn", "obsolete"].includes(t.status)).length,
    decisions: s.notes.filter((n) => n.from && n.decision && !superseded.has(n.id)).length,
    readings: [...s.readings.values()].filter((r) => r.reading.from).length,
    asks: [...s.instructions.values()].filter((st) => st.instruction.from && !st.acked_at && !st.chosen).length,
  };
}

/** The push level a role declared when it joined; "none" when the fact is missing, stale, or says something else. */
export function pushLevelOf(s: State, role: string): PushLevel {
  const id = s.latestReading.get(`${NODE_SURFACE}:${capabilityKey(role)}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  const push = v && typeof v === "object" && !Array.isArray(v) ? (v as { push?: unknown }).push : undefined;
  return typeof push === "string" && (PUSH_LEVELS as readonly string[]).includes(push) ? (push as PushLevel) : "none";
}

/** t-069: the state of "how to reach the human": the fact, or the card's answer, or neither. */
/** t-119 (pd 01:40)：兜底久不响就等于没有——七天没有新的成功，退回「没真发成功过」。 */
export const REACH_STALE_MS = 7 * 24 * 3600_000;
function stale(at: string, now: Date): boolean { return now.getTime() - Date.parse(at) > REACH_STALE_MS; }
/** 一次失败不退回，连续两次才退：一次网络抖动不该吓人（pd 01:40）。 */
function failedTwice(s: State, at: string): boolean {
  const calls = s.notes.filter((n) => n.actor === SERVICE_ACTOR && n.body.startsWith(ALERT_NOTE_PREFIX) && n.body.includes(at));
  const last2 = calls.slice(-2);
  return last2.length === 2 && last2.every((n) => n.body.includes(ALERT_FAILED));
}
function ago(at: string, now: Date): string {
  const m = Math.round((now.getTime() - Date.parse(at)) / 60_000);
  if (m < 60) return `${Math.max(m, 1)} 分钟前`;
  const h = (now.getTime() - Date.parse(at)) / 3_600_000;
  return h < 24 ? `${h.toFixed(1)} 小时前` : `${(h / 24).toFixed(1)} 天前`;
}

/** t-119: the last time a call actually got through, and to which address. Nothing else counts as proof. */
export function reachedProof(s: State): { value: string; at: string } | null {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ALERT_REACHED_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  if (!r?.valid || r.expired) return null;
  const v = r.reading.value;
  return typeof v === "string" && v.trim() ? { value: v.trim(), at: r.reading.measured_at ?? r.reading.at } : null;
}

export function alertContact(s: State, now: Date = new Date()): Board["alert"] {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ALERT_WEBHOOK_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  if (typeof v === "string" && v.trim()) {
    const at = v.trim();
    // t-084: a value that is there but is not an https webhook (recorded before the shape was declared): said, not hidden
    if (!/^https:\/\/\S+$/.test(at)) return { status: "misconfigured", value: at, source: "given", line: `这个外呼地址我们发不出去，它不是一个 https 地址。` };
    // t-119 (pd 01:21/01:40)：有个字符串不等于送得到。只有真送到过一次才敢说它是通的，证的是**这个**地址；
    // 而且证得不能太旧——兜底久不响就等于没有。配上就落在「还没真发成功过」，不因形状对而跳过去。
    const proof = reachedProof(s);
    if (proof && proof.value === at && !stale(proof.at, now) && !failedTwice(s, at)) return { status: "reachable", value: at, source: "given", since: proof.at, line: `你不在时会发到这里，最近一次成功是 ${ago(proof.at, now)}。` };
    const seen = proof && proof.value === at ? `上次成功是 ${ago(proof.at, now)}。` : "";
    return { status: "unproven", value: at, source: "given", since: proof?.value === at ? proof.at : undefined, line: `记下了外呼地址，还没真发成功过——不知道你收不收得到。${seen}` };
  }
  // t-111: a card sent before the wording changed was answered with the old word; it means the same thing.
  const skipped = [...s.instructions.values()].some((st) => isContactAsk(st.instruction.body) && (st.chosen?.option === CONTACT_SKIP || st.chosen?.option === CONTACT_SKIP_WAS));
  return { status: skipped ? "skipped" : "unanswered" };
}

/** t-069: the contact card is answered by the fact itself: once project:alert.webhook is set (by anyone, any way), it has nothing to ask. */
export function contactAskAnswered(s: State, i: Instruction): boolean {
  if (!isContactAsk(i.body)) return false;
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ALERT_WEBHOOK_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  return !!r && r.valid && !r.expired && typeof r.reading.value === "string" && !!r.reading.value.trim();
}

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
  const v = rolesFact(s);
  if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length) return v as string[];
  if (typeof v === "string" && v.trim()) return v.split(",").map((x) => x.trim()).filter(Boolean);
  if (v && typeof v === "object" && Object.keys(v).length) return Object.keys(v as object); // t-059 / t-106: keys are ids
  return DEFAULT_ROLES;
}

/** The one place that reads `project:roles`. Three shapes have been declared over time; all three still work. */
function rolesFact(s: State): unknown {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ROLES_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  return r?.valid && !r.expired ? r.reading.value : undefined;
}

/**
 * t-106: the name people read, per role id. Only the third shape carries one — `{id: {name, responsibilities}}` —
 * so most projects get an empty map and everything shows the id, which is what the id is for. A name is never used to
 * find anything: ids are forever, names are free (the same split as a task's label, t-096).
 */
export function roleNames(s: State): Record<string, string> {
  const v = rolesFact(s);
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [id, entry] of Object.entries(v as Record<string, unknown>)) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.trim() && name.trim() !== id) out[id] = name.trim();
    }
  }
  return out;
}

/**
 * Which responsibilities each role holds (t-059). A `project:roles` fact shaped {role: [ids]} says so itself; a plain list of
 * role names expands to the default packing of responsibilities.md, and a name outside it holds nothing until the project says.
 */
export function roleResponsibilities(s: State): Record<string, string[]> {
  const v = rolesFact(s);
  const out: Record<string, string[]> = {};
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) {
    for (const [role, entry] of Object.entries(v as Record<string, unknown>)) {
      const ids = heldBy(entry);
      out[role] = ids.filter((x): x is string => typeof x === "string").map((x) => responsibilityId(x));
    }
    return out;
  }
  for (const role of projectRoles(s)) out[role] = DEFAULT_RESPONSIBILITIES[role] ?? [];
  return out;
}

/**
 * What one entry of the roles map says the role holds. `["R5","R6"]` is the t-059 shape; `{responsibilities:[...]}`
 * is the t-106 shape that also carries a name. Anything else holds nothing until the project says otherwise.
 */
function heldBy(entry: unknown): unknown[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object") {
    const r = (entry as { responsibilities?: unknown }).responsibilities;
    if (Array.isArray(r)) return r;
  }
  return [];
}

/** An entry may carry a boundary after the id ("R5:数据侧", "R6 自定标准的退化给 owner"): the id is the first word. */
export function responsibilityId(entry: string): string { return entry.trim().split(/[\s:：]+/)[0]; }

/** The boundary text each role declared next to a responsibility id, keyed `${role}:${id}` (t-061 静态检查). */
export function responsibilityBoundaries(s: State): Map<string, string> {
  const v = rolesFact(s);
  const out = new Map<string, string>();
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [role, entry] of Object.entries(v as Record<string, unknown>)) {
    const ids = heldBy(entry);
    if (!ids.length) continue;
    for (const x of ids) {
      if (typeof x !== "string") continue;
      const rest = x.trim().slice(responsibilityId(x).length).replace(/^[\s:：]+/, "").trim();
      if (rest) out.set(`${role}:${responsibilityId(x)}`, rest);
    }
  }
  return out;
}

/** Who holds what right now: one row per responsibility a role can hold; the page and the CLI show the ones nobody holds. */
export function coverage(s: State, now: Date, listenWindowMs = LISTEN_WINDOW_MS): BoardCoverage[] {
  const packing = roleResponsibilities(s);
  const rows: BoardCoverage[] = [];
  for (const r of RESPONSIBILITIES) {
    if (r.holder !== "role") continue;
    const holders = Object.keys(packing).filter((role) => packing[role].includes(r.id));
    const present = holders.filter((role) => !isMissing(s, role, now, listenWindowMs));
    let status: CoverageStatus = "held", reason = "";
    if (!holders.length) { status = "unclaimed"; reason = "没有角色声明"; }
    else if (!present.length) { status = "unheld"; reason = `${holders.join("、")} 声明了但没在场`; }
    else if (r.id === "R9" && !present.some((role) => pushLevelOf(s, role) === "production")) {
      status = "blocked";
      reason = `${present.join("、")} 声明了但缺推送许可或凭据（能力事实 push=${present.map((role) => pushLevelOf(s, role)).join("/")}）`;
    }
    const line = status === "held" ? `${r.name}：${present.join("、")}` : `没人管${r.name}：${reason}`;
    rows.push({ responsibility: r.id, name: r.name, status, holders, present, reason, line });
  }
  return rows;
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
    live: { deployed_sha: null, deployed_by: null, checked_by: null, at: null, since_sha: null, verified_on_production: [], recent: [], earlier: [] },
    release: { deployed_sha: null, candidates: [], pending_deploy: [], deployed_unverified: [], unknown: [], counts: { pending_deploy: 0, deployed_unverified: 0, unknown: 0 }, basis: "" },
    said: [],
    seams: [],
    presence: [],
    roles: projectRoles(s),
    role_names: roleNames(s),
    coverage: [],
    allocation: { warnings: [], summary: "" },
    alert: { status: "unanswered" },
    omitted: [],
    shape: BOARD_SHAPE,
  };

  if (s.focus) b.focus = { body: s.focus.value, set_by: s.focus.actor, at: s.focus.at };

  for (const st of [...s.instructions.values()].sort(byId((x) => x.instruction.id))) {
    const i = st.instruction;
    const status = st.withdrawn ? "withdrawn" : st.acked_at ? "acked" : st.overdue ? "overdue" : st.delivered_at ? "delivered" : "pending";
    const toHuman = i.to === human;
    const deferNote = toHuman ? s.notes.find((n) => n.actor === human && n.body.startsWith(DEFER_PREFIX) && n.refs?.includes(i.id)) : undefined;
    b.instructions.push({
      id: i.id, from: i.actor, to: i.to, body: i.body, status, sent: i.at, delivered: st.delivered_at, acked: st.acked_at,
      kind: toHuman ? instructionKind(i) : undefined, ...(toHuman ? splitTitle(i.body) : {}),
      deferred: deferNote ? { note: deferNote.id, body: deferNote.body.slice(DEFER_PREFIX.length).trim(), at: deferNote.at } : undefined,
      options: i.options, default: i.default, withdrawn: st.withdrawn, stale: i.actor === SERVICE_ACTOR ? noticeStaleness(s, i) ?? undefined : undefined,
      chosen: st.chosen ? { option: st.chosen.option, by: st.chosen.by, at: st.chosen.at } : undefined,
    });
    if (status === "acked" || status === "withdrawn") continue;
    if (st.chosen) continue; // decided (by someone, or by its default at ack_by): nothing left to ask
    if (i.actor === SERVICE_ACTOR && missingRoleOf(i.body) && !isMissing(s, missingRoleOf(i.body)!, now, listenWindow)) continue; // the role is back
    if (i.actor === SERVICE_ACTOR && serviceNoticeStale(s, i)) continue; // the owner re-did the task, or it moved on
    if (contactAskAnswered(s, i)) continue; // t-069: the webhook fact exists, however it got there
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
      why: valid ? undefined : rs.imported_why ?? (rs.superseded_by ? `superseded by ${rs.superseded_by}` : rs.invalidated_by ? `invalidated by ${rs.invalidated_by}` : "expired"),
      assumptions: r.assumptions,
    });
  }
  // Deploys, oldest first: the current sha is the latest valid reading; the previous one is the last different value before it.
  const deploys = [...s.readings.values()].map((x) => x.reading)
    .filter((r) => r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string")
    .sort(byId((r) => r.id));
  const current = deploys.length && s.readings.get(deploys[deploys.length - 1].id)!.valid && !s.readings.get(deploys[deploys.length - 1].id)!.expired ? deploys[deploys.length - 1] : undefined;
  // shas compare by their first 7 characters: a short and a long form of the same commit are the same deploy (pd, t-026)
  if (current) {
    b.live.deployed_sha = current.value as string;
    // t-083: the one who pushed is the one whose `release --deploy` wrote the reading; anyone else who wrote it measured it.
    // A reading with no method at all says nothing about its source: neither.
    b.live.at = current.at;
    const source = deploySource(current);
    b.live.deployed_by = source === "pushed" ? current.actor : null;
    b.live.checked_by = source === "checked" ? current.actor : null;
    const previous = [...deploys].reverse().find((r) => !sameSha(r.value, current.value));
    b.live.since_sha = previous ? (previous.value as string) : null;
  }
  // when the current sha was first recorded (the same sha re-measured later, short or long, does not move the line).
  // t-120: split by the log's own order (event ids), not by wall clock. Two appends can share a millisecond — under a
  // loaded test run they do — and then `at >= at` put a verification recorded *before* the deploy on this version's
  // side, turning "这一版刚上线，还没在生产验过" into "在生产上验过 1 件". Ids are monotonic within a process and the
  // log is ordered by them, so they answer "which came first" exactly, where a timestamp only guesses.
  const currentDeploy = current ? deploys.find((r) => sameSha(r.value, current.value))! : undefined;
  const currentSince = currentDeploy?.at;
  const currentSinceId = currentDeploy?.id;

  for (const t of [...s.tasks.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    // t-068: the t-026 rule for the "recent" list, applied to every task: production-verified before the current sha, or
    // ended (withdrawn/obsolete) before it, is earlier; anything the current version brought or that is still open is this version
    const prodPasses = t.verifications.filter((v) => v.round === t.round && v.surface === "production" && v.pass);
    const prodPassId = prodPasses.map((v) => v.id).sort().pop();
    const endedAt = t.withdrawn?.at ?? t.obsolete?.at;
    const before = (at: string | undefined) => !!at && b.live.since_sha !== null && currentSince !== undefined && at < currentSince;
    // withdrawn/obsolete carry no event id, so those still compare by time; a production pass has one and uses it.
    const beforeId = (id: string | undefined) => !!id && b.live.since_sha !== null && currentSinceId !== undefined && id < currentSinceId;
    const era: "this_version" | "earlier" = beforeId(prodPassId) || before(endedAt) ? "earlier" : "this_version";
    const results0 = surfaceResults(t);
    const summary = t.status === "withdrawn" ? `已撤回：${t.withdrawn?.reason ?? ""}`
      : t.status === "obsolete" ? `已被 ${t.obsolete?.decision ?? "?"} 取代`
      : results0.length ? results0.map((r) => `${r.pass ? "✓" : "✗"} ${r.surface}`).join(" ") : t.status;
    (b.tasks[t.status] ??= []).push({
      era, summary,
      id: t.id, title: t.title, label: t.label, from: t.from, status: t.status, criteria: t.criteria, criteria_by: t.criteria_by, criteria_added: t.criteria_added, created_at: t.created_at,
      owner: t.owner, touches: t.touches, blocked_on: t.blocked_on, withdrawn: t.withdrawn, obsolete: t.obsolete, evidence: t.evidence, evidence_sha: evidenceSha(t.evidence) ?? undefined, shows: t.shows, verifications: t.verifications, history: t.history,
      surfaces: surfaceResults(t), overturned: overturnedOn(t).length ? overturnedOn(t) : undefined,
      verified_on: surfaceResults(t).filter((r) => r.pass).map((r) => r.surface),
      notes: t.notes.map((n) => ({ id: n.id, actor: n.actor, at: n.at, body: n.body, decision: n.decision, label: n.label })),
    });
    if (surfaceResults(t).some((r) => r.surface === "production" && r.pass)) {
      b.live.verified_on_production.push({ id: t.id, title: t.title, shows: t.shows });
      const recent = b.live.since_sha === null || currentSinceId === undefined || prodPassId! >= currentSinceId;
      (recent ? b.live.recent : b.live.earlier).push({ id: t.id, title: t.title, shows: t.shows });
    }
    const results = surfaceResults(t);
    // Only a task that is done or verified can ship: a reopened one is being changed, so its old repo pass is not a candidate.
    if ((t.status === "done" || t.status === "verified") && results.some((r) => r.surface === "repo" && r.pass) && !results.some((r) => r.surface === "production" && r.pass)) {
      const verified_by: Record<string, string> = {};
      for (const v of t.verifications) if (v.round === t.round && v.pass) verified_by[v.surface] = v.by;
      const lastDone = [...t.history].reverse().find((h) => h.op === "done");
      b.release.candidates!.push({
        task: t.id, title: t.title, evidence_sha: evidenceSha(t.evidence), verified_by,
        surfaces: results.filter((r) => r.pass).map((r) => r.surface), done_at: lastDone?.at ?? t.updated_at,
      });
    }
    if (t.status !== "verified" && t.status !== "withdrawn" && t.status !== "obsolete") {
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
  b.release.candidates!.sort((x, y) => x.done_at.localeCompare(y.done_at) || x.task.localeCompare(y.task));
  splitRelease(s, b);
  for (const g of Object.values(b.in_flight)) {
    g.total = g.all.length;
    g.shown = [...g.all].sort((x, y) => y.updated_at.localeCompare(x.updated_at) || y.id.localeCompare(x.id)).slice(0, IN_FLIGHT_SHOWN);
  }

  for (const seam of s.seams.values()) {
    b.seams.push({ id: seam.id, tasks: seam.tasks, overlap: seam.overlap, open: !seam.resolution && !seam.stacked && !seam.same_owner && !seam.absorbed && !seam.light, resolved: seam.resolution?.by, stacked: seam.stacked, same_owner: seam.same_owner || undefined, absorbed: seam.absorbed, light: seam.light });
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
    return { actor, role, status, present: listening, listening, push: pushLevelOf(s, actor), last_pull, last_event, idle_pull_s, idle_event_s, last_seen: last, idle_s: idleOf(last), since: last_pull };
  };
  for (const role of b.roles) { seen.add(role); b.presence.push(row(role, role)); }
  b.coverage = coverage(s, now, listenWindow);
  b.alert = alertContact(s, now);
  b.allocation.warnings = allocation(s, now, human);
  b.allocation.summary = allocationSummary(b.allocation.warnings);
  for (const actor of [...s.presence.keys()].sort()) {
    if (seen.has(actor) || actor === SERVICE_ACTOR) continue;
    b.presence.push(row(actor, undefined));
  }
  return b;
}

/** Find one task on the board by id, whatever its status. */
/** How many decided instructions the slim board keeps (what the CLI and the page show). */
export const SLIM_DECIDED = 5;

/**
 * t-070: the board as GET /board and `ateam board` return it by default: what the page and the CLI actually read, and no
 * text that grows with the log. Tasks keep title, status, owner, layer, summary, surfaces and the evidence sha; criteria,
 * evidence, notes, verifications and history are GET /task/<id>'s. Acked instructions go, except the last few decided.
 * `?full=1` / `--full` return the whole thing.
 */
export function slimBoard(b: Board): Board {
  const tasks: Board["tasks"] = {};
  for (const [status, list] of Object.entries(b.tasks)) {
    tasks[status] = list.map((t) => ({
      id: t.id, title: t.title, label: t.label, from: t.from, status: t.status, owner: t.owner, blocked_on: t.blocked_on, withdrawn: t.withdrawn, obsolete: t.obsolete,
      evidence_sha: t.evidence_sha ?? evidenceSha(t.evidence) ?? undefined, shows: t.shows,
      surfaces: t.surfaces, overturned: t.overturned, verified_on: t.verified_on, era: t.era, summary: t.summary,
    }));
  }
  const decided = b.instructions.filter((i) => i.chosen).slice(-SLIM_DECIDED);
  const instructions = b.instructions.filter((i) => i.status !== "acked" && i.status !== "withdrawn" && !i.chosen || (i.options?.length && !i.chosen) || decided.includes(i));
  // seams: open ones in full (someone must own them); resolved and stacked ones as ids and flags while a side can still be
  // done (the seam check needs them); once both sides are final they are history, and GET /task/<id> still has them
  const final = new Set(Object.values(b.tasks).flat().filter((t) => t.status === "verified" || t.status === "withdrawn" || t.status === "obsolete").map((t) => t.id));
  const seams = b.seams
    .filter((x) => x.open || ((x.resolved || x.stacked || x.light) && !x.tasks.every((id) => final.has(id))))   // t-113: a light seam is for whoever merges second, so it stays while a side can still be done
    .map((x) => (x.open ? x : { id: x.id, tasks: x.tasks, open: false, resolved: x.resolved, stacked: x.stacked, same_owner: x.same_owner, absorbed: x.absorbed, light: x.light, overlap: x.light ? x.overlap : undefined }));
  const stale = b.readings.filter((r) => !r.valid).slice(-SLIM_DECIDED);
  const readings = b.readings.filter((r) => r.valid || stale.includes(r));
  // the page reads the full board in-process; the CLI reads a card's summary, not its split title/detail; in_flight.shown is all[0..5]
  const needs_human = b.needs_human.map(({ detail: _detail, ...c }) => c);
  const in_flight: Board["in_flight"] = Object.fromEntries(Object.entries(b.in_flight).map(([k, g]) => [k, { total: g.total, all: g.all }]));
  // release candidates are derived from the tasks (evidence sha, surfaces) and grow with every finished task: `ateam release` reads the full board
  const release: Board["release"] = { deployed_sha: b.release.deployed_sha, counts: b.release.counts, basis: b.release.basis };
  // t-077: what this response left out, computed by comparing the two boards, never written by hand (qa 22:14)
  const slim: Board = { ...b, tasks, instructions, seams, readings, needs_human, in_flight, release, omitted: [] };
  slim.omitted = omittedPaths(b, slim);
  return slim;
}

/**
 * t-077: the field paths present in `full` and absent in `slim`, and the lists `slim` cut short. Recursive and name-blind:
 * a key that is in the full value and not in the slim one is "<path>.<key>"; list elements are matched by `id` when they
 * have one, else by position, and their missing keys appear once as "<path>[].<key>"; a list that lost elements appears
 * as "<path>[<n> of <m>]". Anything undefined on both sides is not a difference.
 */
export function omittedPaths(full: unknown, slim: unknown, path = ""): string[] {
  const out = new Set<string>();
  const walk = (f: unknown, s: unknown, p: string) => {
    if (Array.isArray(f) && Array.isArray(s)) {
      if (s.length < f.length) out.add(`${p}[${f.length - s.length} of ${f.length}]`);
      const byId = (xs: unknown[]) => new Map(xs.filter((x): x is { id: string } => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string").map((x) => [x.id, x]));
      const fi = byId(f), si = byId(s);
      if (fi.size === f.length && si.size === s.length) { for (const [id, fx] of fi) { const sx = si.get(id); if (sx) walk(fx, sx, `${p}[]`); } }
      else for (let i = 0; i < Math.min(f.length, s.length); i++) walk(f[i], s[i], `${p}[]`);
      return;
    }
    if (f && s && typeof f === "object" && typeof s === "object") {
      for (const k of Object.keys(f as object)) {
        const fv = (f as Record<string, unknown>)[k], sv = (s as Record<string, unknown>)[k];
        if (fv === undefined) continue;
        if (sv === undefined) out.add(`${p ? p + "." : ""}${k}`);
        else walk(fv, sv, `${p ? p + "." : ""}${k}`);
      }
    }
  };
  walk(full, slim, path);
  return [...out].filter((x) => x !== "omitted" && x !== "shape").sort();
}

/** t-083: how a production:deployed.sha reading came to be: written by `ateam release --deploy`, measured by someone, or unsaid. */
export function deploySource(r: Reading): "pushed" | "checked" | "unknown" {
  const m = r.method?.trim() ?? "";
  if (m.startsWith("ateam release --deploy")) return "pushed";
  return m ? "checked" : "unknown";
}

const sameSha = (a: unknown, b: unknown) => String(a).slice(0, 7) === String(b).slice(0, 7);

/** The containment fact as written by `ateam release` (t-078), if valid. */
export function deployedTasksFact(s: State): { sha: string; contained: string[]; not_contained: string[]; method?: string; at: string } | null {
  const id = s.latestReading.get(`production:${DEPLOYED_TASKS_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  if (!r || !r.valid || r.expired) return null;
  const v = r.reading.value as { sha?: unknown; contained?: unknown; not_contained?: unknown; method?: unknown };
  if (!v || typeof v !== "object" || typeof v.sha !== "string" || !Array.isArray(v.contained) || !Array.isArray(v.not_contained)) return null;
  return { sha: v.sha, contained: v.contained.map(String), not_contained: v.not_contained.map(String), method: typeof v.method === "string" ? v.method : undefined, at: r.reading.at };
}

/**
 * t-078: pending_deploy (code not in production) vs deployed_unverified (code in production, nobody verified it there) vs
 * unknown, each with why. The board has no git: it reads the containment fact a node measured against the deployed sha.
 */
function splitRelease(s: State, b: Board) {
  const r = b.release;
  r.pending_deploy = []; r.deployed_unverified = []; r.unknown = [];
  const fact = deployedTasksFact(s);
  const deployed = r.deployed_sha;
  let why: string | null = null;
  if (!deployed) why = "生产没有有效的 production:deployed.sha 事实";
  else if (!fact) why = `没有针对生产 ${deployed.slice(0, 7)} 的包含事实 production:${DEPLOYED_TASKS_KEY}（跑一次 ateam release，它用 git 逐件测并记下来）`;
  else if (!sameSha(fact.sha, deployed)) why = `包含事实是对 ${fact.sha.slice(0, 7)} 测的，生产已是 ${deployed.slice(0, 7)}（重跑 ateam release）`;
  r.basis = why ?? `按事实 production:${DEPLOYED_TASKS_KEY}（${fact!.method ?? "?"}，对 ${fact!.sha.slice(0, 7)} 测于 ${fact!.at}）`;
  for (const c of r.candidates!) {
    if (why) { r.unknown.push({ ...c, reason: why }); continue; }
    if (!c.evidence_sha) { r.unknown.push({ ...c, reason: "证据里没有 sha，无从比对" }); continue; }
    if (fact!.contained.includes(c.task)) r.deployed_unverified.push(c);
    else if (fact!.not_contained.includes(c.task)) r.pending_deploy.push(c);
    else r.unknown.push({ ...c, reason: `包含事实没有覆盖 ${c.task}（在它之后才 done；重跑 ateam release）` });
  }
  r.counts = { pending_deploy: r.pending_deploy.length, deployed_unverified: r.deployed_unverified.length, unknown: r.unknown.length };
}

/**
 * t-100 (display only, changes nothing in the log): the ids whose display name a reader could mistake for another row —
 * because it is another row's id, or because two rows carry the same display name. Rows outside this set stay clean.
 */
/**
 * A light seam, in one sentence (t-114 · pd 01:01). The page and the CLI say it identically — pm 01:20: a reader
 * of `ateam board` and a reader of the board should not see two different pictures of the same thing.
 *
 * Callers pass whatever their surface makes a name look like (the page passes links, the CLI passes bare ids), so
 * this holds the words and nothing else.
 */
export const SEAM_UNDECIDED = "等人裁决";
export const SEAM_SAME_FILE = "都动了同一个文件";

export function lightSeamLine(a: string, b: string, files: string): string {
  return `${a} 与 ${b} 都动了 ${files}，各自的符号不相交，验收不挡。`;
}

/**
 * The files a light seam's two sides share. Its overlap is symbol-level (`a.ts#x`, `a.ts#y`) and the two sides
 * touched *different* symbols, so the sentence names the file — printing the overlap verbatim would say they met.
 */
export function seamFiles(overlap: string[] | undefined): string[] {
  return [...new Set((overlap ?? []).map((o) => o.split("#")[0]))];
}

export function ambiguousLabels(b: Board): Set<string> {
  const tasks = Object.values(b.tasks).flat();
  const ids = new Set(tasks.map((t) => t.id));
  const byLabel = new Map<string, string[]>();
  for (const t of tasks) if (t.label) byLabel.set(t.label, [...(byLabel.get(t.label) ?? []), t.id]);
  const out = new Set<string>();
  for (const t of tasks) {
    if (!t.label) continue;
    if ((byLabel.get(t.label) ?? []).length > 1 || (ids.has(t.label) && t.label !== t.id)) out.add(t.id);
  }
  return out;
}

/**
 * t-107 (display only): what to call a role where a person reads it — its display name when the project gave it one,
 * the id otherwise. A name that could be mistaken for another role's id, or that two roles share, carries the real id
 * after it, by the same rule t-100 uses for tasks.
 */
export function roleNamer(b: Board): (id: string) => string {
  const names = b.role_names ?? {};
  const ids = new Set<string>([...Object.keys(names), ...(b.roles ?? []), ...b.presence.map((p) => p.actor)]);
  const shared = new Map<string, number>();
  for (const n of Object.values(names)) shared.set(n, (shared.get(n) ?? 0) + 1);
  return (id: string) => {
    const name = names[id];
    if (!name) return id;
    return (shared.get(name) ?? 0) > 1 || (ids.has(name) && name !== id) ? `${name} (${id})` : name;
  };
}

/**
 * t-107: role ids inside a sentence the service already wrote (a coverage gap, an allocation warning) — swap each
 * whole id for the name people read. Only exact ids are touched, so a name that happens to contain one is left alone.
 */
export function nameRoles(text: string, name: (id: string) => string, ids: string[]): string {
  let out = text;
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    const shown = name(id);
    if (shown === id) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "g"), shown);
  }
  return out;
}

/** t-100: what one row calls a task — its display name and title, and the real id only when the name is ambiguous. */
export function taskHeading(t: { id: string; title: string; label?: string }, ambiguous: Set<string>): string {
  const name = t.label ? `${t.label} ${t.title}` : t.title;
  return ambiguous.has(t.id) ? `${name} (${t.id})` : name;
}

export function boardTask(b: Board, id: string): BoardTask | undefined {
  for (const list of Object.values(b.tasks)) for (const t of list) if (t.id === id) return t;
  return undefined;
}

function byId<T>(get: (x: T) => string) {
  return (a: T, b: T) => get(a).localeCompare(get(b));
}

export type { TaskState, InstructionState, ReadingState, SeamState, Reading };
