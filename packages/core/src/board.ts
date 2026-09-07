import { PD_ACTOR, SAID_PREFIX, DECLINE_PREFIX, DEFER_PREFIX, TITLE_MAX_CHARS, ROLES_KEY, PROJECT_SURFACE, DEFAULT_ROLES, PRESENCE_WINDOW_MS, LISTEN_WINDOW_MS, UNDELIVERED_AFTER_MS, SERVICE_ACTOR, FAIL_NOTICE, VERIFY_ASK, CONTACT_ASK, isContactAsk, CONTACT_SKIP, CONTACT_SKIP_WAS, ALERT_WEBHOOK_KEY, ALERT_REACHED_KEY, ALERT_NOTE_PREFIX, ALERT_FAILED, DEPLOYED_TASKS_KEY, BATCH_PREFIX, BATCH_SURFACE, STOOD_IN_PREFIX, STAND_IN_DAY_MS, type BatchValue, BOARD_SHAPE, PUSH_LEVELS, NODE_SURFACE, capabilityKey, RESPONSIBILITIES, DEFAULT_RESPONSIBILITIES, type PushLevel, type Reading, type Instruction, type InstructionIntent, type Reach, type Gate, GATES, gateFixKey } from "./events.js";
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
/**
 * t-129: what a packed batch is worth right now. `current` — it is still packed on where production is. `stale` — it
 * was packed on an older head but carries everything production carries, so re-packing is all it needs. `rollback` —
 * production has finished work this batch does not contain, so pushing it would take that work back off production.
 * `unknown` — the log cannot say, and says why rather than guessing.
 *
 * The two kinds of expiry are told apart by *task lists*, not by git ancestry: production's own containment fact
 * (production:deployed.tasks) names what it carries, and a batch names what it contains. That works inside core,
 * which has no git — and it answers the question a person actually asks, "what would I lose", by name.
 */
/**
 * t-167 (pd 08:13)：一批相对生产站在哪儿。**这是一张按「它此刻在哪」分的表，不是按「它将来会怎样」分的。**
 *
 * 原来的四格是 pd 01:39 按后者定的——「还没上线」的三种情形想全了，唯独没有「已经上线了」那一格，而世界一定
 * 会走到那一格：每一批推上去的那一刻，它的 base 落后一格，它自己就翻成 rollback，于是牌桌开始对**正在生产上
 * 跑的那一版**说「推它会把 85 件退回去，重装别推」。第 10、11、12、13 批同时在说这句假话。
 *
 * 所以补的是格，不是 if。而且要补两格，不是一格：**「就是现在生产上跑的那一版」和「早先上过线、现在被后面
 * 的批次盖过去了」是两件事**，只补前者的话，第 9、10、11、12 批仍然在说「推它会把 85 件退回去，重装别推」——
 * 同一句假话，换成对过去说。今晚牌桌上那五行里有四行是这一种。
 *
 * 分格的问题是「它此刻在哪」：已经是生产 / 曾经是生产 / 装在生产头上还没推 / 落在生产后面 / 算不出来。
 */
