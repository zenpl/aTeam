/**
 * The whole system is one append-only log of these events.
 * Everything else (board, presence, seams, validity) is derived on read.
 */

export interface Base {
  id: string;
  actor: string;
  /** ISO timestamp, assigned by the store on append. */
  at: string;
  /** Event ids this event relies on. Referencing an invalid reading is rejected. */
  refs?: string[];
  /** World state this event changed, as `surface:key`. Invalidates readings that depend_on them. */
  writes?: string[];
}

/** What values a reading key may take. A regex is matched against the value as a string; an enum by JSON equality. */
export interface ReadingShape { regex?: string; enum?: unknown[] }

/**
 * Shapes every log starts with, by key, on every surface (a declaration for one `surface:key` is checked against them).
 * `deployed.sha` is a git sha or the literal "unknown" that GET /health reports when the image was built without one;
 * never an event id.
 */
export const DEFAULT_SHAPES: Record<string, ReadingShape> = {
  "deployed.sha": { regex: "^([0-9a-f]{7,40}|unknown)$" },
};

/** A measurement of the world at one moment. Never a constant. */
export interface Reading extends Base {
  kind: "reading";
  /** What was measured, e.g. `users.count`, `deployed.sha`, `focus`. */
  key: string;
  value: unknown;
  /** Where it was measured: `repo`, `staging`, `production`, `team`, ... */
  surface: string;
  method?: string;
  assumptions?: string[];
  /** `surface:key` entries; a later event that `writes` any of them invalidates this reading. */
  depends_on?: string[];
  /** ISO timestamp after which the reading is expired. Counted from measured_at, not from when it was written. */
  valid_until?: string;
  /** When the world was measured (t-051). Never later than the event; equal to it when absent. */
  measured_at?: string;
  /** Declares, once per surface:key, what values it may take. Later readings of that surface:key that do not match are rejected. */
  shape?: ReadingShape;
}

/** An action demand with exactly one recipient. Short. Must be acked. */
export interface Instruction extends Base {
  kind: "instruction";
  to: string;
  body: string;
  /** ISO timestamp; unacked past this is overdue and escalates to the human. */
  ack_by: string;
  /** Only for the human: the choices this instruction asks for. The board renders one button per option. */
  options?: string[];
  /** One of `options`; what happens if nobody chooses. */
  default?: string;
  /** For the human's board: a question to answer, a thing to do, or something to know. Derived when absent. */
  intent?: InstructionIntent;
}

export interface Ack extends Base {
  kind: "ack";
  of: string;
}

/** The sender takes an instruction back (t-064): only before it was acked or decided. The instruction stays in the log. */
export interface Untell extends Base {
  kind: "untell";
  of: string;
  reason: string;
}

/** Discussion, decisions, concerns. Carries no action. */
export interface Note extends Base {
  kind: "note";
  body: string;
  decision?: boolean;
  /** Event id of the decision this one replaces. */
  supersedes?: string;
  /** This note answers an instruction that carried options: which one was chosen. */
  decides?: { of: string; option: string };
  /** Attach to a task: `task show`, the board and GET / list it there. A body starting "evidence:" is an evidence update. */
  task?: string;
}

export type TaskOp =
  | { op: "create"; task: string; title: string; criteria: string[] }
  | { op: "claim"; task: string; touches: string[] }
  | { op: "done"; task: string; evidence?: string; /** one sentence for the owner: what a person can now see (t-056) */ shows?: string }
  | { op: "verify"; task: string; surface: string; pass: boolean; evidence?: string; shows?: string }
  | { op: "block"; task: string; on: string }
  | { op: "unblock"; task: string }
  /** Terminal: the task was created on a false premise. Only while open or blocked; by its criteria author, pm or the human. */
  | { op: "withdraw"; task: string; reason: string }
  /** Terminal: a product decision made the finished work moot. Only done or failed; by the criteria authors, pm, pd or the human. */
  | { op: "obsolete"; task: string; /** the decision note that took its place */ decision: string; reason?: string }
  /** Back to working after done or failed, same owner and touches: the owner has more to change (a review, a fail). */
  | { op: "reopen"; task: string; reason: string }
  /** More acceptance criteria, numbered after the existing ones. Whoever adds one becomes a criteria author. */
  | { op: "criteria"; task: string; add: string[] }
  | { op: "seam"; tasks: [string, string]; resolution: string };

