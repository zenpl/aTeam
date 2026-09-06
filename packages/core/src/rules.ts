import { type Event, type NewEvent, INSTRUCTION_MAX_CHARS } from "./events.js";
import { type State, openSeamsFor, passedOn } from "./reduce.js";

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
    case "reading":
      if (!e.key || !e.surface) throw new Rejected("reading", "key and surface are required");
      return;

    // R1: an instruction is short, has one recipient, and a deadline to be acked.
    case "instruction":
      if (!e.to) throw new Rejected("instruction", "to is required");
      if (e.to === e.actor) throw new Rejected("instruction", "cannot instruct yourself");
      if (!e.body?.trim()) throw new Rejected("instruction", "body is required");
      if (e.body.length > INSTRUCTION_MAX_CHARS)
        throw new Rejected("instruction", `body is ${e.body.length} chars; max ${INSTRUCTION_MAX_CHARS}. Put the argument in a note and the action here.`);
      if (!e.ack_by) throw new Rejected("instruction", "ack_by is required");
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

  switch (e.op) {
    case "claim":
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
      if (e.actor === t.criteria_by && e.actor !== human)
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
