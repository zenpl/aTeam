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
  /**
   * t-088: where this event came from when it was carried in from somewhere else — a path, a ticket number, a URL, a
   * message id, whatever that place calls things. Free text, matched exactly: writing a second event with the same
   * `from` returns the first one instead of adding a duplicate, so an import can be run again safely.
   */
  from?: string;
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
  /** t-084: the call-out address is an https webhook, nothing else; t-050 can only POST to https. */
  "alert.webhook": { regex: "^https://\\S+$" },
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
  /**
   * t-096: a name for people to recognise this by — the number it had where it came from ("T-07", "决策 12"). Never an
   * identifier: every reference is by `id`, two records may carry the same label, and a label never changes an id.
   */
  label?: string;
}

export type TaskOp =
  | { op: "create"; task: string; title: string; criteria: string[]; /** t-096: the number people knew it by elsewhere; never an identifier. */ label?: string }
  /** t-096: change what people see it called. The id is untouched, as always. */
  | { op: "label"; task: string; label: string }
  | { op: "claim"; task: string; touches: string[] }
  /**
   * t-105: `touches` here is the **final value** — claim's was a declaration, done's is the fact. The platform only
   * knows that: how the caller arrived at it (a git diff, a person retyping it) is the project's business, not the log's.
   */
  | { op: "done"; task: string; evidence?: string; /** one sentence for the owner: what a person can now see (t-056) */ shows?: string; touches?: string[] }
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
/**
 * t-106: a role **id** is ASCII lowercase — it travels in an HTTP header (X-Actor), and a header is latin-1 by the
 * spec, so a non-ASCII id does not fail loudly: some clients refuse to send it, others send raw UTF-8 that the server
 * reads as latin-1, and the team quietly becomes 审稿 → å®¡ç¨¿. The **name** people read is free in any language.
 */
export const ROLE_ID_RE = /^[a-z][a-z0-9_-]*$/;
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
/**
 * What the holder of each responsibility does, in one line (docs/responsibilities.md, 「持有者需要知道」条). The manual for any
 * role is assembled from these by id (t-081), so a project that calls its roles fe / be / release-manager gets a real manual
 * without anyone writing a file per role name.
 */
export const RESPONSIBILITY_DOING: Record<string, string> = {
  R1: "一句话说清现在最要紧的一件事，并说明什么被推迟了；焦点变了要让每个人下一轮就读到。",
  R2: "引用人的原话写成场景需求，定人可见之物的措辞与交互，把产品问题带选项和默认交给人。",
  R3: "动手前把判据写成可判定的句子，每条指明在哪个表面判；判据只追加、有留痕。",
  R4: "把要求拆成任务，写清判据与接口约定；按谁在听、谁有能力派活；被阻塞的说清卡在哪。",
  R5: "claim 时把触点写宽，做完 done 带证据（能定位产出、逐条对应判据）；改变了世界要 writes。",
  R6: "在指定表面上对照判据判 pass 并带证据——落 pass 要持本职责，落 fail 谁都可以；不验自己写判据的任务；FAIL 要说清缺什么。",
  R7: "把值记成事实，写清表面、方法、假设与有效期；引用别人的事实前先看它有没有失效。",
  R8: "触点重叠时说清谁合谁、边界在哪；批次集成，后落地方合并先落地方。",
  R9: "部署或迁移，写 writes 让相关事实失效，部署后把新状态记成事实；推之前确认自己有许可和凭据。",
  R10: "决定写成带 --decision 的 note，改变决定用 --supersedes，从不改历史。",
  R11: "把 friction 变成任务，改进规则本身；不要把本项目的约定固化成平台。",
  R12: "在真实表面上巡查，把观察写成 note 带证据，不直接当需求。",
  R13: "定期出报告，说节奏、返工、摩擦、人的负担与结构性发现；要人做的事变成卡。",
  R14: "谁在听、谁没在听、谁缺；缺人时把它变成一张给人的卡。",
  R15: "政策与产品范围由人定；给出选项和默认，到期按默认执行并留痕。",
  R16: "新节点十分钟内做出第一个正确动作；换人不需要口头交接。",
  R17: "外部信号带来源与信任级进来，先过滤再进日志。",
  R18: "项目隔离、钥匙发放与撤销；钥匙不进对话、不进文件。",
};
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
/** t-104: the responsibility a role must hold to record a **pass**. A fail is open to everyone: only a release needs independence. */
export const VERIFY_RESPONSIBILITY = "R6";
/** Body prefixes of the instructions the service writes on behalf of the verification flow. */
export const FAIL_NOTICE = " 验收未过：";
export const VERIFY_ASK = " 做完了，验不验得过？";
/**
 * S0's second card (t-069, pd 21:07): how to reach the human when they are away. Optional; 不要了 skips it for good.
 * pd 01:19 (t-117): the question the log records says the same thing the page shows — it used to offer an 邮箱 the
 * service cannot send to, and to end in 「也可以先不要」 while the button under it says 「不要了」.
 */