export type TaskEvent = Base & { kind: "task" } & TaskOp;

export type Event = Reading | Instruction | Ack | Untell | Note | TaskEvent;
export type Kind = Event["kind"];

export const INSTRUCTION_MAX_CHARS = 280;
export type InstructionIntent = "ask" | "do" | "info";
export const INSTRUCTION_INTENTS: InstructionIntent[] = ["ask", "do", "info"];
/** A first sentence up to this long is the card's title on the human's board. */
export const TITLE_MAX_CHARS = 30;
/** A note the human leaves when acking with "not now" starts with this. */
export const DEFER_PREFIX = "先不做：";
/** The identity that owns task scope (decision 01M1TM…: identities are pm, dev, qa, human). It may withdraw any task. */
export const PM_ACTOR = "pm";
/** The identity that owns scenarios and wording (decision 07:02). It may add criteria to any task. */
export const PD_ACTOR = "pd";
/** The service itself, when it speaks (a missing-role card). It may ack what it wrote. */
export const SERVICE_ACTOR = "ateam";
/** Reading key that declares a project's role set; value is an array of role names. */
export const ROLES_KEY = "roles";
export const PROJECT_SURFACE = "project";
export const DEFAULT_ROLES = ["pd", "pm", "dev", "frontend", "qa"];
/** A role with no event or pull for this long is missing (S7). */
export const PRESENCE_WINDOW_MS = 10 * 60_000;
/** An instruction still not pulled this long after it was sent counts as undelivered on the board (t-048). */
export const UNDELIVERED_AFTER_MS = 5 * 60_000;
/**
 * The responsibilities of docs/responsibilities.md (pd): the unit a project packs into roles. `holder` says who holds one
 * when no role declares it: a role (so an undeclared one is a gap), everyone, the service, the owner, or nobody by design.
 */
export interface Responsibility { id: string; name: string; holder: "role" | "everyone" | "service" | "owner" | "none" }
export const RESPONSIBILITIES: Responsibility[] = [
  { id: "R1", name: "定方向", holder: "role" },
  { id: "R2", name: "把人的话变成要求", holder: "role" },
  { id: "R3", name: "定验收标准", holder: "role" },
  { id: "R4", name: "拆分派活", holder: "role" },
  { id: "R5", name: "做", holder: "role" },
  { id: "R6", name: "验收", holder: "role" },
  { id: "R7", name: "测量世界", holder: "everyone" },
  { id: "R8", name: "接缝与集成", holder: "role" },
  { id: "R9", name: "上线", holder: "role" },
  { id: "R10", name: "决策台账", holder: "everyone" },
  { id: "R11", name: "改进工具", holder: "role" },
  { id: "R12", name: "看着跑起来的东西说哪里不对", holder: "role" },
  { id: "R13", name: "协作报告", holder: "role" },
  { id: "R14", name: "看门", holder: "service" },
  { id: "R15", name: "拍板", holder: "owner" },
  { id: "R16", name: "上岗与交接", holder: "service" },
  { id: "R17", name: "对外接口", holder: "none" },
  { id: "R18", name: "钥匙与边界", holder: "service" },
];
/** The default packing (responsibilities.md, 打包 · 默认五角色): what a role holds when the project declares only role names. */
export const DEFAULT_RESPONSIBILITIES: Record<string, string[]> = {
  pd: ["R2", "R12"],
  pm: ["R1", "R3", "R4", "R8", "R11", "R13"],
  dev: ["R5", "R9", "R11"],
  frontend: ["R5", "R9"],
  qa: ["R6"],
};
/** What a node may push, declared when it joins (t-058): nothing, its own branch, the integration branch, or production. */
export const PUSH_LEVELS = ["none", "own-branch", "integration", "production"] as const;
export type PushLevel = (typeof PUSH_LEVELS)[number];
/** Surface of the per-node capability fact; its key is `<role>:能力`. */
export const NODE_SURFACE = "node";
export const capabilityKey = (role: string) => `${role}:能力`;
/** `shows` on done/verify: one sentence for the owner, at most this long. */
export const SHOWS_MAX_CHARS = 120;
/** Roles that verify. A project whose role set has none of them gets its verification asked of the human (t-055). */
export const VERIFIER_ROLES = ["qa"];
/** Body prefixes of the instructions the service writes on behalf of the verification flow. */
export const FAIL_NOTICE = " 验收未过：";
export const VERIFY_ASK = " 做完了，验不验得过？";
/** S0's second card (t-069, pd 21:07): how to reach the human when they are away. Optional; 先不要 skips it for good. */
export const CONTACT_ASK = "你不在时怎么找你？给个邮箱或 webhook；也可以先不要";
export const CONTACT_FILL = "填写";
export const CONTACT_SKIP = "先不要";
export const CONTACT_OPTIONS = [CONTACT_FILL, CONTACT_SKIP];
/**
 * t-073: how this project tells that the later side of a seam absorbed the earlier one (fact project:absorb.form).
 * "git-ancestor": the later side's evidence sha contains the earlier's (the doer's CLI checks git and records it);
 * "named-sha": the later side's evidence names the earlier side's sha (judged from the log alone). Unset: nobody judges.
 */
