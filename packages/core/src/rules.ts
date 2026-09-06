import { type Event, type NewEvent, type ReadingShape, INSTRUCTION_MAX_CHARS, TITLE_MAX_CHARS, MIGRATION_DONE_KEY, MIGRATION_ASK_TITLE, MIGRATION_OK, INSTRUCTION_INTENTS, PM_ACTOR, PD_ACTOR, SERVICE_ACTOR, SHOWS_MAX_CHARS } from "./events.js";
import { type State, openSeamsFor, passedOn, shapeFor, criteriaAuthors, DEFAULT_DECIDER } from "./reduce.js";

/** t-098: has the human answered 对 on a migration check card? Nothing about finishing the move happens before that. */
export function migrationApproved(s: State): boolean {
  return [...s.instructions.values()].some((st) => st.instruction.actor === SERVICE_ACTOR && st.instruction.body.startsWith(MIGRATION_ASK_TITLE) && st.chosen?.option === MIGRATION_OK && st.chosen.by !== DEFAULT_DECIDER);
}

export class Rejected extends Error {
  constructor(public readonly rule: string, message: string) {
    super(`${rule}: ${message}`);
  }
}

/**
 * The structural rules. They are the product; everything else is storage.
 * Throws Rejected. `state` is the reduction of the log *before* this event.
 */
export function validate(state: State, e: NewEvent, human: string, now: Date = new Date()): void {
  if (!e.actor) throw new Rejected("actor", "actor is required");

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
      // t-098 (M7): "the move is finished" may not be recorded before the human said 对 on the check card. The button is the
      // authorisation to touch the old channel; without it, nothing may claim the move is over.
      if (e.key === MIGRATION_DONE_KEY && !migrationApproved(state)) {
        throw new Rejected("migration", "human 还没在核对卡上点「对」；在他点之前不要动旧渠道，也不能记「迁移完成」");
      }
      // t-089 (M4): a reading carried in from somewhere else says when it was measured there; without that it is a number
      // with no time and nobody can tell what it is worth. It lands expired either way — whoever needs it measures again.
      if (e.from && !e.measured_at) throw new Rejected("reading", "搬进来的事实必须带 measured_at（它在原处是什么时候测的）；缺 measured_at，不写入");
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
      if (!e.ack_by) throw new Rejected("instruction", "ack_by is required");
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
      // R1b: a decision on an instruction names one of its options, and only the recipient or the human decides.
      if (e.decides) {
        const st = state.instructions.get(e.decides.of);
        if (!st) throw new Rejected("decide", `${e.decides.of} is not an instruction`);
        const i = st.instruction;
        if (!i.options?.length) throw new Rejected("decide", `${i.id} carries no options`);
        if (st.withdrawn) throw new Rejected("decide", `${i.id} was taken back by ${st.withdrawn.by} (${st.withdrawn.reason})`);
        if (!i.options.includes(e.decides.option)) throw new Rejected("decide", `"${e.decides.option}" is not one of: ${i.options.join(" | ")}`);
        if (i.to !== e.actor && e.actor !== human) throw new Rejected("decide", `${i.id} is addressed to ${i.to}, not ${e.actor}`);
        // a default that took effect at ack_by may still be overridden; a real decision may not
        if (st.chosen && st.chosen.by !== DEFAULT_DECIDER) throw new Rejected("decide", `${i.id} already decided: ${st.chosen.option} by ${st.chosen.by}`);
        if (!e.decision) throw new Rejected("decide", "a choice is a decision; set decision: true");
      }
      return;

    case "task":
      return validateTask(state, e, human);
  }
}

function validateTask(state: State, e: NewEvent & { kind: "task" }, human: string): void {
  if (e.op === "create") {
    if (state.tasks.has(e.task)) throw new Rejected("task", `${e.task} already exists`);
    if (!e.title?.trim()) throw new Rejected("task", "title is required");
    if (!e.criteria?.length) throw new Rejected("task", "at least one acceptance criterion is required");
    return;
  }
  if (e.op === "seam") {
    const seam = [...state.seams.values()].find(
      (s) => s.tasks.includes(e.tasks[0]) && s.tasks.includes(e.tasks[1]),
    );
    if (!seam) throw new Rejected("seam", `no seam between ${e.tasks[0]} and ${e.tasks[1]}`);
    if (seam.resolution) throw new Rejected("seam", `already resolved by ${seam.resolution.by}`);
    if (!e.resolution?.trim()) throw new Rejected("seam", "resolution is required");
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
    case "done":
      if (e.shows !== undefined && [...e.shows].length > SHOWS_MAX_CHARS) throw new Rejected("done", `shows is ${[...e.shows].length} chars; one sentence, at most ${SHOWS_MAX_CHARS}`);
      if (t.owner !== e.actor) throw new Rejected("done", `${t.id} is owned by ${t.owner ?? "nobody"}`);
      if (t.status !== "working") throw new Rejected("done", `${t.id} is ${t.status}`);
      return;
    // R2: done is a claim; verified is another identity's act, on a named surface, with no open seam.
    // Verified on one surface is not verified on another: a verified task may be verified again on a new surface.
    case "verify": {
      if (e.shows !== undefined && [...e.shows].length > SHOWS_MAX_CHARS) throw new Rejected("verify", `shows is ${[...e.shows].length} chars; one sentence, at most ${SHOWS_MAX_CHARS}`);
      if (t.status !== "done" && t.status !== "verified") throw new Rejected("verify", `${t.id} is ${t.status}, not done`);
      if (!e.surface) throw new Rejected("verify", "name the surface you verified on (repo/staging/production/...)");
      // t-076: a pass on a surface is final for passes; a fail may overturn it, by someone who is neither the owner, a criteria
      // author, nor the one who passed it. Evidence that is merely misworded is not this path: that is an evidence: note.
      if (passedOn(t, e.surface)) {
        if (e.pass) throw new Rejected("verify", `${t.id} already passed on ${e.surface} since it was last done; a pass does not override a pass. To overturn it, verify --fail with what was found`);
        const passer = t.verifications.filter((v) => v.round === t.round && v.surface === e.surface && v.pass).map((v) => v.by).pop();
        if (passer === e.actor) throw new Rejected("verify", `${e.actor} passed ${t.id} on ${e.surface}; the one who passed it cannot overturn it, someone else must`);
        if (!e.evidence?.trim()) throw new Rejected("verify", `overturning a pass on ${e.surface} needs --evidence: what was found that the pass missed`);
      }
      if (e.actor === t.owner) throw new Rejected("verify", "the owner cannot verify their own task");
      if (criteriaAuthors(t).includes(e.actor) && e.actor !== human)
        throw new Rejected("verify", "whoever wrote the criteria cannot judge them met");
      const seams = openSeamsFor(state, t.id);
      if (seams.length)
        throw new Rejected("verify", `unresolved seam ${seams.map((s) => s.id + " [" + s.overlap.join(",") + "]").join(", ")}`);
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