export type BatchState = "deployed" | "shipped" | "current" | "stale" | "rollback" | "unknown";
export interface BoardBatch {
  name: string;
  sha: string;
  /** The production head it was packed on. */
  base: string;
  contains: string[];
  state: BatchState;
  /** For `rollback`: the tasks production carries and this batch does not. Empty otherwise. */
  loses: string[];
  /** The one sentence for a person, from core so the page and the CLI cannot drift apart (t-118). */
  line: string;
  /**
   * t-167：这一批还在等人推吗。已经上过线的（`deployed`/`shipped`）不是候选——上线清单是「接下来要发生什么」，
   * 它们属于「已经发生了什么」（pd 08:13）。这个判断在 core 一处，渲染方不各自去筛一遍状态名。
   */
  pending: boolean;
  at: string;
}

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
   * t-139 (pd 05:15): overdue instructions split by whether their recipient is there, because the three states cost
   * different things and are fixed different ways. `missing` — nobody is pulling, so nothing arrives and only a person
   * can start one. `deaf` — the node is alive and talking but not pulling, so instructions are piling up unseen.
   * `listening` — it is receiving them and simply has not acked, which is a nudge, not an emergency.
   *
   * Never one number. release listening with 22 unacked and a role that has been gone for hours are not the same
   * trouble, and adding them up produced a figure that made the second invisible behind the first.
   */
  overdue_by_presence: Record<"missing" | "deaf" | "listening", BoardOverdueGroup>;
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
  /**
   * t-129: the batches this project has packed, newest first, each judged against where production actually is.
   * A batch that no longer matches production is not merely marked stale: it says which of the two kinds it is,
   * because they need opposite things done. On every board — a batch nobody can act on is the thing that goes wrong.
   */
  batches: BoardBatch[];
  /**
   * t-149: 每一道**此刻不可信**的闸的那一句实话。可信的闸不在这里，也不留占位符（判据 4）。
   * 判据 3：它的位置是挖层与报告——不进首屏、不生成给人的卡，所以瘦身板里没有它。
   */
  gate_honesty: GateHonesty[];
  /** What the human said on the board, newest first, each with where it went so far. */
  said: BoardSaid[];
  /** Every task that is not finished, grouped by status (open, working, blocked, done, failed): all of them, plus the 5 most recently touched for a folded view. */
  in_flight: Record<string, { total: number; /** absent on the slim board (t-077) */ shown?: BoardInFlight[]; all: BoardInFlight[] }>;
  instructions: {
    id: string; from: string; to: string; body: string; status: "pending" | "delivered" | "acked" | "overdue" | "withdrawn";
    /**
     * t-147: how far it actually got — `unread` / `read` / `acted`, worked out from the recipient's own pulls and
     * events, not from a receipt. This is what a renderer shows; `status` is the older delivery bookkeeping.
     * `acted_by_event` is the event that proves it, so a reader can go look instead of taking the word for it.
     */
    reach: Reach; acted_by_event?: string;
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
    /**
     * t-154 (pd 07:14): 结构化的值在牌桌上只说这一句话，不印 value。标量没有这个字段——它们照旧。
     * `said_elsewhere` 是给渲染方的信号：牌桌别处已经说过这条，重复不重复由它定，但由 core 告诉它。
     */
    said?: ReadingSaid;
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
  /**
   * t-130: how many times a person did by hand what a finished rule would have done, grouped by that rule. For the
   * dig layer and the reports — never the 一眼 layer: this is a number about how the team is running, not something
   * the human has to answer. `since` is the window it counts over (a day).
   */
  stand_ins: { total: number; since: string; by_task: { task: string; title: string; count: number; last_at: string; who: string[] }[]; summary: string };
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

export interface BoardOverdueGroup {
  /** Roles in this state that have overdue instructions. */
  roles: string[];
  /** How many overdue instructions their recipients are sitting on. */
  count: number;
  /**
   * How long the longest-gone recipient has been out of touch, in seconds. `null` when there is no such fact — the
   * recipient is listening, or has never read the log at all and so there is no moment to count from.
   */
  away_s: number | null;
  /** The instruction ids, so a reader can go and look. */
  instructions: string[];
  /** pd 05:15's sentence for this state, or "" when there is nothing in it. */
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
/**
 * 「多久以前」，全项目一句话一个说法（t-180，pd 09:09 定的梯子）。牌桌、命令行、core 自己拼的句子都走这里。
 *
 * 梯子：不到 1 分钟「刚刚」／不到 1 小时「N 分钟前」／不到 1 天「N 小时前」／其余「N 天前」。
 * 三条硬规矩，都是 pd 定的，不是风格：① 一律向下取整，不四舍五入——四舍五入会让「59 分钟」说成「1 小时前」，
 * 把一个还没到的时刻说成已经到了；② 永远不出现小数，人读相对时间是为了一眼知道新旧，「1.2 小时前」逼他去算；
 * ③ 绝对时刻只放在 title 里，不进这句话。
 *
 * 合并之前这段逻辑在仓库里有四份（core 这里、页面的 UI.ago、命令行的 howLong、下面 sayReading 里那句只会说分钟的），
 * 99% 的时刻里至少两份说法不同。pd 09:09：重复的不只是句子，还有把数变成句子的那段逻辑。
 */
export function ago(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return AGO_JUST_NOW;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  return `${Math.floor(sec / 86400)} 天前`;
}
export const AGO_JUST_NOW = "刚刚";
const agoAt = (at: string, now: Date) => ago(now.getTime() - Date.parse(at));

/** t-119: the last time a call actually got through, and to which address. Nothing else counts as proof. */
export function reachedProof(s: State): { value: string; at: string } | null {
  // t-134: the proof is only worth anything if the one who wrote it could not have been wrong or lying about it.
  // Whether an outbound call reached the human is something only the service that made it knows, so only the service's
  // own record of it counts. Reading the latest one *by the service* rather than the latest one full stop matters in
  // both directions: a node cannot manufacture a proof, and it cannot destroy one either by writing over it.
  let proof: Reading | undefined;
  for (const rs of s.readings.values()) {
    if (rs.reading.actor !== SERVICE_ACTOR || readingKeyOf(rs.reading) !== `${PROJECT_SURFACE}:${ALERT_REACHED_KEY}`) continue;
    if (rs.invalidated_by || rs.expired) continue;   // something it depended on was rewritten, or it is too old to mean anything
    proof = rs.reading;                              // readings are held in log order: the last one standing is the newest
  }
  const v = proof?.value;
  return typeof v === "string" && v.trim() ? { value: v.trim(), at: proof!.measured_at ?? proof!.at } : null;
}

const readingKeyOf = (r: Reading) => `${r.surface}:${r.key}`;

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
    if (proof && proof.value === at && !stale(proof.at, now) && !failedTwice(s, at)) return { status: "reachable", value: at, source: "given", since: proof.at, line: `你不在时会发到这里，${agoAt(proof.at, now)}成功过一次。` };
    // t-180 · pd 09:17 选 C：时间短语一律在句首，一种骨架管四档。一个句框若只有某几档填得进去，
    // 那不是那一档特殊，是句框错了——「最近一次成功是 刚刚。」不是中文，加一条特例也只是把它藏起来。
    const seen = proof && proof.value === at ? `${agoAt(proof.at, now)}成功过一次。` : "";
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

/**
 * t-139 (pd 05:15): the card the service raises about a role nobody is answering for. Its words are core's, in one
 * place, because the board says the same thing in `overdue_by_presence` and two derivations of one sentence drift
 * (t-118). The remedy differs with the state and so does the sentence: a role nobody is running has to be started;
 * a node that is alive but no longer pulling has to be listening again, and starting a second one is the crude way.
 */
export function missingCard(role: string, status: "missing" | "deaf", awayMin: number | null, count: number): string {
  // The card asks the human for the one thing a human can do. What separates the two states is what is *true*, not a
  // second instruction: this node is still writing, and saying so is what stops the reader concluding it has died.
  // pd 06:04 retired 「没在听」 for the verb we can actually observe — whether it has come and read the log.
  //
  // `awayMin` is null when the role has never read the log at all, and then there is no such thing as how long it has
  // been away — there is no moment to count from. Both sides of this used to invent one anyway, and differently: the
  // board said 1 minute (a floor of one on zero) and the card said 10 (the length of the presence window), for the
  // same role at the same instant (qa 06:07). Saying what is missing is the rule this repo already has (t-091).
  const been = awayMin === null ? "从没读过日志" : status === "deaf" ? `有 ${awayMin} 分钟没读日志了` : `缺人 ${awayMin} 分钟`;
  return status === "deaf"
    ? `${role} ${been}，${count} 条没送到——它还在写，只是没来读。起一个 ${role}？`
    : `${role} ${been}，${count} 条没送到。起一个 ${role}？`;
}

/**
 * The role a service card is about, from its first words; undefined for any other instruction.
 * The older openings stay recognised: cards sent before t-139 are still in the log and still name their role.
 */
export function missingRoleOf(body: string): string | undefined {
  return /^(\S+) (?:(已经缺了|没在听了|没在听|缺人|可能失联) |有 \d+ 分钟没读日志了|从没读过日志)/.exec(body)?.[1];
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
    overdue_by_presence: { missing: { roles: [], count: 0, away_s: null, instructions: [], line: "" }, deaf: { roles: [], count: 0, away_s: null, instructions: [], line: "" }, listening: { roles: [], count: 0, away_s: null, instructions: [], line: "" } },
    gate_honesty: [],
    instructions: [],
    readings: [],
    tasks: {},
    in_flight: {},
    live: { deployed_sha: null, deployed_by: null, checked_by: null, at: null, since_sha: null, verified_on_production: [], recent: [], earlier: [] },
    release: { deployed_sha: null, candidates: [], pending_deploy: [], deployed_unverified: [], unknown: [], counts: { pending_deploy: 0, deployed_unverified: 0, unknown: 0 }, basis: "" },
    batches: [],
    said: [],
    seams: [],
    presence: [],
    roles: projectRoles(s),
    role_names: roleNames(s),
    coverage: [],
    allocation: { warnings: [], summary: "" },
    stand_ins: { total: 0, since: "", by_task: [], summary: "" },
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
      reach: st.reach, acted_by_event: st.acted_by_event,
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
    // t-147: overdue is now「读到了、带选项、到期仍没答案」, and options may only be addressed to the human
    // (rules.ts), so every overdue thing is a card the human is sitting on. It used to be pushed here only for
    // *non*-human recipients, which after the redefinition would have left this list permanently empty — and the
    // team would have had nowhere to see that a decision it is waiting on has gone past its time. It is not a second
    // count of NEEDS HUMAN: that list says 「你要做的」, this one says 「这件晚了」, and t-139's three states never
    // hold the human, so nothing is counted twice.
    if (status === "overdue") b.overdue.push({ instruction: i.id, to: i.to, from: i.actor, body: i.body, ack_by: i.ack_by, age_s: Math.max(0, Math.round((now.getTime() - Date.parse(i.ack_by)) / 1000)) });
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
      // t-154: 结构化的值在牌桌上只说一句话。渲染方印这一句，不印 value——value 留在字段里给要挖的人。
      said: sayReading({ surface: r.surface, key: r.key, value: r.value, by: r.actor, at: r.at }, now) ?? undefined,
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
  b.stand_ins = standIns(s, now);   // t-130: for the dig layer and the reports, never 一眼
  for (const actor of [...s.presence.keys()].sort()) {
    if (seen.has(actor) || actor === SERVICE_ACTOR) continue;
    b.presence.push(row(actor, undefined));
  }
  // The human is not grouped by presence: NEEDS HUMAN is its own list, and 「起一个 human」 is not a thing to say.
  b.gate_honesty = GATES.map((g) => gateHonesty(s, g)).filter((x): x is GateHonesty => x !== null);
  b.overdue_by_presence = overdueByPresence(b, owedTo(s).filter((st) => st.instruction.to !== human).map((st) => ({ instruction: st.instruction.id, to: st.instruction.to })));
  return b;
}

/**
 * t-147: what an agent still owes — everything addressed to it that nobody has acted on. Read off `reach`, not off
 * `overdue`: since t-147 only a card with options can be overdue, so counting the unanswered pile from `overdue`
 * would have lost every plain instruction and double-counted the cards. A notice whose reason stopped being true
 * (t-087: the owner redid it, another role took the task over) is owed by nobody — it is still unread, and chasing
 * somebody for work already done is worse than silence. The human is not in here: NEEDS HUMAN is its own list.
 *
 * One definition, two readers: the board's `overdue_by_presence` and the service's 「起一个」 card. When they were
 * two filters they drifted, and a role could be quiet with three unread instructions and no card raised for it.
 */
export function owedTo(s: State, to?: string): InstructionState[] {
  return [...s.instructions.values()].filter(
    (st) =>
      !st.withdrawn && !st.chosen && st.reach !== "acted" &&
      (to === undefined || st.instruction.to === to) &&
      (st.instruction.actor !== SERVICE_ACTOR || !noticeStaleness(s, st.instruction)),
  );
}

/**
 * t-154 (pd 07:14): 牌桌只说一条事实的**一句话**，不印它的值。
 *
 * 今天的洞是这样露出来的：读数那一节把 `surface:key = <值>` 直接印出来，于是 `production:deployed.tasks` 在人
 * 眼前是一大段 JSON——83 个任务 id。人从那一段里得不到任何东西，而它占掉的正是他本该用来读别的话的注意力。
 *
 * 所以：**结构化的值必须在这里声明「这条事实的一句话怎么说」**。没有声明的一律退化成「<名字> 由 X 在 N 分钟前
 * 记下」——名字没声明就退回它的 `surface:key`，那是一个标识符，不是一个值。标量不受这条影响（判据 2）：一个数、
 * 一个 sha、一句话，印出来本身就是那句话。
 *
 * `said_elsewhere` 是给渲染方的信号，不是给它的判断（判据 4）：牌桌别处已经说过这条事实的，这里标出来，渲染方
 * 据此决定要不要重复，而不是自己去猜哪些键在别处出现过。
 */
export interface ReadingSaying {
  /** 这条事实的中文名。 */
  name: string;
  /** 这一句话怎么说。值的形状不对时返回 null，退化成没有声明的那种说法——猜一个数比不说更坏。 */
  say?: (value: unknown) => string | null;
  /** 牌桌别处已经说过它（判据 4 的信号）。 */
  said_elsewhere?: boolean;
  /**
   * 判据 5：一个**从真实日志取来的**值，样本日志据此造这条读数。
   *
   * 它在这里而不在夹具里，是为了让「声明了一个说法」与「夹具里有这个形状」成为同一件事：加一条声明就自动多一条
   * 样本，t-136 那道闸随即看得到这句话有没有人印。今天这个洞正是反过来的——夹具里没有生产上真实存在的形状，于是
   * 一段 83 个 id 的 JSON 印在人眼前，没有任何用例发现。值取自 2026-09-07 的生产日志，形状照抄，长度截短。
   */
  sample: unknown;
  /**
   * 这条事实由服务自己写（`project:allocation` 就是），样本日志不造它——造了会被服务写的那条取代，
   * 于是「用构造器造的日志」与「服务真跑出来的日志」不再逐字段相等，t-062 那道闸会当场红。
   */
  service_writes?: boolean;
}

/**
 * 声明表。键是 `surface:key`，或 `surface:prefix*`（`repo:batch.*` 这种一族一个说法的）。
 *
 * 表里只有牌桌真的要说的那几条。今晚生产上还有十几条一次性的测量读数（`production:wait.cli`、`board.cost`、
 * `s0.walk`…），它们**故意**不在这里：给每一次测量都编一句话，等于逼人去维护一张与测量本身分开的清单，那正是
 * 今晚反复出问题的形状。它们退化，退化后的那句话是真的。
 */
export const READING_SAYINGS: { surface: string; key: string; prefix?: boolean; saying: ReadingSaying }[] = [
  {
    surface: "production", key: DEPLOYED_TASKS_KEY,
    saying: {
      name: "这一版带上的活",
      // 判据 4：这一句就是 pm 07:1x 定的那句。数从值里数出来，不从别处抄。
      say: (v) => (isTaskList(v) ? `这一版带上了 ${(v as { contained: string[] }).contained.length} 件` : null),
      said_elsewhere: true,   // 「线上」那一行已经说过这一版是什么
      sample: { sha: "b3e3c53fbe19fac3c20dd0248751b517f1be93b5", contained: ["t-005", "t-004", "t-007"], not_contained: ["t-130", "t-131"], method: "git-ancestor（ateam release 用 git merge-base --is-ancestor 逐件测）" },
    },
  },
  {
    surface: BATCH_SURFACE, key: BATCH_PREFIX, prefix: true,
    saying: {
      name: "装好的一批",
      say: (v) => (isBatch(v) ? `这一批装了 ${(v as BatchValue).contains.length} 件` : null),
      said_elsewhere: true,   // 「上线清单」那一节逐批说过
      sample: { sha: "b23b3258e6940b1af1c90e2d97629a270b535bca", base: "b3e3c53fbe19fac3c20dd0248751b517f1be93b5", contains: ["t-130", "t-131", "t-133"] },
    },
  },
  { surface: PROJECT_SURFACE, key: ROLES_KEY, saying: { name: "角色与职责", said_elsewhere: true, sample: { pd: ["R1", "R2", "R3"], pm: ["R4", "R8:接缝裁决"], dev: ["R5:后端"], qa: ["R6", "R12"] } } },
  { surface: PROJECT_SURFACE, key: "allocation", saying: { name: "分配预警", said_elsewhere: true, service_writes: true, sample: { count: 1, warnings: [{ pattern: "低效", evidence: ["release 的 ack 延迟 p90 140 分钟，其他角色中位数 3 分钟"], hint: "release 的 ack 延迟 p90 140 分钟" }] } } },
  { surface: PROJECT_SURFACE, key: "deploy.enabled", saying: { name: "谁能推上线", said_elsewhere: true, sample: { branch: "production", by: ["release"] } } },
  { surface: NODE_SURFACE, key: "", prefix: true, saying: { name: "节点能力", said_elsewhere: true, sample: { push: "production" } } },
];

function isTaskList(v: unknown): boolean {
  return !!v && typeof v === "object" && Array.isArray((v as { contained?: unknown }).contained);
}
function isBatch(v: unknown): boolean {
  return !!v && typeof v === "object" && Array.isArray((v as { contains?: unknown }).contains);
}

/** t-154: 这条读数在牌桌上的那一句话。标量返回 null——它们照旧，值就是那句话（判据 2）。 */
export interface ReadingSaid {
  line: string;
  /** 这一句是声明出来的（true），还是退化来的（false）。 */
  declared: boolean;
  /** 牌桌别处已经说过它：渲染方据此决定要不要重复（判据 4）。 */
  said_elsewhere: boolean;
}

export function sayingFor(surface: string, key: string): ReadingSaying | undefined {
  return READING_SAYINGS.find((x) => x.surface === surface && (x.prefix ? key.startsWith(x.key) : key === x.key))?.saying;
}

export function sayReading(r: { surface: string; key: string; value: unknown; by: string; at: string }, now: Date): ReadingSaid | null {
  if (!r.value || typeof r.value !== "object") return null;   // 判据 2：标量照旧
  const saying = sayingFor(r.surface, r.key);
  const said = saying?.say?.(r.value) ?? null;
  // t-180: 这一句过去永远只会说分钟（17 小时的读数说成「1052 分钟前」）。走同一道梯子。
  const when = agoAt(r.at, now);
  return {
    line: said ?? `${saying?.name ?? `${r.surface}:${r.key}`}，${when}由 ${r.by} 记下`,
    declared: said !== null,
    said_elsewhere: !!saying?.said_elsewhere,
  };
}

/**
 * t-149: 一道闸知道自己不可信时，它的每条结论都要带上实话。
 *
 * 「不可信」不是一个手写的开关，也不是谁的印象：它由日志算出来——这道闸报过的结论里，有多少条被人核对之后
 * 判为误报或漏报，以及是否存在一件以它为成因、还没在生产上验过的修法。两个条件都成立，这句话才出现；任何一个
 * 不成立，它就不出现，也不留占位符（判据 4：今晚 t-139 那种「两处各编一个数」的形状不许再有）。
 *
 * 数只数**被声明过的判决**（seam 事件上的 verdict/missed 字段）。没判过的既不算真也不算假，句子里如实说还有
 * 几条没判——一道自陈不可信的闸，绝不该顺手替谁编一个数。
 */
export interface GateHonesty {
  gate: Gate;
  /** 这道闸至今产生过多少条结论（接缝闸：它检出的每一条接缝）。 */
  reported: number;
  /** 其中被人核对并声明过判决的。 */
  judged: number;
  /** 判为误报的。 */
  false_positives: number;
  /** 声明过「它还漏报了」的。与判决正交：真接缝也可能同时是一次漏报。 */
  missed: number;
  /** 还没有人判过的。 */
  unjudged: number;
  /** 修法：`project:gate.<闸>.fix` 指的那件任务，以及它此刻走到哪儿。 */
  fix?: { task: string; status: string; verified_on: string[]; in_production: boolean };
  /** 判据 1 的那一句，core 一处算出，唯一 key。 */
  line: string;
}

/** t-149 判据 1 的那一句。措辞待 pd 定稿（我已发给它）；在那之前这是唯一一处出处，改也只改这里。 */
function honestyLine(h: Omit<GateHonesty, "line">): string {
  const what = h.false_positives || h.missed
    ? `${h.judged} 条经核对，其中 ${h.false_positives} 条是误报${h.missed ? `、${h.missed} 条还漏报了` : ""}`
    : `${h.judged} 条经核对`;
  const rest = h.unjudged ? `，另有 ${h.unjudged} 条没人判过` : "";
  const fix = h.fix
    ? `修法在 ${h.fix.task}，${h.fix.in_production ? "已在生产上" : h.fix.verified_on.length ? `已验（${h.fix.verified_on.join("、")}），还没上生产` : `此刻 ${h.fix.status}`}`
    : "还没有一件任务认领它的修法";
  return `这道闸至今报过 ${h.reported} 条，${what}${rest}；${fix}。据它下的结论，先自己核一遍。`;
}

/** t-149: `project:gate.<闸>.fix` 指的那件任务，以及它此刻走到哪儿。事实无效或指向不存在的任务时，当作没有。 */
function gateFix(s: State, gate: Gate): GateHonesty["fix"] {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${gateFixKey(gate)}`);
  const rs = id ? s.readings.get(id) : undefined;
  const task = typeof rs?.reading.value === "string" ? s.tasks.get(rs.reading.value) : undefined;
  if (!rs || !rs.valid || rs.expired || !task) return undefined;
  const verified_on = task.verifications.filter((v) => v.pass).map((v) => v.surface);
  return { task: task.id, status: task.status, verified_on, in_production: verified_on.includes("production") };
}

export function gateHonesty(s: State, gate: Gate): GateHonesty | null {
  if (gate !== "seam") return null;   // 今天只有接缝闸产生可被核对的结论
  const seams = [...s.seams.values()];
  const judged = seams.filter((x) => x.resolution?.verdict);
  const h = {
    gate,
    reported: seams.length,
    judged: judged.length,
    false_positives: judged.filter((x) => x.resolution!.verdict === "false").length,
    missed: seams.filter((x) => x.resolution?.missed).length,
    unjudged: seams.length - judged.length,
    fix: gateFix(s, gate),
  };
  // 判据 2：两个条件都成立才叫「已知缺陷」——有被判过的错，且修法还没在生产上。都不成立就没有这句话。
  const broken = h.false_positives > 0 || h.missed > 0;
  if (!broken || !h.fix || h.fix.in_production) return null;
  return { ...h, line: honestyLine(h) };
}

/**
 * t-147 criterion 6 (pm 06:37): what one role owes at this instant, in the new model's two kinds.
 *
 * `unanswered` — a card with options that has reached them and still has no answer. That is an answer, not a
 * receipt, and it is the only thing anybody is still required to send back.
 * `untouched` — read, and no event of theirs has touched it yet. Not a debt the way a card is: the way to close one
 * is to do it, or to say 「不办：<原因>」 (DECLINE_PREFIX), which is an answer too.
 *
 * Nothing here is unread: a pull records its cursor before this is computed, so by the time it is answered, the
 * puller has read everything the log holds. What is unread belongs to whoever has *not* pulled, and that is the
 * board's `overdue_by_presence`, not this.
 *
 * For a role `unanswered` is empty and will stay empty while options may only be addressed to the human
 * (rules.ts: 「options are for the human」). It is here because the human is a puller too, and because a role that
 * one day may be asked to choose should not need a second field invented for it.
 *
 * Deliberately data only. The sentence a person reads at `sync` is t-140's, and one wording in two places is how the
 * page once promised an address nobody had ever delivered to (t-126).
 */
export interface OwedNow {
  unanswered: { instruction: string; from: string; body: string; sent: string; options?: string[]; default?: string; ack_by?: string; overdue: boolean }[];
  untouched: { instruction: string; from: string; body: string; sent: string }[];
}

/**
 * t-140 (pd 06:23): what this node itself still owes, said only to it, only at `sync`. Two sentences because it
 * owes two different things: an answer to a card, and an action on everything else. The second ends with both
 * legitimate ways out on purpose — silence is no longer an answer and a refusal is information, so a line offering
 * neither would read as nagging.
 *
 * It reads `owedNow`, not the batch a pull happened to bring. That is the whole of qa 06:32's failure: fed
 * `for_me`, the line lived exactly as long as the instant an instruction arrived — printed directly under the
 * instruction itself, the one moment nobody needs it — and a node that had synced once was never reminded again
 * while the debt stood. What is owed has to be computed from what is owed.
 *
 * Data in, sentences out: no clock of its own, no i18n, no second copy in the renderers (pd 05:50).
 */
export function owedSentences(owed: OwedNow | undefined, now: Date): string[] {
  if (!owed) return [];
  const mins = (iso: string) => Math.max(1, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  type Item = { body: string; sent: string };
  const oldest = (xs: Item[]) => xs.reduce((a, b) => (a.sent < b.sent ? a : b));
  const first = (x: Item) => splitTitle(x.body).title || x.body.trim().slice(0, 30);
  const out: string[] = [];
  if (owed.unanswered.length) {
    const o = oldest(owed.unanswered);
    out.push(`有 ${owed.unanswered.length} 条在等你答，最久的 ${mins(o.sent)} 分钟：${first(o)}`);
  }
  if (owed.untouched.length) {
    const o = oldest(owed.untouched);
    out.push(`你读过还没动的有 ${owed.untouched.length} 条，最久 ${mins(o.sent)} 分钟：${first(o)}。办了它，或者写一句「${DECLINE_PREFIX}原因」。`);
  }
  return out;
}

export function owedNow(s: State, to: string): OwedNow {
  const out: OwedNow = { unanswered: [], untouched: [] };
  for (const st of owedTo(s, to)) {
    const i = st.instruction;
    if (i.options?.length) out.unanswered.push({ instruction: i.id, from: i.actor, body: i.body, sent: i.at, options: i.options, default: i.default, ack_by: i.ack_by, overdue: !!st.overdue });
    else out.untouched.push({ instruction: i.id, from: i.actor, body: i.body, sent: i.at });
  }
  return out;
}

/**
 * t-139 (pd 05:15): the overdue list, split by whether whoever is supposed to answer is there.
 *
 * The three do not add up to anything worth knowing. A role nobody is running needs a person to start one; a node
 * that is alive but has stopped pulling needs its watch back; a node that is listening and has not acked needs a
 * nudge. Tonight release was listening, producing steadily, and sitting on 22 unacked instructions, the oldest 160
 * minutes old — while a genuinely absent role was in the same heap, and the heap said neither thing.
 */
export function overdueByPresence(b: Board, owed: { instruction: string; to: string }[]): Board["overdue_by_presence"] {
  const state = new Map(b.presence.map((p) => [p.actor, p]));
  const empty = (): BoardOverdueGroup => ({ roles: [], count: 0, away_s: null, instructions: [], line: "" });
  const out = { missing: empty(), deaf: empty(), listening: empty() };
  for (const o of owed) {
    const p = state.get(o.to);
    const g = out[p?.status ?? "missing"];   // a recipient with no presence row at all has never been here
    g.count++;
    g.instructions.push(o.instruction);
    if (!g.roles.includes(o.to)) g.roles.push(o.to);
    const away = p?.idle_pull_s ?? null;
    if (p?.status !== "listening" && away !== null && (g.away_s === null || away > g.away_s)) g.away_s = away;
  }
  // null is not zero: a role that has never read the log has no "how long" to report, and the board says that rather
  // than rounding an absent fact up to one minute (qa 06:07).
  const mins = (sec: number) => Math.max(1, Math.round(sec / 60));
  if (out.missing.count)
    out.missing.line = out.missing.away_s === null
      ? `从没读过日志，${out.missing.count} 条没送到`
      : `缺人 ${mins(out.missing.away_s)} 分钟，${out.missing.count} 条没送到`;
  if (out.deaf.count)
    out.deaf.line = out.deaf.away_s === null
      ? `从没读过日志，${out.deaf.count} 条没送到`
      : `有 ${mins(out.deaf.away_s)} 分钟没读日志了，${out.deaf.count} 条没送到`;
  // pd 05:40 retired 「确认」 with the receipt it named: what is true of a node that is here is that it read them and
  // has not moved yet, and that is what the line says now.
  if (out.listening.count) out.listening.line = `在听，${out.listening.count} 条读到了还没动`;
  return out;
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
/**
 * t-153: the six in-flight groups — which task lands in which — computed here, once. It used to live in
 * packages/server/src/html.ts, and the page was the only reader; moving it does not change any membership
 * (t-153 判据 2 pins that with a real log, before and after).
 *
 * Only the grouping moves. The labels stay where the page's own words live, keyed by `key`, and the page renders
 * the rows: this returns data, no sentence of its own. The one sentence it does carry is a task's own
 * 「卡在什么上」, and that is `blockedWhy` below — it came along because a page that kept composing it would be
 * the assembly here and the sentence there (t-126's shape).
 */
export interface FlightItem { title: string; owner?: string; blocked?: boolean; why?: string }

/**
 * The reason a task is blocked, said short and without machinery: ULIDs, shas and paths become 「…」, and a bracket
 * left holding nothing but 「…」 goes away entirely (pd's review of t-034).
 */
export function blockedWhy(reason: string, max = 60): string {
  const masked = reason
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9a-f]{8,40}\b|[\w.-]+(?:\/[\w.-]+)+/g, "…")
    .replace(/[（(]\s*(?:…\s*[，,、;；]?\s*)+[)）]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const chars = [...masked];
  return chars.length <= max ? masked : chars.slice(0, max).join("") + "…";
}

/** The board's `shown` order (most recently touched first) for the groups the page expands. */
function sortRecent(b: Board, k: string, items: FlightItem[]): FlightItem[] {
  const order = new Map((b.in_flight[k]?.all ?? []).slice().sort((x, y) => y.updated_at.localeCompare(x.updated_at) || y.id.localeCompare(x.id)).map((x, i) => [x.title, i]));
  return items.slice().sort((x, y) => (order.get(x.title) ?? 0) - (order.get(y.title) ?? 0));
}

export function inFlightGroups(b: Board): { key: string; total: number; items: FlightItem[] }[] {
  // t-163 (pd 07:56): every group reads the same way — the task's own 「人能看到什么」 if it has one, otherwise the
  // title we gave it. A person reading this section is asking what is moving right now, and `shows` is that sentence;
  // the title is our name for the task, the fallback. Never both on one row: one line saying the same thing twice
  // reads as two things. The tasks written before that rule land on the title branch — plain, and true.
  const g = (k: string): FlightItem[] => (b.in_flight[k]?.all ?? []).map((x) => {
    const task = (b.tasks[k] ?? []).find((tk) => tk.id === x.id);
    return { title: task?.shows ?? x.title, owner: x.owner, blocked: k === "blocked", why: k === "blocked" && task?.blocked_on ? blockedWhy(task.blocked_on) : undefined };
  });
  // t-152 (pd 06:54): this group used to hold two opposite things under one label. The test is whether a person can
  // make the number smaller. 「验过了，还没上线」 goes to zero the moment someone pushes, so it is theirs and stays.
  // 「已上线，只是没在生产走过」 only ever grows and no action of theirs touches it — that one leaves every surface
  // and lives on our own account (pd 06:53), digested by scenario walks. The split is t-078's, computed once there.
  // Removing exactly the group with no lever, rather than keeping only pending_deploy: a task verified on staging
  // but never shipped is still something a person can push, and an "include only" filter would drop it silently.
  // t-152 (pd 07:07): group by what a thing is actually waiting for. 「验过了，等上线」 is exactly the set one push
  // clears — the same set the standing line counts, because two numbers that mean the same thing must be one number.
  // A task verified only on staging is waiting for a repo verification, not a deploy, so it belongs with 等验; and
  // work already running in production that nobody walked there has no lever at all and leaves every surface.
  const running = new Set((b.release.deployed_unverified ?? []).map((c) => c.task));
  const waiting = new Set((b.release.pending_deploy ?? []).map((c) => c.task));
  const notOnProduction = (b.tasks.verified ?? []).filter((tk) => !tk.verified_on?.includes("production"));
  const row = (tk: { title: string; shows?: string; owner?: string }) => ({ title: tk.shows ?? tk.title, owner: tk.owner }); // t-056
  const elsewhere = notOnProduction.filter((tk) => waiting.has(tk.id)).map(row);
  const awaitingRepo = notOnProduction.filter((tk) => !waiting.has(tk.id) && !running.has(tk.id)).map(row);
  const groups = [
    { key: "working", items: sortRecent(b, "working", g("working")) },
    { key: "blocked", items: sortRecent(b, "blocked", g("blocked")) },
    { key: "done", items: [...g("done"), ...awaitingRepo] },
    { key: "open", items: g("open") },
    { key: "failed", items: g("failed") },
    { key: "verifiedElsewhere", items: elsewhere },
  ];
  return groups.map((x) => ({ ...x, total: x.items.length }));
}

export function slimBoard(b: Board): Board {
  const tasks: Board["tasks"] = {};
  for (const [status, list] of Object.entries(b.tasks)) {
    tasks[status] = list.map((t) => ({
      id: t.id, title: t.title, label: t.label, from: t.from, status: t.status, owner: t.owner, blocked_on: t.blocked_on, withdrawn: t.withdrawn, obsolete: t.obsolete,
      // t-164: 在途那几件的触点留在瘦身板里——「这块地上还有谁」只需要它们，而在途的从来只有几件。
      // 已经 done 的不留：那是接缝在 done 时判的事，不是「还有谁在」。
      touches: t.status === "working" ? t.touches : undefined,
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
  // t-149 判据 3：那句实话的位置是挖层与报告，不是首屏——所以它不随瘦身板出门。`omitted` 会如实说它被略了。
  const slim: Board = { ...b, tasks, instructions, seams, readings, needs_human, in_flight, release, gate_honesty: [], omitted: [] };
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

const shortSha = (a: unknown) => String(a).slice(0, 7);
const sameSha = (a: unknown, b: unknown) => shortSha(a) === shortSha(b);

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
 * t-129 (judged, then said). pd 02:53 asked for the batch to expire by itself; pm asked that the expiry say which of
 * two things it is, because they need opposite actions: one is "pack it again", the other is "do not push this".
 *
 * The words are pd's, set at 05:01, and they live here so the page and the CLI say the same ones (t-118). Two things
 * pd decided against that an earlier draft had: neither sentence names the new head — 「生产已经往前走了」 is what the
 * reader needs — and 「重装，别推」 stays, because it is the action, and pm repeated a dead sha three times for want
 * of it. None of the three is a card: they appear in front of whoever is about to push, at the moment they are about
 * to do it.
 */
export const BATCH_LINES = {
  /**
   * t-167：pd 08:13 的字，一个字未改。不带动作，也不写「无需操作」——pd：「无需操作」是在回答一个人没问的问题；
   * 牌桌上凡是不带动作的句子都必须让人一眼看出不用动，最简单的办法就是不给它动作。
   */
  deployed: () => "这一批已经在生产上跑着",
  /**
   * t-167 (pd 08:18)：早先上过线、被后面盖过去的那一批。它在历史那一段里被列出来时必须有一句——**沉默在一排
   * 会说话的行里像坏了**。不写「已作废」：它没作废，它发生过。
   */
  shipped: () => "这一批上过线，后来被更新的一版盖过。",
  /**
   * t-176 (pd 08:47)：这一段空着时说的是**两件独立的事**——批次那边什么样，以及有没有验过了却还没装进批次的。
   * 所以先说批次，再说没装的，各一句；哪一句出现只看两个数。
   *
   * pd 退役了原来那句「没有做完等上线的东西。」：它想同时说这两件事，于是对「装过、都上线了、还有没装的」
   * 那一种必然说假话——今天生产正是那一种（五批全上过线，7 件已验的一批都没进）。这条是 pd 自己 07:4x 定的
   * 「一句话不许同时说两件事」的一个实例，而它是我量了生产板才发现的：**空态最容易被想象出来，因为写的时候
   * 手边没有那个世界**（pd 08:47）。
   */
  neverPacked: () => "还没装过批次。",
  allShipped: () => "装好的批次都上线了。",
  unpacked: (n: number) => `还有 ${n} 件验过了，没装进任何一批。`,
  stale: (base: string) => `这批是以 ${base.slice(0, 7)} 为底装的，生产已经往前走了；重装一次就能把新验的一起带上。`,
  rollback: (base: string, loses: string[]) =>
    `这批是以 ${base.slice(0, 7)} 为底装的，推它会把 ${loses.join("、")} 从生产上退回去。重装，别推。`,
  unknown: (why: string) => `这批是不是还能推，现在算不出来：${why}。`,
};

/**
 * t-129: every batch this project packed, newest first, each judged against where production is now.
 *
 * Batches are read whether or not their reading is still valid — a batch that went stale is exactly the one a person
 * needs to see, and `depends_on: production:deployed.sha` is what makes it go stale without anyone remembering to.
 */
/**
 * t-130: the stand-ins declared in the last day, grouped by the task whose rule was stood in for. The service cannot
 * find these itself (see STOOD_IN_PREFIX) — every one of them is somebody saying so — so this counts declarations,
 * and says as much rather than implying it saw them happen.
 */
export function standIns(s: State, now: Date): Board["stand_ins"] {
  const since = new Date(now.getTime() - STAND_IN_DAY_MS).toISOString();
  const by = new Map<string, { task: string; title: string; count: number; last_at: string; who: string[] }>();
  let total = 0;
  for (const n of s.notes) {
    if (!n.body.startsWith(STOOD_IN_PREFIX) || !n.task || n.at < since) continue;
    total++;
    const row = by.get(n.task) ?? { task: n.task, title: s.tasks.get(n.task)?.title ?? n.task, count: 0, last_at: n.at, who: [] };
    row.count++;
    row.last_at = n.at;
    if (!row.who.includes(n.actor)) row.who.push(n.actor);
    by.set(n.task, row);
  }
  const rows = [...by.values()].sort((a, b) => b.count - a.count || a.task.localeCompare(b.task));
  const summary = total
    ? `人顶了 ${total} 次（${rows.map((r) => `${r.task} ${r.count} 次`).join("、")}）——都是本可以自动、现在由人做的`
    : "人顶了 0 次";
  return { total, since, by_task: rows, summary };
}

/**
 * t-176 (pd 08:47)：上线清单空着时说什么。两件独立的事，先说批次、再说没装的，各一句；哪一句出现只看两个数。
 * 还有批次在等人推时这里返回 null——那一段本来就在列它们。
 *
 * 判断与措辞都在这里，渲染方只印：两个渲染方各判一遍状态名，就是 t-142 那一族。
 */
export function batchesEmptyLine(batches: BoardBatch[], unpacked: number): string | null {
  if (batches.some((x) => x.pending)) return null;
  const said = [batches.length ? BATCH_LINES.allShipped() : BATCH_LINES.neverPacked()];
  if (unpacked > 0) said.push(BATCH_LINES.unpacked(unpacked));
  return said.join("");
}

/** 验过了、还在等上线、却没有被装进任何一批的件数——`batchesEmptyLine` 的第二个数。 */
export function unpackedCount(b: Board): number {
  const packed = new Set((b.batches ?? []).flatMap((x) => x.contains));
  return (b.release?.counts?.pending_deploy ?? 0) === 0 ? 0 : (b.release.pending_deploy ?? []).filter((c) => !packed.has(c.task)).length;
}

export function batches(s: State, deployed: string | null, why: string | null, fact: ReturnType<typeof deployedTasksFact>): BoardBatch[] {
  const out: BoardBatch[] = [];
  // 每一个当过生产头的 sha。日志本来就记着它们（production:deployed.sha 的每一条），所以「这一批上过线没有」
  // 是算出来的，不是谁声明的。
  const everDeployed = new Set([...s.readings.values()].map((x) => x.reading)
    .filter((r) => r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string")
    .map((r) => shortSha(r.value as string)));
  for (const [key, id] of s.latestReading) {
    if (!key.startsWith(`${BATCH_SURFACE}:${BATCH_PREFIX}`)) continue;
    const r = s.readings.get(id);
    const v = r?.reading.value as Partial<BatchValue> | undefined;
    if (!r || !v || typeof v.sha !== "string" || typeof v.base !== "string" || !Array.isArray(v.contains)) continue;
    const contains = v.contains.map(String);
    const name = key.slice(`${BATCH_SURFACE}:${BATCH_PREFIX}`.length);
    let state: BatchState, loses: string[] = [], line = "";
    // t-167: 「它此刻在哪」，三问分完，没有剩下的情形。顺序不能换：一批推上去之后，它既是生产头、base 又落后
    // 一格，两个条件同时成立——先问「它是不是就是生产」的那一版才不会把正在跑的东西说成要退回去的东西。
    if (deployed && sameSha(v.sha, deployed)) { state = "deployed"; line = BATCH_LINES.deployed(); }
    // 早先上过线的：它不在等谁去推，它已经发生过了。这里不说话——一批推上去之后就该离开「上线清单」（那是
    // 「接下来要发生什么」），进「线上这一版」那一段（那是「已经发生了什么」，pd 08:13）。渲染方据这个状态搬，
    // 而不是自己去猜哪些 sha 上过线。这一格要不要一句话，我发给 pd 了；在它定之前不说话，不自拟。
    else if (everDeployed.has(shortSha(v.sha))) { state = "shipped"; line = BATCH_LINES.shipped(); }
    else if (deployed && sameSha(v.base, deployed)) { state = "current"; }
    else if (!deployed || why || !fact || !sameSha(fact.sha, deployed)) {
      state = "unknown";
      line = BATCH_LINES.unknown(why ?? "生产没有有效的 production:deployed.sha 事实");
    } else {
      loses = fact.contained.filter((t) => !contains.includes(t));
      state = loses.length ? "rollback" : "stale";
      line = loses.length ? BATCH_LINES.rollback(v.base, loses) : BATCH_LINES.stale(v.base);
    }
    out.push({ name, sha: v.sha, base: v.base, contains, state, loses, line, pending: state !== "deployed" && state !== "shipped", at: r.reading.at });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
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
  b.batches = batches(s, deployed, why, fact);   // t-129: judged on the same basis, so the two can never disagree
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

/**
 * t-133: what one deploy is called. The number is the machine's — monotonic across the whole log, never reused — and
 * the sentence is the person's: 「09-07 第 3 次上线」, counted within that day, because that is how someone refers to
 * it out loud. Two fields, never one (pd 03:34; the same split as a task's id and its label, t-096).
 */
export interface Deploy { sha: string; at: string; seq: number; label: string }

export function deployHistory(s: State, tz = "UTC"): Deploy[] {
  const day = (iso: string) => {
    const d = new Date(iso);
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit", day: "2-digit" }).format(d);
    return p;   // MM-DD
  };
  const readings = [...s.readings.values()].map((x) => x.reading)
    .filter((r) => r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string")
    .sort((a, b) => a.id.localeCompare(b.id));
  const out: Deploy[] = [];
  const perDay = new Map<string, number>();
  for (const r of readings) {
    const sha = (r.value as string).trim();
    // The same sha measured again is the same deploy, not a new one (the 7-char rule the board already uses).
    if (out.length && out[out.length - 1].sha.slice(0, 7) === sha.slice(0, 7)) continue;
    const d = day(r.at);
    const n = (perDay.get(d) ?? 0) + 1;
    perDay.set(d, n);
    out.push({ sha, at: r.at, seq: out.length + 1, label: `${d} 第 ${n} 次上线` });
  }
  return out;
}

/**
 * t-133 (release's rule, second clause): tasks that named the same sha in their evidence ship together or not at all.
 * So the page's unit is a sha, and a unit is held by whichever of its members has not passed on repo — tonight
 * t-118/t-119/t-122/t-125 were one such string, held by the one that failed.
 */
export interface ReleaseUnit {
  sha: string;
  /** Every finished task naming this sha, in the order the board lists them. */
  tasks: { id: string; title: string; shows?: string; owner?: string; status: string; passed: boolean }[];
  /** The members that are not verified on repo: the reason the whole string is not moving. */
  held_by: { id: string; title: string; shows?: string; owner?: string; status: string }[];
  /**
   * What this unit would actually put into production: members whose code is not there yet (t-078's pending_deploy).
   * Not "verified but not verified on production" — that is deployed_unverified, whose code is already running, and
   * counting it here said 28 when the board said 9 (qa 05:31).
   */
  brings: number;
  /** True when the board cannot place the tasks at all, so `brings` is not an answer (t-078's unknown). */
  brings_unknown?: boolean;
  /** When the earliest member of this string was finished: how long it has been waiting. */
  since: string;
}

export function releaseUnits(b: Board): ReleaseUnit[] {
  // What is actually waiting to ship is t-078's pending_deploy, the same set the board's 「N 件验过了，等一次上线」
  // counts. Absent means the board could not work it out (no containment fact): then this page must not invent one.
  const pending = b.release.pending_deploy;
  const shipped = new Set((pending ?? []).map((c) => c.task));
  const doneAt = new Map((b.release.candidates ?? []).map((c) => [c.task, c.done_at]));
  const units = new Map<string, ReleaseUnit>();
  for (const group of Object.values(b.tasks)) {
    for (const t of group) {
      const sha = t.evidence_sha;
      if (!sha || t.status === "withdrawn" || t.status === "obsolete") continue;
      // A member holds the string until it is verified — on whichever surface its own criteria needed. Asking for a
      // repo pass specifically would count a task verified only on production (t-002, t-012) as holding itself.
      const passed = t.status === "verified";
      const u = units.get(sha) ?? { sha, tasks: [], held_by: [], brings: 0, since: "", ...(pending ? {} : { brings_unknown: true }) };
      const at = doneAt.get(t.id);
      if (at && (!u.since || at < u.since)) u.since = at;
      u.tasks.push({ id: t.id, title: t.title, shows: t.shows, owner: t.owner, status: t.status, passed });
      if (!passed) u.held_by.push({ id: t.id, title: t.title, shows: t.shows, owner: t.owner, status: t.status });
      if (shipped.has(t.id)) u.brings += 1;
      units.set(sha, u);
    }
  }
  // Only the units with something left to ship: a sha whose whole string is already in production is history.
  // Oldest first, the same order the board lists candidates in: what has been waiting longest leads. Sorting by sha
  // would be an implementation detail deciding what a person reads first.
  return [...units.values()].filter((u) => u.brings > 0 || u.brings_unknown || u.held_by.length > 0)
    .sort((x, y) => (x.since || "~").localeCompare(y.since || "~") || x.sha.localeCompare(y.sha));
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
