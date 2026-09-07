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
  | {
      op: "create"; task: string; title: string; criteria: string[];
      /** t-096: the number people knew it by elsewhere; never an identifier. */ label?: string;
      /** t-171: 这件做完之后人会看到什么。与 `no_human_impact` 二选一——承诺那头也要有闸。 */ shows?: string;
      /** t-171: 明写这件不改变人看到的东西。与 `shows` 二选一。 */ no_human_impact?: boolean;
    }
  /** t-096: change what people see it called. The id is untouched, as always. */
  | { op: "label"; task: string; label: string }
  | { op: "claim"; task: string; touches: string[] }
  /**
   * t-105: `touches` here is the **final value** — claim's was a declaration, done's is the fact. The platform only
   * knows that: how the caller arrived at it (a git diff, a person retyping it) is the project's business, not the log's.
   */
  | {
      op: "done"; task: string; evidence?: string;
      /** one sentence for the owner: what a person can now see (t-056) */ shows?: string;
      touches?: string[];
      /** t-151: 明写这件对人没有影响。与 `shows` 二选一——两个都不给会被拒绝，两个都给也会。 */
      no_human_impact?: boolean;
      /** t-170 (pd 08:33): 碰了人可见的文件时的具名出路——「文件#符号」，具体到符号才算数。 */
      internal_only?: string[];
    }
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
  | {
      op: "seam"; tasks: [string, string]; resolution: string;
      /** t-149: 对闸本身的判决——这条是真撞车（real）还是它报错了（false）。不写就是没判过，句子里如实说。 */
      verdict?: SeamVerdict;
      /** t-149: 这一次闸还漏掉了它该报的东西。与 verdict 正交：真接缝也可以同时是一次漏报。 */
      missed?: boolean;
    };

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
/**
 * t-151: 交活的时候，说一句这件对人有什么影响——或者明写它没有。二选一，没有第三种。
 *
 * 今晚量到的形状是：83 件在生产上没被走过的活里，只有 5 件说得出人能看到什么，78 件一句都没有。那 78 件不是
 * 「没影响」，是**没人问过这个问题**；两者在记录上长得一模一样，于是谁也分不出哪些该走查、哪些本来就不必。
 * 一个不必回答的问题，答案永远是空的。
 *
 * 「没有影响」是一个要签字的判断，不是省一个字段：写下它的人是在说「我看过了，人这边什么都不会变」。
 */
export const NO_HUMAN_IMPACT = "不改变人看到的东西";

/**
 * t-170 (pd 08:22)：**「碰了人可见的东西」按改动算，不按文件算。**
 *
 * t-151 第一版按文件前缀判，当天就误伤了一次真实的活：t-165 删的是 html.ts 里一段死代码（`#justDeferred`），
 * 人看到的东西一个字没变，闸却拦下它，逼作者写一句内容是「什么都没变」的 shows。那句 shows 长得像「说得出人
 * 能看到什么」，其实是第二类的合法版本——**这道闸本来就是为了把这两类分开的，文件级判定反而在往日志里掺第三类。**
 *
 * 按 pd 的口径，只有三件事算人可见：动了那些 key、动了它们的文本、动了哪个 key 在哪显示。所以判定分三档：
 *
 * ① **只装文本的地方**（`WORDS_FILES`）——i18n 与说明书里没有内部符号可言，改它就是改人看到的字。拒绝。
 * ② **core 里的 key 本身**（`KEY_SYMBOLS`）——触点写成 `路径#符号` 且符号是其中之一。拒绝。
 * ③ **其余**：人可见文件里的内部符号（`html.ts#justDeferred` 这种）不算；只给了文件名、没说改在哪儿的，
 *    **算不准**——那时只提醒，不拒绝（判据 3：别人装上我们的闸，最坏是被提醒，不该被我们的纪律挡住干活）。
 *
 * 名单仍然会漏，而且这一版比上一版更依赖它。t-143/t-144 把人可见的每句话收进唯一 key 之后，②那一档就该从
 * 那张表算出来，而不是在这里数符号名。在那之前，漏掉一个 key 的代价是一次没被拦下的顺手改。
 */
