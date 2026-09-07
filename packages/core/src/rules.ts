import { type Event, type NewEvent, type ReadingShape, INSTRUCTION_MAX_CHARS, TITLE_MAX_CHARS, MIGRATION_DONE_KEY, MIGRATION_ASK_TITLE, MIGRATION_OK, INSTRUCTION_INTENTS, PM_ACTOR, PD_ACTOR, SERVICE_ACTOR, SHOWS_MAX_CHARS, VERIFIER_ROLES, VERIFY_RESPONSIBILITY, PROJECT_SURFACE, ROLES_KEY, ROLE_ID_RE, ALERT_REACHED_KEY, STOOD_IN_PREFIX, DEPLOYED_TASKS_KEY, SEAM_VERDICTS, NO_HUMAN_IMPACT, EMPTY_IS_NOT_NO_IMPACT, NO_SYMBOL_MEANS_UNCLEAR, isDefaultApplied, touchesHumanVisible, RENDERING_FILES } from "./events.js";
import { SECOND_HOME_FROZEN } from "./sayings.js";
import { type State, type TaskState, openSeamsFor, blockingSeamsIfTouches, passedOn, shapeFor, criteriaAuthors, DEFAULT_DECIDER } from "./reduce.js";
import { projectRoles, roleResponsibilities, deployedTasksFact } from "./board.js";

/** t-098: has the human answered 对 on a migration check card? Nothing about finishing the move happens before that. */
export function migrationApproved(s: State): boolean {
  return [...s.instructions.values()].some((st) => st.instruction.actor === SERVICE_ACTOR && st.instruction.body.startsWith(MIGRATION_ASK_TITLE) && st.chosen?.option === MIGRATION_OK && st.chosen.by !== DEFAULT_DECIDER);
}

/**
 * t-101 + t-104 (M4：拒绝要带出路)。谁能在这个项目里落 **pass**？由下面 `case "verify"` 里同一套规则算出来，不另存一份名单——
 * 名单与它描述的规则分开维护必然漂移（同 omitted 的教训）。
 *
 * t-104（pd 23:59 的裁定）：pass 与 fail 不对称。说「达标」是放行，需要独立性，所以只有持 R6 验收职责、且没被三条分离规则
 * 排除的角色能落；说「没达标」与自身利益相反，只挡发布不放行，所以对所有人开放，不需要这份名单。候选是项目声明的角色
 * （`project:roles`），human 不在其中：human 什么都能验，把他算进去就永远不会出现「一个都没有」，而那正是最该说清楚的一种。
 */
/** t-106: the ids a `project:roles` value declares, whatever shape it is written in. Nothing else is validated here. */
export function declaredRoleIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string") return value.split(",").map((x) => x.trim()).filter(Boolean);
  if (value && typeof value === "object") return Object.keys(value as object);
  return [];
}

export function verifierEligibility(s: State, t: TaskState, surface: string | undefined, human: string): { eligible: string[]; blocked: { role: string; why: string }[] } {
  const authors = criteriaAuthors(t);
  const holds = roleResponsibilities(s);
  const here = surface ? t.verifications.filter((v) => v.round === t.round && v.surface === surface) : [];
  const standing = here[here.length - 1];
  const passers = standing?.pass ? new Set([standing.by]) : new Set<string>();
  const failedHere = here.find((v) => !v.pass); // t-104 ②: one fail closes this surface to every pass until a new done
  const eligible: string[] = [];
  const blocked: { role: string; why: string }[] = [];
  for (const role of projectRoles(s)) {
    if (role === human) continue;
    const why: string[] = [];
    if (!(holds[role] ?? []).includes(VERIFY_RESPONSIBILITY)) why.push(`不持 ${VERIFY_RESPONSIBILITY}`); // t-104: pass 要独立，先要是验收角色
    if (role === t.owner) why.push("是 owner");                              // the owner cannot pass their own task
    if (authors.includes(role)) why.push("写了判据");                        // whoever wrote the criteria cannot judge them met
    if (passers.has(role)) why.push(`已在 ${surface} 上判过 pass`);           // a pass does not override a pass
    else if (failedHere) why.push(`这一轮 ${surface} 上已有 ${failedHere.by} 的 fail，要等新的 done`); // t-104 ②
    if (why.length) blocked.push({ role, why: why.join("、") });
    else eligible.push(role);
  }
  return { eligible, blocked };
}

/**
 * The way out, appended to every rejection of a **pass**: who could pass instead. A fail needs no such line — since
 * t-104 anyone may fail, so a fail is only ever refused for what its evidence says, never for who is saying it.
 * t-112 (qa 03:53): it used to end by saying, in its own words, that a fail is still open. That is PASS_ONLY_GATE's
 * sentence, and two ways of saying one thing is the drift t-118 exists to stop — so the callers append the sentence
 * and this says only what is its own: who could pass instead.
 * pd 23:50：一个都没有时先说自动会发生什么，再说人要做的选择，否则人以为系统卡住在等他救场。但「验收自动进 human 的
 * 需要你」（t-055）看的是项目里有没有 qa 类角色，不是这一件有没有合格的人——所以那句也现算，不照抄。
 */
export function whoCanVerify(s: State, t: TaskState, surface: string | undefined, human: string): string {
  const { eligible, blocked } = verifierEligibility(s, t, surface, human);
  if (eligible.length) return `。可以由谁来落 pass：${eligible.join("、")}`;
  const why = blocked.length ? blocked.map((b) => `${b.role} ${b.why}`).join("；") : `${projectRoles(s).join("、")} 里除了 ${human} 没有别人`;
  const escalates = !projectRoles(s).some((r) => VERIFIER_ROLES.includes(r)); // t-055 的自动退化：整个项目没有验收角色时才发生
  const next = escalates
    ? `这件的验收会进 ${human} 的「需要你」由他来判；要恢复三方分离，请 ${PM_ACTOR} 把一个新角色加进 ${PROJECT_SURFACE}:${ROLES_KEY}`
    : `项目里有验收角色，所以验收不会自动转给 ${human}：这一件要么请 ${human} 亲自判，要么请 ${PM_ACTOR} 再给一个角色 ${VERIFY_RESPONSIBILITY}`;
  return `。本项目没人能给这一件落 pass：${why}。${next}`;
}

/**
 * t-104 ①：自我推翻的证据要指名推翻的是哪一条判据。一个不指名的「我漏验了」既没法复核，也没法说清改完算不算好了。
 * 认「判据 3」「第 3 条」「criterion 3」「#3」这些写法，数字必须落在这件任务的判据条数之内。
 */
