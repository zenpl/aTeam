import { type Event, type NewEvent, type ReadingShape, INSTRUCTION_MAX_CHARS, PM_ACTOR, PD_ACTOR } from "./events.js";
import { type State, openSeamsFor, passedOn, shapeFor, criteriaAuthors, DEFAULT_DECIDER } from "./reduce.js";

export class Rejected extends Error {
  constructor(public readonly rule: string, message: string) {
    super(`${rule}: ${message}`);
  }
}

/**
 * The structural rules. They are the product; everything else is storage.
 * Throws Rejected. `state` is the reduction of the log *before* this event.
 */
export function validate(state: State, e: NewEvent, human: string): void {
  if (!e.actor) throw new Rejected("actor", "actor is required");

  // R0: you may not build on a reading that is no longer true.
  for (const ref of e.refs ?? []) {
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
      const declared = shapeFor(state, e.surface, e.key);
      if (e.shape) {
        if (e.shape.regex === undefined && !e.shape.enum?.length) throw new Rejected("reading", "a shape needs a regex or a non-empty enum");
        if (e.shape.regex !== undefined) try { new RegExp(e.shape.regex); } catch { throw new Rejected("reading", `shape regex ${JSON.stringify(e.shape.regex)} does not compile`); }
        if (declared && !sameShape(declared, e.shape))
          throw new Rejected("reading", `${e.surface}:${e.key} already has shape ${describeShape(declared)}; a shape is declared once`);
      }
      const shape = e.shape ?? declared;
      if (shape && !matchesShape(shape, e.value))
        throw new Rejected("reading", `${e.surface}:${e.key} = ${JSON.stringify(e.value)} does not match shape ${describeShape(shape)}`);
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
      if (st.instruction.to !== e.actor && e.actor !== human)
        throw new Rejected("ack", `${e.of} is addressed to ${st.instruction.to}, not ${e.actor}`);
      if (st.acked_at) throw new Rejected("ack", `${e.of} already acked at ${st.acked_at}`);
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

  switch (e.op) {
    // R6: a task created on a false premise ends without anyone pretending to do it. Only before work starts
    // (open or blocked), only by whoever owns its scope: the criteria author, pm, or the human.
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
      if (t.owner !== e.actor) throw new Rejected("done", `${t.id} is owned by ${t.owner ?? "nobody"}`);
      if (t.status !== "working") throw new Rejected("done", `${t.id} is ${t.status}`);
      return;
    // R2: done is a claim; verified is another identity's act, on a named surface, with no open seam.
    // Verified on one surface is not verified on another: a verified task may be verified again on a new surface.
    case "verify": {
      if (t.status !== "done" && t.status !== "verified") throw new Rejected("verify", `${t.id} is ${t.status}, not done`);
      if (!e.surface) throw new Rejected("verify", "name the surface you verified on (repo/staging/production/...)");
      if (passedOn(t, e.surface))
        throw new Rejected("verify", `${t.id} already passed on ${e.surface} since it was last done; verify on a surface it has not passed on`);
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

export function describeShape(shape: ReadingShape): string {
  const parts: string[] = [];
  if (shape.regex !== undefined) parts.push(`/${shape.regex}/`);
  if (shape.enum?.length) parts.push(`one of ${shape.enum.map((v) => JSON.stringify(v)).join(" | ")}`);
  return parts.join(" and ");
}

function sameShape(a: ReadingShape, b: ReadingShape): boolean {
  return a.regex === b.regex && JSON.stringify(a.enum ?? null) === JSON.stringify(b.enum ?? null);
}