export const WORDS_FILES = ["packages/server/src/i18n.ts", "packages/core/manual/"] as const;
/**
 * t-170: core 里装着给人看的整句话的那些符号。动它们就是动人看到的字，没有「内部符号」这一说。
 *
 * **这份名单不是我数出来的，是量出来的**：build.test.ts 里有一条闸，从 core 的源码里把「函数体或常量里含给人看
 * 的整句中文」的导出符号全找出来，与这份名单逐个对；少一个就红。qa 08:46 判不过的第一条正是名单漏了一个
 * （frontend 的 board.ts#inFlightGroups，它改的是牌桌在途那一段的四行字），而漏的原因就是当时这份名单靠手数。
 *
 * t-143 把人可见的每句话收进唯一 key 之后，这份名单该由那张表取代；在那之前，这条闸让它不会悄悄过时。
 */
export const KEY_SYMBOLS = [
  "ALLOCATION_PATTERNS", "BATCH_LINES", "CONTACT_ASK", "CONTACT_ASK_WAS", "FAIL_NOTICE", "FORWARD_LINK",
  "INVITE_SENT_PREFIX", "MIGRATION_ASK_TITLE", "MIGRATION_FINISH", "MIGRATION_PATCH", "NO_HUMAN_IMPACT", "REACH_RULE",
  "REACH_STALE_MS", "REACH_WORDS", "READING_SAYINGS", "RESPONSIBILITIES", "RESPONSIBILITY_DOING", "SAID_PREFIX",
  "SEAM_SAME_FILE", "STAND_IN_ASK_TITLE", "VERIFY_ASK", "alertContact", "allocationSummary", "batches",
  "board", "capabilityKey", "coverage", "deployHistory", "followUps", "lightSeamLine",
  "manualFor", "missingCard", "overdueByPresence", "owedSentences", "responsibilityAppendix", "runtimeAllocation",
  "saidHops", "sayReading", "shapeFor", "standIns", "staticAllocation",
] as const;

/** t-170: 会渲染给人看的东西的文件。改里面的内部符号不算人可见；只给文件名说不清改在哪儿，算不准。 */
export const RENDERING_FILES = ["packages/server/src/html.ts", "packages/cli/src/format.ts"] as const;

/** t-170: 一个触点算不算「碰了人可见的东西」，以及算不算得准。 */
export type TouchVerdict = "human_visible" | "internal" | "unsure";


export function touchesHumanVisible(touch: string): TouchVerdict {
  const path = touch.split("#")[0].trim();
  const symbol = touch.includes("#") ? touch.slice(touch.indexOf("#") + 1).trim() : "";
  if (/(^|\/)test\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path)) return "internal";   // 改一个用例不改变任何人看到的东西
  if (WORDS_FILES.some((x) => path === x || path.startsWith(x))) return "human_visible";        // ① 只装文本的地方
  if (symbol && KEY_SYMBOLS.includes(symbol as (typeof KEY_SYMBOLS)[number])) return "human_visible"; // ② key 本身
  // t-170 第二轮：**不再按符号自动放过**。带不带符号都算碰了人可见的东西；要出去，走 --internal-only 那条具名出路。
  if (RENDERING_FILES.some((x) => path === x)) return "human_visible";
  return "internal";
}
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
 * t-129 (pd 02:53): a batch is a reading, not a sentence with a sha in it. `repo:batch.<name>`, whose value is
 * `{ sha, base, contains }` and which declares `depends_on: ["production:deployed.sha"]` — so the moment production
 * moves, the batch is invalid without anyone remembering to say so. That is the whole point: pm froze be9b232 while
 * production was eae0b22, production became 7f31808, and nothing in the log went stale, so the same dead sha was
 * repeated in an instruction and a focus three times.
 */
/**
 * t-130 (pd 02:53): a note saying a person did by hand what a finished rule would have done — 「顶替：t-113，我又手裁了
 * 一条接缝」. The number it produces is not "how many tasks are waiting to ship", which pd already judged is the cost
 * of a choice the human made; it is **how many times that choice made a person do the machine's work**.
 *
 * The limit is stated rather than papered over (pm, criterion 4): the service cannot notice a stand-in by itself. When
 * pm resolves a seam by hand, nothing tells the service that t-113 would have done it. So a person declares, and the
 * service checks the one half it can — that the task named really is verified and really is not running yet.
 */
export const STOOD_IN_PREFIX = "顶替：";
/** t-130: three times in one day for the same task, and the service puts a specific proposal to the human. */
export const STAND_IN_ASK_TITLE = "有一件做好了的事，今天你们手工顶了三次";
export const STAND_IN_OPTIONS = ["上线它", "先这样"] as const;
export const STAND_IN_TRIGGER = 3;
export const STAND_IN_DAY_MS = 24 * 3600_000;