/**
 * t-130: why this task cannot be stood in for, or null when it can. Two facts are checked, the stronger one first:
 * production's own containment fact if it covers the head production is actually at, and otherwise whether anyone has
 * passed it on production. The weaker check is not a guess — a task nobody has verified on production is, as far as
 * this log is concerned, not known to be running — and using it keeps the rule usable on the very ordinary day when
 * nobody has run `ateam release` yet.
 */
function standInBlocker(s: State, t: TaskState): string | null {
  const fact = deployedTasksFact(s);
  const head = latestDeployedSha(s);
  if (fact && head && fact.sha.slice(0, 7) === head.slice(0, 7)) {
    return fact.contained.includes(t.id) ? `的代码已经在生产上（production:${DEPLOYED_TASKS_KEY} 对 ${head.slice(0, 7)} 测的）` : null;
  }
  return t.verifications.some((v) => v.round === t.round && v.surface === "production" && v.pass) ? "这一轮已经有人在 production 上判过 pass" : null;
}

/** The sha the latest valid production:deployed.sha reading names. */
function latestDeployedSha(s: State): string | null {
  const id = s.latestReading.get("production:deployed.sha");
  const r = id ? s.readings.get(id) : undefined;
  return r?.valid && !r.expired && typeof r.reading.value === "string" ? r.reading.value : null;
}