export const CONTACT_ASK = "你不在时怎么找你？给个 webhook。全队都停了、或有事等你超过半小时，我们就往这里发一条。不想要就点不要了，之后不再问你。";
/**
 * What the same question said before t-117. A card already on someone's board carries it, and it must keep its input
 * box and its buttons — the same reason CONTACT_SKIP_WAS exists (t-111). New cards are never sent with this.
 */
export const CONTACT_ASK_WAS = "你不在时怎么找你？给个邮箱或 webhook；也可以先不要";
/**
 * Is this card the contact ask? Answering the old one must count as answering it — otherwise rewording the question
 * (t-117) silently re-asks everyone who already said 不要了.
 */
export function isContactAsk(body: string): boolean {
  return body === CONTACT_ASK || body === CONTACT_ASK_WAS;
}
/**
 * t-118 (pd 01:40)：选项的值就是人看到的那个词，不做值与标签的映射。换词就换值，历史带着旧值不改——
 * 老卡上写的仍是它自己那个词，照样答得下去。
 */
export const CONTACT_FILL = "记下";
/** 旧卡上的那个词，答起来与「记下」同义（同 CONTACT_SKIP_WAS）。 */
export const CONTACT_FILL_WAS = "填写";
/** t-111 (pd 00:39): a button says what it costs — this one closes the question for good, so it is not 「先不做」. */
export const CONTACT_SKIP = "不要了";
/** What the same button said before t-111. Cards already sent carry it; answering them must keep working. */
export const CONTACT_SKIP_WAS = "先不要";
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
/**
 * t-092 (S9/M4): the importer says in the log that it is finished — a note whose body starts with this — and the service
 * counts what actually landed and asks the human to check it. The event is the trigger; nothing out of band.
 */
export const IMPORT_DONE_PREFIX = "导入完成：";
/** The check card, pd's wording (UC-S9「核对卡的措辞与交互」). The counts come from the log, never from the importer. */
export const MIGRATION_ASK_TITLE = "搬过来了，对吗？";
export const MIGRATION_OK = "对";
export const MIGRATION_MISSING = "有漏";
export const MIGRATION_OPTIONS = [MIGRATION_OK, MIGRATION_MISSING];
/** t-097 (M6): the note the importer writes once it has put the invitation back where the team already is. */
export const INVITE_SENT_PREFIX = "邀请已发回旧渠道：";
/** t-097: when the old place cannot be written to, the human forwards the link. pd's wording (UC-S9). */
export const FORWARD_LINK = "把这个链接发给他们：";
/**
 * t-098 (M7): the fact that says the move is finished. Writing it is refused until the human answered 对 on the check
 * card — that button is the authorisation to touch someone else's channel, so nothing may claim the move is over before it.
 */
export const MIGRATION_DONE_KEY = "migration.done";
/** What the first node is told to do once the human answered (M7 does the old channel itself). */
export const MIGRATION_FINISH = "human 说清单对：去旧渠道留最后一条「这里只读」，并记一条事实「迁移完成」。";
export const MIGRATION_PATCH = "human 说有漏：回去核对旧单据再补，补完再发一条「导入完成：…」，我会重新问他。";
/** t-069 / pm 22:39: the contact card exists only when this fact (surface project) is set; off by default. */
export const ALERT_ASK_KEY = "alert.ask";
/** Reading key (surface project) that names where to call out when the whole team is gone or the human is late (t-050). */
/**
 * t-119 (pd 01:21 的通则): 安全兜底的状态由**可达性**证明，不由字符串存在证明。这条事实只在真的送到过一次之后
 * 才写下来，值是当时那个地址——换了地址就得重新证一次，因为证的是那个地址，不是「配过东西」这件事。
 */
export const ALERT_REACHED_KEY = "alert.reached";
/** 服务写外呼结果时那条 note 的前缀与失败标记；牌桌据此判断「连续两次失败」（t-119）。 */
export const ALERT_NOTE_PREFIX = "外呼：";
export const ALERT_FAILED = "发送失败";
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
