/**
 * t-011 on the CLI side: `tell human --option A --option B --default B` parses, and sync/board show
 * the options and, once chosen, the choice next to the instruction.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
import { parse, list, str } from "../src/args.js";
import * as fmt from "../src/format.js";

const HUMAN = "human";

describe("t-011 · options on tell human, choice shown in sync and board", () => {
  it("--option repeats and --default is a plain flag", () => {
    const a = parse(["tell", "human", "auth:", "A", "or", "B?", "--option", "A", "--option", "B", "--default", "B", "--ack-by", "30m"]);
    expect(a._).toEqual(["tell", "human", "auth:", "A", "or", "B?"]);
    expect(list(a, "option")).toEqual(["A", "B"]);
    expect(str(a, "default")).toBe("B");
  });

  it("sync lines carry the options, the decision note names the choice, and the board lists it under DECIDED", async () => {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-06T06:00:00Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const ask = await emit({ kind: "instruction", actor: "pm", to: HUMAN, body: "auth: A or B?", ack_by: "2026-09-06T07:00:00.000Z", options: ["A", "B"], default: "B" });

    expect(fmt.event(ask, "pm")).toContain("INSTRUCTION → human: auth: A or B?  [ack by 07:00]  options: A | B (default B)");
    let b = board(reduce(await store.read()), HUMAN);
    expect(fmt.board(b, "pm")).toContain("pending   pm → human: auth: A or B?  [A | B; default B]");
    expect(fmt.board(b, "pm")).not.toContain("DECIDED");

    await emit({ kind: "ack", actor: HUMAN, of: ask.id });
    const note = await emit({ kind: "note", actor: HUMAN, body: `decision: ${ask.body} -> B`, decision: true, decides: { of: ask.id, option: "B" } });
    expect(fmt.event(note, "pm")).toBe(`06:03 human     DECISION decision: auth: A or B? -> B  (chose "B" for ${ask.id})`);
    b = board(reduce(await store.read()), HUMAN);
    const text = fmt.board(b, "pm");
    expect(text).toContain("DECIDED");
    expect(text).toContain(`pm → human: auth: A or B?  ⇒ B  (human,`);
    expect(text).not.toContain("OPEN INSTRUCTIONS");
  });
});
