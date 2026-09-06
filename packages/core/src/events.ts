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
  /** ISO timestamp after which the reading is expired. */
  valid_until?: string;
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
  | { op: "done"; task: string; evidence?: string }
  | { op: "verify"; task: string; surface: string; pass: boolean; evidence?: string }
  | { op: "block"; task: string; on: string }
  | { op: "unblock"; task: string }
  /** Terminal: the task was created on a false premise. Only while open or blocked; by its criteria author, pm or the human. */
  | { op: "withdraw"; task: string; reason: string }
  /** Back to working after done or failed, same owner and touches: the owner has more to change (a review, a fail). */
  | { op: "reopen"; task: string; reason: string }
  /** More acceptance criteria, numbered after the existing ones. Whoever adds one becomes a criteria author. */
  | { op: "criteria"; task: string; add: string[] }
  | { op: "seam"; tasks: [string, string]; resolution: string };

export type TaskEvent = Base & { kind: "task" } & TaskOp;

export type Event = Reading | Instruction | Ack | Note | TaskEvent;
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