export const ABSORB_FORM_KEY = "absorb.form";
export const ABSORB_FORMS = ["git-ancestor", "named-sha"] as const;
export type AbsorbForm = (typeof ABSORB_FORMS)[number];
/** A seam resolution the rule wrote, not a person: "absorbed: 后者 <sha> 含前者 <sha>（<form>）". */
export const ABSORB_PREFIX = "absorbed: ";
/**
 * t-080: the version of the board's shape. Bumped whenever a field is removed, renamed or left out by default (t-070's
 * slimming was the first such change, unannounced: an older CLI crashed on it). A CLI that reads a newer shape than it
 * knows stops with "git pull && pnpm build" instead of failing on some field. History: 1 = before t-070; 2 = slim by default.
 */
export const BOARD_SHAPE = 2;
/**
 * t-078: which candidates' code is already in production (surface production, key deployed.tasks), measured by a node
 * with git (`ateam release`) against the deployed sha: { sha, contained: [task ids], not_contained: [task ids], method }.
 * It depends on production:deployed.sha, so a deploy invalidates it and the board says "unknown" until someone measures again.
 */
export const DEPLOYED_TASKS_KEY = "deployed.tasks";
/** t-069 / pm 22:39: the contact card exists only when this fact (surface project) is set; off by default. */
export const ALERT_ASK_KEY = "alert.ask";
/** Reading key (surface project) that names where to call out when the whole team is gone or the human is late (t-050). */
export const ALERT_WEBHOOK_KEY = "alert.webhook";
/** The whole team not listening for this long is a call-out. */
export const ALL_MISSING_AFTER_MS = 15 * 60_000;
/** An instruction to the human unacked this long past ack_by is a call-out. */
export const HUMAN_OVERDUE_AFTER_MS = 30 * 60_000;
/** The same situation is called out at most once per this. */
export const ALERT_COOLDOWN_MS = 60 * 60_000;
/** A node whose last pull is older than this is not listening: instructions to it are not arriving (t-047). */
export const LISTEN_WINDOW_MS = 5 * 60_000;
/** A note from the human on the board starts with this; the board derives where each such sentence went. */
export const SAID_PREFIX = "human 说：";
export const SAID_MAX_CHARS = 500;
export const FOCUS_KEY = "focus";
export const TEAM_SURFACE = "team";

/** Per-agent read position. Advancing it is the heartbeat. */
export interface Cursor {
  actor: string;
  last_event_id: string | null;
  at: string;
}

/** Server-side fact: when a recipient first pulled an instruction. */
export interface Delivery {
  event_id: string;
  to: string;
  at: string;
}

/** The input of every reducer: the log plus the two side tables the store keeps. */
export interface Log {
  events: Event[];
  cursors: Cursor[];
  deliveries: Delivery[];
}

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
/** An event before the store assigns id and at. */
export type NewEvent = DistributiveOmit<Event, "id" | "at">;
/** What a client sends: the server supplies actor from the authenticated identity. */
export type ClientEvent = DistributiveOmit<Event, "id" | "at" | "actor">;