/**
 * t-145: how often a watching node asks for what is new — **one number, in one place**. It was in four: the CLI's real
 * default (20s), the manual and CLAUDE.md teaching 25s, and the reminder suggesting 60s. Nobody chose any of them
 * against the others; three of the four were simply never revisited, and pm ruled on 25 while the default was 20.
 *
 * The number itself is a judgement, not a measurement (pm, t-145 判据 4). What should really set it is how often six
 * nodes can ask this machine for news without getting in each other's way, and nobody has measured that. When there
 * are numbers — machine limits, or a run at a slower rate — this is the one line to change.
 */
export const WATCH_INTERVAL = "60s";

/**
 * t-147 (pd 05:40, superseding its own 05:15): **由行动证明，不由回执证明。** Whether an instruction reached anyone is
 * something the service can work out — the recipient's cursor says what they have read, and their own events say what
 * they did with it. An `ack` measured neither: tonight release skipped every one of them while working steadily on
 * what it was sent, which is what finally showed that `ack` was measuring diligence and not receipt.
 *
 * Three states, none of them written as an event:
 *   未读     their cursor has not passed it yet.
 *   已读未动  it has, and they have written nothing that refers to it.
 *   办了     they wrote something that refers to it — its id in `refs` or in the body, or an ack of it.
 *
 * What is still owed is only what carries content: a card with options needs an answer, and something you do not
 * intend to do needs 「不办：<原因>」. Refusing is information; silence is not.
 *
 * This constant is the one Chinese statement of it, so the manual quotes rather than paraphrases (t-147 判据 5).
 */
export const REACH_STATES = ["unread", "read", "acted"] as const;
export type Reach = (typeof REACH_STATES)[number];
export const REACH_WORDS: Record<Reach, string> = { unread: "还没读到", read: "读到了，还没动", acted: "办了" };
/**
 * pd 06:27 给的字，一字未改（t-141 判据 4：措辞归 pd）。说明书那一段直接引它，不要转述；改它要 pd 先改这里。
 * 注意它只说「读没读到」，而模型有三态——第三态「办了」是这句的后果不是它的内容，我问过 pd，见 t-141 的 note。
 */
export const REACH_RULE =
  "发给你的指令，服务从你的拉取自己知道你读没读到，不必回执。你欠的只有两件：带选项的卡要一个答案；不打算办的写一句「不办：原因」。沉默不是答案——发的人会一直以为你还没读到。";
/** t-147: the opening of a refusal, which is an answer and closes an instruction the way an answer does. */
export const DECLINE_PREFIX = "不办：";

/**
 * t-149: 一道闸（一条自动判断，做出结论并据此挡人）的名字。判决与「修哪道闸」都指它，所以两边说的是同一道闸。
 * 今天只有接缝闸有过被人核对的历史；再加一道闸，就在这里加一个名字，不在别处另起一套。
 */
export const GATES = ["seam"] as const;
export type Gate = (typeof GATES)[number];

/**
 * t-149: 一条接缝解决对**闸本身**的判决，与它对两件任务的处置分开。
 *
 * 今晚 pm 每一次都做了这个判断，但只写在解决的正文里，于是它算不出来——而且按词去猜会数反：
 * 01M1XAN1V2Z150HBEYY6RQQCGX 的正文同时含「真接缝」和「假接缝」，后者出现在「不属于今晚那八条假接缝」
 * 这句否定里。所以判决是一个声明的字段，不是从散文里认出来的词。
 *
 * `missed` 与判决正交：t-139+t-140 是真接缝，闸同时还漏报了两个真撞的文件。真与漏可以同时成立。
 */
export const SEAM_VERDICTS = ["real", "false"] as const;
export type SeamVerdict = (typeof SEAM_VERDICTS)[number];
export const SEAM_VERDICT_WORDS: Record<SeamVerdict, string> = { real: "真接缝", false: "误报" };

/**
 * t-149: 「这道闸的修法在哪一件任务上」——一条事实，`project:gate.<闸>.fix`，值是任务 id。
 * 它只是个指针；「这道闸此刻可不可信」不由它决定，由被判过的结论算出来（见 gateHonesty）。
 */
export const gateFixKey = (gate: Gate) => `gate.${gate}.fix`;

export const BATCH_PREFIX = "batch.";
export const BATCH_SURFACE = "repo";
export interface BatchValue { sha: string; base: string; contains: string[] }
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
