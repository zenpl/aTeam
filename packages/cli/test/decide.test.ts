/**
 * t-011 on the CLI side: `tell human --option A --option B --default B` parses, and sync/board show
 * the options and, once chosen, the choice next to the instruction.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, Rejected, type NewEvent, type ClientEvent } from "@ateam/core";
import { parse, list, str } from "../src/args.js";
import * as fmt from "../src/format.js";
import { decide } from "../src/decide.js";

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

describe("t-014 · ateam decide validates before it acks", () => {
  async function world() {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-06T06:00:00Z");
    const append_ = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const ask = await append_({ kind: "instruction", actor: "pm", to: HUMAN, body: "auth: A or B?", ack_by: "2026-09-06T07:00:00.000Z", options: ["A", "B"], default: "B" });
    const plain = await append_({ kind: "instruction", actor: "pm", to: HUMAN, body: "deploy now", ack_by: "2026-09-06T07:00:00.000Z" });
    const emitted: NewEvent[] = [];
    const client = {
      board: async () => board(reduce(await store.read()), HUMAN),
      emit: async (e: ClientEvent) => { const ne = { ...e, actor: HUMAN } as NewEvent; emitted.push(ne); return append_(ne); },
    };
    return { store, ask, plain, client, emitted };
  }
  const rejected = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof Rejected) return e; throw e; } throw new Error("expected Rejected"); };

  it("a bad option is rejected naming the valid ones and emits nothing; the instruction stays open", async () => {
    const { store, ask, client, emitted } = await world();
    const err = await rejected(decide(client, ask.id, "maybe"));
    expect(err.rule).toBe("decide");
    expect(err.message).toContain("A | B");
    expect(emitted).toEqual([]);
    const b = board(reduce(await store.read()), HUMAN);
    expect(b.instructions.find((i) => i.id === ask.id)!.status).toBe("pending");
    expect(b.needs_human.map((n) => n.id)).toContain(ask.id);
  });

  it("an unknown id or an instruction without options emits nothing either", async () => {
    const { plain, client, emitted } = await world();
    expect((await rejected(decide(client, "01NOPE", "A"))).message).toContain("not an instruction");
    expect((await rejected(decide(client, plain.id, "A"))).message).toContain("carries no options");
    expect(emitted).toEqual([]);
  });

  it("a good option acks then records the decision; a second decide is rejected and emits nothing", async () => {
    const { store, ask, client, emitted } = await world();
    const events = await decide(client, ask.id, "B");
    expect(events.map((e) => e.kind)).toEqual(["ack", "note"]);
    expect(emitted).toMatchObject([{ kind: "ack", of: ask.id }, { kind: "note", decision: true, decides: { of: ask.id, option: "B" }, body: "decision: auth: A or B? -> B" }]);
    let b = board(reduce(await store.read()), HUMAN);
    expect(b.instructions.find((i) => i.id === ask.id)).toMatchObject({ status: "acked", chosen: { option: "B", by: HUMAN } });

    const before = emitted.length;
    expect((await rejected(decide(client, ask.id, "A"))).message).toContain("already decided");
    expect(emitted.length).toBe(before);
    b = board(reduce(await store.read()), HUMAN);
    expect(b.instructions.find((i) => i.id === ask.id)!.chosen!.option).toBe("B");
  });

  it("an instruction already acked by hand is not acked again, only decided", async () => {
    const { store, ask, client, emitted } = await world();
    await append(store, { kind: "ack", actor: HUMAN, of: ask.id }, { human: HUMAN });
    const events = await decide(client, ask.id, "A");
    expect(events.map((e) => e.kind)).toEqual(["note"]);
    expect(emitted.map((e) => e.kind)).toEqual(["note"]);
  });
});