export function namesCriterion(evidence: string, count: number): boolean {
  if (count <= 0) return false;
  for (const m of evidence.matchAll(/(?:判据|criterion|criteria|条|#)\s*[第]?\s*(\d+)|第\s*(\d+)\s*条/gi)) {
    const n = Number(m[1] ?? m[2]);
    if (n >= 1 && n <= count) return true;
  }
  return false;
}

/**
 * t-112 (pd 00:51 的通则)：凡是为了防止**过早放行**而设的闸，一律只拦 pass，不拦 fail。理由是不对称的那条：
 * 放行需要独立与前提，报坏消息不需要——一道拦住「它坏了」的闸，只会让那条消息留在某个人嘴上。
 * 不给 fail 开带理由的旁路：带理由的旁路会被习惯性使用。
 */
export const PASS_ONLY_GATE = "。这挡住的是通过，不是不通过；要记它坏了，直接落 fail。";

/**
 * t-112 round 2 (qa 03:53): the first round surveyed the gates by hand, from what pd and pm had named out loud, and
 * missed the R6 gate added the same night — the exact failure the criterion warned about ("数目以普查为准…今天已经栽过
 * 一次只修报上来的那一处"), repeated. A count made once is wrong the next time someone adds a branch, so the survey
 * stops being a count: `case "verify"`'s `if (e.pass)` block is, by construction, every gate that refuses a pass and
 * nothing else, and a test reads it and requires PASS_ONLY_GATE of every throw inside it. Adding a gate without the
 * sentence now fails the build rather than waiting to be noticed on production.
 */
export const PASS_ONLY_REGION = "if (e.pass) {";

export class Rejected extends Error {
  constructor(public readonly rule: string, message: string) {
    super(`${rule}: ${message}`);
  }
}

/**
 * The structural rules. They are the product; everything else is storage.
 * Throws Rejected. `state` is the reduction of the log *before* this event.
 */
/**
 * t-109 (M4): a shape check that runs before any rule reads a field. qa 00:26 sent a `task seam` event that wrote its
 * two tasks as `a`/`b` instead of `tasks`, and the seam rule reached straight for `e.tasks[0]`: TypeError, straight
 * past `Rejected`, out as a 500. A 500 tells the caller the service is broken; a 409 tells them the service is working
 * and they mistyped a field. The fix is one table rather than a guard at each of those reads: a new op that forgets to
 * declare its required fields is the only way back to a crash, and the table is where you would look.
 */
type FieldKind = "string" | "boolean" | "strings" | "pair";
const REQUIRED: Record<string, Record<string, FieldKind>> = {
  reading: { key: "string", surface: "string" },
  instruction: { to: "string", body: "string" },
  ack: { of: "string" },
  untell: { of: "string", reason: "string" },
  note: { body: "string" },
  "task:create": { task: "string", title: "string", criteria: "strings" },
  "task:label": { task: "string", label: "string" },
  "task:claim": { task: "string", touches: "strings" },
  "task:done": { task: "string" },
  "task:verify": { task: "string", surface: "string", pass: "boolean" },
  "task:block": { task: "string", on: "string" },
  "task:unblock": { task: "string" },
  "task:withdraw": { task: "string", reason: "string" },
  "task:obsolete": { task: "string", decision: "string" },
  "task:reopen": { task: "string", reason: "string" },
  "task:criteria": { task: "string", add: "strings" },
  "task:seam": { tasks: "pair", resolution: "string" },
};
/** Optional fields whose *type* still has to hold when they are present: a wrong type reads like a missing one. */
const OPTIONAL: Record<string, Record<string, FieldKind>> = {
  reading: {}, instruction: { options: "strings", default: "string", intent: "string" }, ack: {}, untell: {},
  note: { supersedes: "string", task: "string", label: "string" },
  "task:done": { evidence: "string", shows: "string", touches: "strings", no_human_impact: "boolean", internal_only: "strings" },
  "task:verify": { evidence: "string", shows: "string" },
  "task:seam": { verdict: "string", missed: "boolean" },
  "task:create": { label: "string", shows: "string", no_human_impact: "boolean" },
  "task:obsolete": { reason: "string" },
};

const holds = (v: unknown, k: FieldKind): boolean =>
  k === "string" ? typeof v === "string" && v.length > 0
  : k === "boolean" ? typeof v === "boolean"
  : k === "strings" ? Array.isArray(v) && v.every((x) => typeof x === "string")
  : Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "string" && x.length > 0);
const SHAPE_OF: Record<FieldKind, string> = { string: "一个非空字符串", boolean: "true 或 false", strings: "一个字符串数组", pair: "两个任务 id 的数组，例如 [\"t-1\", \"t-2\"]" };

/** Throws Rejected — never a TypeError — when an event is missing a field a rule is about to read, or has it wrong. */
export function checkShape(e: NewEvent): void {
  if (e.refs !== undefined && !holds(e.refs, "strings")) throw new Rejected("shape", `refs 要是${SHAPE_OF.strings}，收到 ${valueForm(e.refs)}`);
  const kinds = ["reading", "instruction", "ack", "untell", "note", "task"];
  if (!kinds.includes(e.kind as string)) throw new Rejected("shape", `kind ${JSON.stringify(e.kind)} 不是事件种类之一：${kinds.join("、")}`);
  let slot: string = e.kind;
  if (e.kind === "task") {
    const op = (e as { op?: unknown }).op;
    const ops = Object.keys(REQUIRED).filter((k) => k.startsWith("task:")).map((k) => k.slice(5));
    if (typeof op !== "string" || !ops.includes(op)) throw new Rejected("shape", `task 事件要带 op，${op === undefined ? "这条没带" : `${JSON.stringify(op)} 不是其中之一`}：${ops.join("、")}`);
    slot = `task:${op}`;
  }
  const rec = e as unknown as Record<string, unknown>;
  for (const [field, kind] of Object.entries(REQUIRED[slot] ?? {})) {
    if (!holds(rec[field], kind)) {
      const what = rec[field] === undefined ? "这条没带它" : `收到 ${valueForm(rec[field])}`;
      throw new Rejected("shape", `${slot} 要带 ${field}（${SHAPE_OF[kind]}），${what}。字段名写错了也会走到这里——按 ${slot} 该有的字段核一遍：${Object.keys(REQUIRED[slot]).join("、")}`);
    }
  }
  for (const [field, kind] of Object.entries(OPTIONAL[slot] ?? {})) {
    if (rec[field] !== undefined && !holds(rec[field], kind)) throw new Rejected("shape", `${slot} 的 ${field} 可以不带，带了就要是${SHAPE_OF[kind]}，收到 ${valueForm(rec[field])}`);
  }
  // one nested shape a rule reaches into: a note that decides an instruction
  const d = (e as { decides?: unknown }).decides;
  if (d !== undefined) {
    const o = d as { of?: unknown; option?: unknown };
    if (!d || typeof d !== "object" || Array.isArray(d) || !holds(o.of, "string") || !holds(o.option, "string"))
      throw new Rejected("shape", `note 的 decides 要是 {of: "<指令 id>", option: "<选项>"}，收到 ${valueForm(d)}`);
  }
  const sh = (e as { shape?: unknown }).shape;
  if (sh !== undefined && (!sh || typeof sh !== "object" || Array.isArray(sh))) throw new Rejected("shape", `reading 的 shape 要是 {regex?, enum?} 这样的对象，收到 ${valueForm(sh)}`);
}

export function validate(state: State, e: NewEvent, human: string, now: Date = new Date()): void {
  if (!e.actor) throw new Rejected("actor", "actor is required");
  checkShape(e); // t-109: shape before rules, so no rule ever reads a field that is not there

  // R0: you may not build on a reading that is no longer true, nor on an event that is not in the log.
  for (const ref of e.refs ?? []) {
    if (!state.ids.has(ref)) throw new Rejected("ref", `${ref} is not an event in this log`);
    const rs = state.readings.get(ref);
    if (!rs) continue;
    if (!rs.valid || rs.expired) {
      const why = rs.superseded_by ? `superseded by ${rs.superseded_by}`
        : rs.invalidated_by ? `invalidated by ${rs.invalidated_by}`
        : "expired";
      throw new Rejected("stale-reading", `${ref} (${rs.reading.surface}:${rs.reading.key}) is ${why}; take a fresh reading`);
    }
  }

  switch (e.kind) {
    // R0b: a surface:key that declared a shape only takes values of that shape. The declaration is made once per surface:key;
    // it never leaks to another surface (staging:users.count is not production:users.count).
    case "reading": {
      if (!e.key || !e.surface) throw new Rejected("reading", "key and surface are required");
      // t-127 (M4, pd 02:18): a key that repeats its own surface lands as project:project:roles, and nothing that reads
      // project:roles will ever see it. What makes this one worth a rule is that it *looks* like it worked: 201 back, a
      // row in the log, no consumer — harder to notice than an error. pm wrote it that way once and the reading was
      // invisible for hours. A key may still contain a colon (node:release:能力 is a real one); only its own surface,
      // said twice, is the mistake.
      // t-134: "we reached you" is a thing only the service can know — it is the record of a call it made. A node that
      // writes one is not recording a fact, it is asserting a conclusion, and the board would then promise the human
      // that a never-tested address works. The same holds for the human's own "try it now": the service tries and the
      // service records; whoever pressed the button does not get to write the answer.
      if (e.surface === PROJECT_SURFACE && e.key === ALERT_REACHED_KEY && e.actor !== SERVICE_ACTOR)
        throw new Rejected("alert.reached", `${PROJECT_SURFACE}:${ALERT_REACHED_KEY} 只由服务自己写：它记的是「外呼真的送到了」，而只有发出那次外呼的服务知道这件事。${e.actor} 写的这一条会让牌桌对人说「你不在时会发到这里」——一个从没证明过能送到的地址。要证明它，让服务真发一次（外呼成功时会自己记下来），人点「现在试一下」也是服务去试、服务记结果。证不到就停在「还没真发成功过」，那是四态里本来就有的一态`);
      if (e.key.startsWith(`${e.surface}:`))
        throw new Rejected("reading", `键里不要再说一遍表面名：--surface ${e.surface} 已经说了这是 ${e.surface} 的。键写成 ${JSON.stringify(e.key)} 会落成 ${e.surface}:${e.key}，而要读它的人找的是 ${e.surface}:${e.key.slice(e.surface.length + 1)}，对不上，谁也读不到——命令还会返回 201、日志里有一条，比报错更难发现。正确写法：--surface ${e.surface} <键> ${e.key.slice(e.surface.length + 1)}`);
      // t-098 (M7): "the move is finished" may not be recorded before the human said 对 on the check card. The button is the
      // authorisation to touch the old channel; without it, nothing may claim the move is over.
      if (e.key === MIGRATION_DONE_KEY && !migrationApproved(state)) {
        throw new Rejected("migration", "human 还没在核对卡上点「对」；在他点之前不要动旧渠道，也不能记「迁移完成」");
      }
      // t-089 (M4): a reading carried in from somewhere else says when it was measured there; without that it is a number
      // with no time and nobody can tell what it is worth. It lands expired either way — whoever needs it measures again.
      if (e.from && !e.measured_at) throw new Rejected("reading", "搬进来的事实必须带 measured_at（它在原处是什么时候测的）；缺 measured_at，不写入");
      // t-106 (M4): a role id travels in an HTTP header, and a header is latin-1. A non-ASCII id therefore does not fail
      // loudly — it becomes a different, unreadable identity, and the whole team shows up missing. Say so at declaration
      // time, when it is one edit away, rather than never (qa 00:14 found this by making a team called 主编/写手/审稿).
      if (e.surface === PROJECT_SURFACE && e.key === ROLES_KEY) {
        const bad = declaredRoleIds(e.value).filter((x) => !ROLE_ID_RE.test(x));
        if (bad.length)
          throw new Rejected("reading", `角色 id 只能是 ASCII 小写（${ROLE_ID_RE.source}），这些不行：${bad.join("、")}。id 要走 HTTP 头（X-Actor），头按规矩只放 latin-1，非 ASCII 的 id 不会报错、会变成另一个谁也读不出的身份，整队在牌桌上显示不在场。出路：id 用 ASCII 小写，名字放显示名里——把 {"审稿": ["R6"]} 写成 {"reviewer": {"name": "审稿", "responsibilities": ["R6"]}}，把 {"主编": ["R1"]} 写成 {"editor": {"name": "主编", "responsibilities": ["R1"]}}。显示名不限语言、不限长度，人看到的到处都是它`);
      }
      if (e.measured_at !== undefined) {
        const m = Date.parse(e.measured_at);
        if (Number.isNaN(m)) throw new Rejected("reading", `measured_at ${JSON.stringify(e.measured_at)} is not a time`);
        if (m > now.getTime()) throw new Rejected("reading", `measured_at ${e.measured_at} is later than now (${now.toISOString()}); a measurement cannot come from the future`);
        if (e.valid_until !== undefined && Date.parse(e.valid_until) < m) throw new Rejected("reading", "valid_until is before measured_at");
      }
      const declared = shapeFor(state, e.surface, e.key);
      if (e.shape) {
        if (e.shape.regex === undefined && !e.shape.enum?.length) throw new Rejected("reading", "a shape needs a regex or a non-empty enum");
        if (e.shape.regex !== undefined) try { new RegExp(e.shape.regex); } catch { throw new Rejected("reading", `shape regex ${JSON.stringify(e.shape.regex)} does not compile`); }
        if (declared && !sameShape(declared, e.shape))
          throw new Rejected("reading", `${e.surface}:${e.key} already has shape ${describeShape(declared)}; a shape is declared once`);
      }
      const shape = e.shape ?? declared;
      if (shape && !matchesShape(shape, e.value))
        throw new Rejected("reading", e.key === "alert.webhook" ? `外呼只支持 https webhook，收到的是${valueForm(e.value)}；不写入` : `${e.surface}:${e.key} = ${JSON.stringify(e.value)} does not match shape ${describeShape(shape)}`);
      return;
    }

    // R1: an instruction is short, has one recipient, and a deadline to be acked.
    case "instruction":
      if (!e.to) throw new Rejected("instruction", "to is required");
      if (e.to === e.actor) throw new Rejected("instruction", "cannot instruct yourself");
      if (!e.body?.trim()) throw new Rejected("instruction", "body is required");
      if (e.body.length > INSTRUCTION_MAX_CHARS)
        throw new Rejected("instruction", `body is ${e.body.length} chars; max ${INSTRUCTION_MAX_CHARS}. Put the argument in a note and the action here.`);
      // t-181 判据 6 (pd 09:17)：带默认的卡没有 ack_by，那个默认永远不会生效——「到期按 X」里没有「到期」。
      // CLI 总会填 15m，所以这道闸防的是别的客户端与直接调 API 的情形，拒绝话要说清怎么补。
      if (!e.ack_by) throw new Rejected("instruction", e.default !== undefined
        ? `带默认的卡必须有 ack_by：默认的意思是「到期按 ${e.default}」，没有到期时刻它永远不会生效。加上 ack_by（CLI 是 --ack-by 15m）`
        : "ack_by is required");
      if (e.intent !== undefined) {
        if (e.to !== human) throw new Rejected("instruction", `kind is for the human's board; ${e.to} just acts`);
        if (!INSTRUCTION_INTENTS.includes(e.intent)) throw new Rejected("instruction", `kind must be one of ${INSTRUCTION_INTENTS.join(" | ")}, not "${e.intent}"`);
      }
      if (e.options !== undefined || e.default !== undefined) {
        if (e.to !== human) throw new Rejected("instruction", `options are for the human; ${e.to} acts, the human decides`);
        const opts = (e.options ?? []).map((o) => o.trim());
        if (opts.length < 2 || opts.some((o) => !o)) throw new Rejected("instruction", "give at least two non-empty options");
        if (new Set(opts).size !== opts.length) throw new Rejected("instruction", "options must be distinct");
        if (e.default !== undefined && !opts.includes(e.default)) throw new Rejected("instruction", `default "${e.default}" is not one of the options`);
      }
      return;

    case "ack": {
      const st = state.instructions.get(e.of);
      if (!st) throw new Rejected("ack", `${e.of} is not an instruction`);
      // the service may ack what it wrote itself (a missing-role card that is no longer true)
      if (st.instruction.to !== e.actor && e.actor !== human && !(e.actor === SERVICE_ACTOR && st.instruction.actor === SERVICE_ACTOR))
        throw new Rejected("ack", `${e.of} is addressed to ${st.instruction.to}, not ${e.actor}`);
      if (st.acked_at) throw new Rejected("ack", `${e.of} already acked at ${st.acked_at}`);
      if (st.withdrawn) throw new Rejected("ack", `${e.of} was taken back by ${st.withdrawn.by} (${st.withdrawn.reason}); nothing to ack`);
      return;
    }

    // R1c (t-064): the sender may take an instruction back to stop harm, only while nobody has acted on it.
    case "untell": {
      const st = state.instructions.get(e.of);
      if (!st) throw new Rejected("untell", `${e.of} is not an instruction`);
      if (!e.reason?.trim()) throw new Rejected("untell", "say why (--reason)");
      if (st.instruction.actor !== e.actor && e.actor !== human) throw new Rejected("untell", `${e.of} was sent by ${st.instruction.actor}; only the sender or ${human} can take it back, not ${e.actor}`);
      if (st.withdrawn) throw new Rejected("untell", `${e.of} was already taken back by ${st.withdrawn.by}`);
      if (st.acked_at) throw new Rejected("untell", `${e.of} was acked by ${st.acked_by} at ${st.acked_at}; what was seen and confirmed cannot be unsaid. Send a new instruction that cancels it`);
      if (st.chosen) throw new Rejected("untell", `${e.of} was decided (${st.chosen.option} by ${st.chosen.by}); a decision is not taken back. Send a new ask`);
      return;
    }

    case "note":
      if (!e.body?.trim()) throw new Rejected("note", "body is required");
      if (e.supersedes && !state.notes.some((n) => n.id === e.supersedes))
        throw new Rejected("note", `${e.supersedes} is not a note`);
      if (e.task !== undefined && !state.tasks.has(e.task)) throw new Rejected("note", `${e.task} is not a task in the log`);
      // t-130 (pd 02:53): a stand-in names the finished rule a person did the work of. The service cannot notice one
      // by itself — nothing tells it that a hand-resolved seam is t-113's job — so a person declares it and the
      // service checks the half it can: that the rule really is finished and really is not running yet. Without that
      // check the number is a hand-kept list, which is what this was asked not to be.
      if (e.body.startsWith(STOOD_IN_PREFIX)) {
        if (!e.task) throw new Rejected("stand-in", `${STOOD_IN_PREFIX}… 要指名它替代的是哪一件任务（--task <id>）：这条数是「哪一件做好了的事还在让人替它干活」，没有那件任务就只是一句感想`);
        const t = state.tasks.get(e.task)!;
        if (t.status !== "verified")
          throw new Rejected("stand-in", `${t.id} 是 ${t.status}，不是 verified：还没验过的东西谈不上「本来可以自动」——顶替记的是「做好了却没上线」的代价，不是「还没做好」的代价`);
        const where = standInBlocker(state, t);
        if (where) throw new Rejected("stand-in", `${t.id} ${where}：它已经在替你干活了，这一次不是顶替。若你觉得它没生效，那是一件缺陷，请开任务`);
      }
      // R1b: a decision on an instruction names one of its options, and only the recipient or the human decides.
      if (e.decides) {
        const st = state.instructions.get(e.decides.of);
        if (!st) throw new Rejected("decide", `${e.decides.of} is not an instruction`);
        const i = st.instruction;
        if (!i.options?.length) throw new Rejected("decide", `${i.id} carries no options`);
        if (st.withdrawn) throw new Rejected("decide", `${i.id} was taken back by ${st.withdrawn.by} (${st.withdrawn.reason})`);
        if (!i.options.includes(e.decides.option)) throw new Rejected("decide", `"${e.decides.option}" is not one of: ${i.options.join(" | ")}`);
        // t-181 (pd 09:18)：默认到期由**服务**落成一条真事件，所以服务也能决定——但只在它该决定的那一刻、
        // 只能选那个默认值。别的时候服务和任何人一样无权替人点。
        const byService = e.actor === SERVICE_ACTOR && isDefaultApplied(e.body ?? "");
        if (byService) {
          if (i.default === undefined) throw new Rejected("decide", `${i.id} 没有默认值：没有默认，就没有「到期按什么」这回事`);
          if (e.decides.option !== i.default) throw new Rejected("decide", `默认是 ${i.default}，不是 ${e.decides.option}——服务只能替人落下那个默认值`);
          if (!(i.ack_by < now.toISOString())) throw new Rejected("decide", `${i.id} 还没到期（${i.ack_by}）：默认到期才生效，早一秒都是替人做主`);
        } else if (i.to !== e.actor && e.actor !== human) {
          throw new Rejected("decide", `${i.id} is addressed to ${i.to}, not ${e.actor}`);
        }
        // a default that took effect at ack_by may still be overridden; a real decision may not
        if (st.chosen && st.chosen.by !== DEFAULT_DECIDER) throw new Rejected("decide", `${i.id} already decided: ${st.chosen.option} by ${st.chosen.by}`);
        if (!e.decision) throw new Rejected("decide", "a choice is a decision; set decision: true");
      }
      return;

    case "task":
      return validateTask(state, e, human);
  }
}

/**
 * t-151 与 t-171 是同一道闸的两头：**承诺的时候和交活的时候，都要说一句这件对人有什么影响，或者明写它没有。**
 *
 * 所以这句话只写一遍。两处各写一份，迟早有一处先改——t-171 判据 2 那句「同一句拒绝话」就是这个函数存在的理由。
 */
function humanImpactPromised(op: "create" | "done", e: { shows?: string; no_human_impact?: boolean }): void {
  const what = op === "create" ? "建一件任务要先说清它对人有什么影响" : "交活要说一句这件对人有什么影响";
  if (e.no_human_impact && e.shows?.trim()) throw new Rejected(op, `既写了 shows「${e.shows.trim()}」又说「${NO_HUMAN_IMPACT}」，这两句话互相矛盾：留一个`);
  if (!e.shows?.trim() && !e.no_human_impact)
    throw new Rejected(op, `${what}：--shows "<人现在能看到什么>"；确实什么都没变就明写 --no-human-impact（意思是「${NO_HUMAN_IMPACT}」，你看过了）。${EMPTY_IS_NOT_NO_IMPACT}`);
}

function validateTask(state: State, e: NewEvent & { kind: "task" }, human: string): void {
  if (e.op === "create") {
    if (state.tasks.has(e.task)) throw new Rejected("task", `${e.task} already exists`);
    if (!e.title?.trim()) throw new Rejected("task", "title is required");
    if (!e.criteria?.length) throw new Rejected("task", "at least one acceptance criterion is required");
    // t-171 (pd 08:27)：承诺那头也要有闸。一件任务在**被写下来的时候**就该说清它对人有什么影响，而不是等到
    // 交活时才第一次被问——那时范围已经定死了，答案只能是把已经做的事描述一遍。今晚 83 件里 78 件说不出人能
    // 看到什么，问题不在交活的人身上：没有人在建它的时候问过这个问题。
    humanImpactPromised("create", e);
    return;
  }
  if (e.op === "seam") {
    const seam = [...state.seams.values()].find(
      (s) => s.tasks.includes(e.tasks[0]) && s.tasks.includes(e.tasks[1]),
    );
    if (!seam) throw new Rejected("seam", `no seam between ${e.tasks[0]} and ${e.tasks[1]}`);
    // t-149: a resolved seam takes one more event, and only one kind — the verdict on the *gate*. Tonight's eight
    // judgements were made and written as prose before the field existed; without this they could never be recorded,
    // and 「已知缺陷由日志算出」 would quietly mean 「算不出来」. It adds, it never edits: the original resolution's
    // text, author and time stay exactly as they were, and a seam already judged is not judged twice.
    if (seam.resolution && !(e.verdict || e.missed)) throw new Rejected("seam", `already resolved by ${seam.resolution.by}; only a --verdict on the gate can still be added`);
    if (seam.resolution?.verdict) throw new Rejected("seam", `the gate was already judged ${seam.resolution.verdict} by ${seam.resolution.judged_by}; a judgement is not made twice`);
    if (!e.resolution?.trim()) throw new Rejected("seam", "resolution is required");
    // t-149: the verdict on the gate itself is a declared value, never a word fished out of the prose.
    if (e.verdict !== undefined && !SEAM_VERDICTS.includes(e.verdict)) throw new Rejected("seam", `verdict must be one of ${SEAM_VERDICTS.join(" | ")}, not "${e.verdict}"`);
    if (e.missed !== undefined && typeof e.missed !== "boolean") throw new Rejected("seam", "missed is true or nothing: it says the gate also failed to report something it should have");
    return;
  }
  const t = state.tasks.get(e.task);
  if (!t) throw new Rejected("task", `${e.task} does not exist`);
  if (t.status === "withdrawn") throw new Rejected(e.op, `${t.id} is withdrawn (${t.withdrawn?.reason ?? ""}); ids are forever, create a new task`);
  if (t.status === "obsolete") throw new Rejected(e.op, `${t.id} is obsolete (superseded by ${t.obsolete?.decision}); ids are forever, create a new task`);

  switch (e.op) {
    // R6: a task created on a false premise ends without anyone pretending to do it. Only before work starts
    // (open or blocked), only by whoever owns its scope: the criteria author, pm, or the human.
    // R8: after done or failed the owner may take the task back to change it; what was judged stays on record.
    case "reopen":
      if (!e.reason?.trim()) throw new Rejected("reopen", "say why (--reason)");
      if (t.status !== "done" && t.status !== "failed")
        throw new Rejected("reopen", `${t.id} is ${t.status}; only a done or failed task can be reopened${t.status === "verified" ? " (verified is final: create a new task)" : ""}`);
      if (e.actor !== t.owner && e.actor !== PM_ACTOR && e.actor !== human)
        throw new Rejected("reopen", `only ${t.owner} (owner), ${PM_ACTOR} or ${human} can reopen ${t.id}, not ${e.actor}`);
      return;
    // R7: criteria can grow while the task is unfinished, only from those who own its scope; the adder then owns it too.
    case "criteria": {
      const add = (e.add ?? []).map((x) => x?.trim()).filter(Boolean);
      if (!add.length || add.length !== (e.add ?? []).length) throw new Rejected("criteria", "give at least one non-empty criterion");
      if (t.status === "verified") throw new Rejected("criteria", `${t.id} is verified; its criteria are what was judged. Create a new task for more`);
      const authors = criteriaAuthors(t);
      if (!authors.includes(e.actor) && e.actor !== PM_ACTOR && e.actor !== PD_ACTOR && e.actor !== human)
        throw new Rejected("criteria", `only ${authors.join("/")} (criteria author), ${PM_ACTOR}, ${PD_ACTOR} or ${human} can add criteria to ${t.id}, not ${e.actor}`);
      return;
    }
    // R6b: finished work that a later decision made moot ends as obsolete, pointing at the decision. Verified is final either way.
    case "obsolete": {
      if (!e.decision?.trim()) throw new Rejected("obsolete", "name the decision note that took its place (--by <note id>)");
      const d = state.notes.find((n) => n.id === e.decision);
      if (!d) throw new Rejected("obsolete", `${e.decision} is not a note in this log`);
      if (!d.decision) throw new Rejected("obsolete", `${e.decision} is a note, not a decision (note --decision)`);
      if (t.status === "verified") throw new Rejected("obsolete", `${t.id} is verified; verified is final: create a new task that undoes it`);
      if (t.status !== "done" && t.status !== "failed")
        throw new Rejected("obsolete", `${t.id} is ${t.status}; only a done or failed task becomes obsolete. ${t.status === "working" ? "Its owner is on it: wait for done, or have them release it, then" : "For a task nobody finished,"} use task withdraw`);
      const authors = criteriaAuthors(t);
      if (!authors.includes(e.actor) && e.actor !== PM_ACTOR && e.actor !== PD_ACTOR && e.actor !== human)
        throw new Rejected("obsolete", `only ${authors.join("/")} (criteria author), ${PM_ACTOR}, ${PD_ACTOR} or ${human} can make ${t.id} obsolete, not ${e.actor}`);
      return;
    }
    // t-096: a display name is text people read; it is never used to find anything, so anyone working on the task may set it.
    case "label":
      if (!e.label?.trim()) throw new Rejected("label", "give the name people should see (--label)");
      if ([...e.label].length > TITLE_MAX_CHARS) throw new Rejected("label", `label is ${[...e.label].length} chars; keep it short enough to read in a list (max ${TITLE_MAX_CHARS})`);
      return;
    case "withdraw":
      if (!e.reason?.trim()) throw new Rejected("withdraw", "say why (--reason)");
      if (t.status !== "open" && t.status !== "blocked")
        throw new Rejected("withdraw", `${t.id} is ${t.status}; only an open or blocked task can be withdrawn`);
      if (e.actor !== t.criteria_by && e.actor !== PM_ACTOR && e.actor !== human)
        throw new Rejected("withdraw", `only ${t.criteria_by} (criteria author), ${PM_ACTOR} or ${human} can withdraw ${t.id}, not ${e.actor}`);
      return;
    case "claim":
      // open or failed: anyone may take it. working: only its owner, to widen what it touches.
      if (t.status === "working" && t.owner === e.actor) {
        if (!e.touches?.length) throw new Rejected("claim", "say what else you will touch");
        return;
      }
      if (t.status !== "open" && t.status !== "failed")
        throw new Rejected("claim", `${t.id} is ${t.status}${t.owner ? ` (owner ${t.owner})` : ""}`);
      if (!e.touches?.length) throw new Rejected("claim", "declare what you will touch (paths/symbols/fields)");
      return;
    case "done": {
      if (e.shows !== undefined && [...e.shows].length > SHOWS_MAX_CHARS) throw new Rejected("done", `shows is ${[...e.shows].length} chars; one sentence, at most ${SHOWS_MAX_CHARS}`);
      if (t.owner !== e.actor) throw new Rejected("done", `${t.id} is owned by ${t.owner ?? "nobody"}`);
      if (t.status !== "working") throw new Rejected("done", `${t.id} is ${t.status}`);
      // t-151: 说一句这件对人有什么影响，或者明写它没有——二选一，没有第三种。今晚量到的是 83 件里只有 5 件
      // 说得出人能看到什么，78 件一句都没有；那 78 件不是「没影响」，是没人问过这个问题，而两者在记录上长得
      // 一模一样。这道闸只对新的 done 生效，日志里已有的事件一律不动（判据 2）。
      //
      // 它排在「是不是你的」「能不能交」之后：先告诉一个连交都交不了的人去补一句话，是把出路指错。
      humanImpactPromised("done", e);
      // t-151 (pd 07:49)：说了「不改变人看到的东西」，却碰了人看到的东西——拦下，并把碰到的逐个列出来。
      // 出错的方式通常不是撒谎，是顺手：改 i18n 一个词、改说明书一行，正是不会重新想一遍这句话的时刻。
      if (e.no_human_impact) {
        // t-105 的口径照旧：done 带了 touches 就是事实、取代 claim 时的声明；没带才用声明。用声明去判一件已经
        // 量过的事，会拿一个当事人自己更正过的名单去拦他。
        //
        // t-170 (pd 08:22)：按改动算，不按文件算。拒绝只发生在**算得准**的那两档——改了只装文本的地方，或改了
        // core 里那些 key 本身；两者都指得出是哪一处，人可以据此反驳一个具体的判断。算不准的那一档（只给了
        // 文件名、没说改在哪儿）不拒绝，因为一个看不见的判断不该挡住别人干活（判据 3）。
        const touches = [...new Set(e.touches ?? t.touches)];
        const seen = touches.filter((x) => touchesHumanVisible(x) === "human_visible").sort();
        // t-170 第二轮 (pd 08:33)：具名出路。写得出「只动了哪几个内部符号」就放行——它要的不是一个开关，是一次
        // 注意；写不出符号名，就说明没看清自己改了什么，那就该写 shows。符号必须真的落在被拦的那几处文件里，
        // 否则这句话可以拿任何一个符号名蒙混过去。
        // t-170 第三轮 (qa 08:46 ②)：**具名出路只属于「人可见文件里的内部符号」那一档。**
        // 上一版让它对所有被拦的触点都生效，于是多打一个编出来的符号名，就能把「只装文本的地方」和「key 本身」
        // 一起放过去——`i18n.ts` 加一个 `#随便编` 就过，而 markdown 文件里根本没有符号这种东西。pd 08:33 给这条
        // 出路的原话就是给内部符号的；被拦在①②两档的，本来就该写 shows。
        // t-143 判据 6 (pm 09:19)：**这条出路的退役条件是一个可测的状态，不是某件任务的状态。**
        // 它存在，是因为人可见的话还住在 core 之外（SECOND_HOME_FROZEN 条）；那个数归零，就说明「哪个 key 在
        // 哪显示」已经算得出来，这条出路当场失去理由，不需要谁记得去删它。那个数由 sayings.test.ts 那条闸盯着，
        // 只减不增，且比实际大就红——所以它是真的，不是一个可以随手改小的声明。
        const exitRetired = SECOND_HOME_FROZEN === 0;
        const noExit = exitRetired ? seen : seen.filter((x) => !RENDERING_FILES.some((f) => x.split("#")[0] === f));
        const named = (e.internal_only ?? []).map((x) => x.trim()).filter(Boolean);
        if (noExit.length && named.length)
          throw new Rejected("done", exitRetired
            ? `--internal-only 已经退役了：人可见的话都收进 core 之后，碰了这几处就是碰了给人看的字（${noExit.join("、")}）。用 --shows 说一句人现在能看到什么`
            : `这几处不能用 --internal-only 解释掉：${noExit.join("、")}——那里改的就是给人看的字（只装文本的地方，或 core 里那些 key 本身），没有「内部符号」这一说。用 --shows 说一句人现在能看到什么`);
        if (seen.length && named.length) {
          const covers = (f: string) => named.some((n) => n.startsWith(`${f.split("#")[0]}#`));
          const bare = named.filter((n) => !n.includes("#"));
          if (bare.length) throw new Rejected("done", `--internal-only 要写成「文件#符号」，具体到符号才算数：${bare.join("、")} 没说是哪个文件里的哪个符号`);
          // t-170 判据 8 (pm 08:46)：符号名必须与这件真正碰过的东西对得上。不然谁都能编一个——qa 实测用
          // `i18n.ts#随便编` 就过了。触点是这件碰了什么的唯一记录，所以名出来的每一个符号都要在触点里。
          const invented = named.filter((n) => !touches.includes(n));
          if (invented.length)
            throw new Rejected("done", `这几个符号不在这件的触点里：${invented.join("、")}——名出来的符号要是你真的碰过的那个。先把它 claim 进触点（task claim <id> --touches ...），或者改用 --shows`);
          const uncovered = seen.filter((f) => !covers(f));
          if (uncovered.length) throw new Rejected("done", `这几处还没说清动了里面的什么：${uncovered.join("、")}——每一处都要有一个「文件#符号」，或者改用 --shows`);
        } else if (seen.length) {
          throw new Rejected("done", `这件动了人看得到的字：${seen.join("、")}——所以不能光说「${NO_HUMAN_IMPACT}」。用 --shows 说一句人现在能看到什么；若这几处真的只动了内部符号，用 --internal-only "文件#符号" 具体说出是哪几个（${NO_SYMBOL_MEANS_UNCLEAR}）。判断就来自上面列出的那几处触点，不对就改触点`);
        }
      }
      // t-105: claim's touches were a declaration; these are the fact. Seams are recomputed from the fact, by the same
      // rules — a seam that only appears once the truth is told is the collision the declaration was hiding, and it
      // blocks the done. Seams that were already open stay the caller's business, as before: done never judged them.
      const revised = e.touches === undefined ? undefined : [...new Set(e.touches.map((x) => x.trim()).filter(Boolean))];
      if (revised) {
        const before = new Set(blockingSeamsIfTouches(state, t, t.touches).map((x) => x.with));
        const fresh = blockingSeamsIfTouches(state, t, revised).filter((x) => !before.has(x.with));
        if (fresh.length) {
          const added = revised.filter((x) => !t.touches.includes(x));
          throw new Rejected("done", `按实际改动重算接缝，多出 ${fresh.length} 条挡住 done：${fresh.map((x) => `${x.with}（碰在 ${x.overlap.join("、")}）`).join("；")}。claim 时没声明、实际碰了的是：${added.length ? added.join("、") : "（没有新触点，是对方的声明变了）"}。接缝要先存在才谈得上定：先把这些触点 claim 进来（task claim ${t.id} --touches ...，你是 owner，claim 会把它们并进声明、接缝随即出现），再与对方定下来（task seam ${t.id} ${fresh[0].with} --resolution "..."），然后 done。不属于这件的触点就去掉`);
        }
      }
      return;
    }
    // R2: done is a claim; verified is another identity's act, on a named surface, with no open seam.
    // Verified on one surface is not verified on another: a verified task may be verified again on a new surface.
    // t-104 (pd 23:59): pass and fail are not the same act. A pass releases, so it needs independence — R6, and none of
    // the three separation rules. A fail only blocks, and saying "not met" runs against the speaker's own interest, so
    // anyone may say it, including the one who passed it and the owner. What a fail still owes is evidence, not standing.
    case "verify": {
      if (e.shows !== undefined && [...e.shows].length > SHOWS_MAX_CHARS) throw new Rejected("verify", `shows is ${[...e.shows].length} chars; one sentence, at most ${SHOWS_MAX_CHARS}`);
      if (t.status !== "done" && t.status !== "verified") throw new Rejected("verify", `${t.id} is ${t.status}, not done`);
      if (!e.surface) throw new Rejected("verify", "name the surface you verified on (repo/staging/production/...)");
      // What stands on this surface right now: the latest verification of this round. A pass that was overturned no
      // longer blocks (t-104 ② presupposes the next pass is possible — by someone else); a standing pass still does.
      const mine = t.verifications.filter((v) => v.round === t.round && v.surface === e.surface);
      const standing = mine[mine.length - 1];
      const passer = standing?.pass ? standing.by : undefined;
      if (e.pass) {
        if (passer !== undefined) throw new Rejected("verify", `${t.id} already passed on ${e.surface} since it was last done; a pass does not override a pass${PASS_ONLY_GATE}带上你发现了什么（--evidence）`);
        // t-104 ② (pd 00:12, superseding 23:59): after *any* fail on this surface, the next pass there waits for a new
        // done — whoever would give it. "Someone else passes it instead" is not overturning a fail, it is changing judges.
        // A fail given in error is undone the same way: the owner dones again, saying nothing needed changing and why.
        const failed = mine.find((v) => !v.pass);
        if (failed)
          throw new Rejected("verify", `${t.id} 这一轮已经在 ${e.surface} 上判过 fail（${failed.by}）；同一表面的下一次 pass 要等一次新的 done，换个人来判不算。原 fail 不成立的话，owner 重发 done，证据写明无需改动及为什么${PASS_ONLY_GATE}`);
        if (e.actor === t.owner) throw new Rejected("verify", `the owner cannot pass their own task${whoCanVerify(state, t, e.surface, human)}${PASS_ONLY_GATE}`);
        if (criteriaAuthors(t).includes(e.actor) && e.actor !== human)
          throw new Rejected("verify", `whoever wrote the criteria cannot judge them met${whoCanVerify(state, t, e.surface, human)}${PASS_ONLY_GATE}`);
        // t-104 ①: 放行要独立，先要是这个项目的验收角色。human 是策略权威，不受此限。
        if (e.actor !== human && !(roleResponsibilities(state)[e.actor] ?? []).includes(VERIFY_RESPONSIBILITY))
          throw new Rejected("verify", `${e.actor} 不持 ${VERIFY_RESPONSIBILITY} 验收职责，落不了 pass${whoCanVerify(state, t, e.surface, human)}${PASS_ONLY_GATE}`);
        // t-112: an open seam means nobody has said how these two pieces fit — a reason not to release, never a reason
        // to refuse the news that it is broken. qa 00:51 hit this: a version known to be broken could be recorded
        // neither as broken nor as good, and the only copy of that fact was in one agent's mouth.
        const seams = openSeamsFor(state, t.id);
        if (seams.length)
          throw new Rejected("verify", `unresolved seam ${seams.map((x) => x.id + " [" + x.overlap.join(",") + "]").join(", ")}${PASS_ONLY_GATE}`);
      } else if (passer !== undefined) {
        // overturning a pass: what it owes is what it found, and — when overturning your own — which criterion.
        if (!e.evidence?.trim()) throw new Rejected("verify", `overturning a pass on ${e.surface} needs --evidence: what was found that the pass missed`);
        if (passer === e.actor && !namesCriterion(e.evidence, t.criteria.length))
          throw new Rejected("verify", `你在推翻自己在 ${e.surface} 上判的 pass：证据要指名推翻的是哪一条判据（写「判据 3」或「第 3 条」，这件共 ${t.criteria.length} 条），否则没人复核得了，也说不清改完算不算好了`);
      }
      return;
    }
    case "block":
      if (!e.on?.trim()) throw new Rejected("block", "say what you are waiting on");
      return;
    case "unblock":
      if (t.status !== "blocked") throw new Rejected("unblock", `${t.id} is not blocked`);
      return;
  }
}

export function matchesShape(shape: ReadingShape, value: unknown): boolean {
  if (shape.regex !== undefined && !new RegExp(shape.regex).test(typeof value === "string" ? value : JSON.stringify(value))) return false;
  if (shape.enum?.length && !shape.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) return false;
  return true;
}

/** t-084: what kind of thing a rejected value looks like, for a message a person can act on. */
export function valueForm(v: unknown): string {
  if (typeof v !== "string") return `一个${Array.isArray(v) ? "数组" : typeof v === "object" && v ? "对象" : typeof v}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "一个邮箱";
  if (/^http:\/\//.test(v)) return "一个 http 地址（不是 https）";
  if (/^https:\/\//.test(v)) return "一个带空白的 https 地址";
  return `一段文本「${v.length > 40 ? v.slice(0, 40) + "…" : v}」`;
}

export function describeShape(shape: ReadingShape): string {
  const parts: string[] = [];
  if (shape.regex !== undefined) parts.push(`/${shape.regex}/`);
  if (shape.enum?.length) parts.push(`one of ${shape.enum.map((v) => JSON.stringify(v)).join(" | ")}`);
  return parts.join(" and ");
}

function sameShape(a: ReadingShape, b: ReadingShape): boolean {
  return a.regex === b.regex && JSON.stringify(a.enum ?? null) === JSON.stringify(b.enum ?? null);
}
