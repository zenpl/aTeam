/**
 * t-011 on the CLI side: `tell human --option A --option B --default B` parses, and sync/board show
 * the options and, once chosen, the choice next to the instruction.
 */
// ack_by is far in the future on purpose: since t-022 an ask with a default answers itself once ack_by passes on the wall clock.
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, Rejected, type NewEvent, type ClientEvent } from "@ateam/core";
import { parse, list, str } from "../src/args.js";
import * as fmt from "../src/format.js";
import { decide } from "../src/decide.js";
import { sendAll } from "../src/send.js";
import { partsSkipped, partRefused, PART_NAMES, EXIT_PARTIAL } from "@ateam/core";
import { ClientError } from "../src/client.js";

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
    const ask = await emit({ kind: "instruction", actor: "pm", to: HUMAN, body: "auth: A or B?", ack_by: "2099-01-01T00:00:00.000Z", options: ["A", "B"], default: "B" });

    expect(fmt.event(ask, "pm")).toContain("INSTRUCTION → human: auth: A or B?  [ack by 00:00]  options: A | B (default B)");
    let b = board(reduce(await store.read()), HUMAN);
    expect(fmt.board(b, "pm")).toContain("unread    pm → human: auth: A or B?  [A | B; default B]");
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
    const ask = await append_({ kind: "instruction", actor: "pm", to: HUMAN, body: "auth: A or B?", ack_by: "2099-01-01T00:00:00.000Z", options: ["A", "B"], default: "B" });
    const plain = await append_({ kind: "instruction", actor: "pm", to: HUMAN, body: "deploy now", ack_by: "2099-01-01T00:00:00.000Z" });
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
    // t-232：decide 只把两件排好，发是调用方的事——这里走的正是命令行跑的那个公共层
    const parts = await decide(client, ask.id, "B");
    const out: string[] = [];
    const r = await sendAll(parts, async (e) => { const ev = await client.emit(e); return { id: ev.id, line: `${ev.id}  ${ev.kind}` }; }, (l) => out.push(l), () => {});
    expect(r.exit, "两件都成 ⇒ 0").toBe(0);
    expect(parts.map((x) => (x.event as { kind: string }).kind)).toEqual(["ack", "note"]);
    expect(out).toHaveLength(2);
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
    const parts = await decide(client, ask.id, "A");
    expect(parts.map((x) => (x.event as { kind: string }).kind)).toEqual(["note"]);
    await sendAll(parts, async (e) => { const ev = await client.emit(e); return { id: ev.id, line: ev.id }; }, () => {}, () => {});
    expect(emitted.map((e) => e.kind)).toEqual(["note"]);
  });
});

/**
 * t-232 判据 3：**显式中止，不拿异常当控制流。**
 *
 * 「记下决定」靠那次 ack：ack 没落下去还照写决定，牌桌上就成了「他答过了」而没有任何东西证明他看过。
 * 在这之前这件事是靠 `emit` 抛出来中止的——**而异常中止在终端上没有痕迹**：少了一行，与本来就只有一行
 * 长得一模一样。现在 ack 带 `stopOnFail`，停下来那一刻自己说一句。
 */
describe("t-232 · decide 的两件有先后：ack 没成，决定就不发，而且说出来", () => {
  async function world() {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-06T06:00:00Z");
    const append_ = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const ask = await append_({ kind: "instruction", actor: "pm", to: HUMAN, body: "auth: A or B?", ack_by: "2099-01-01T00:00:00.000Z", options: ["A", "B"], default: "B" });
    return { store, ask, client: { board: async () => board(reduce(await store.read()), HUMAN) } };
  }

  it("ack 被拒 ⇒ 决定那条一条都没发，终端上说「后面 1 件没发」，退出码 2", async () => {
    const { ask, client } = await world();
    const parts = await decide(client, ask.id, "B");
    const sent: string[] = [];
    const out: string[] = [], err: string[] = [];
    const r = await sendAll(parts, async (e) => {
      const kind = (e as { kind: string }).kind;
      if (kind === "ack") throw new ClientError(409, { error: "rejected", rule: "ack", message: "already acked" });
      sent.push(kind);
      return { id: "01X", line: "01X" };
    }, (l) => out.push(l), (l) => err.push(l));
    expect(sent, "决定那条一条都没发").toEqual([]);
    expect(out[0]).toBe(partRefused(PART_NAMES.decideAck(ask.id), "REJECTED (ack): already acked"));
    expect(out).toContain(partsSkipped(1));       // **「没发」与「发了没成」都看得见**
    expect(err).toContain(partsSkipped(1));
    expect(r.exit, "全没成 ⇒ 2，不是部分成功").toBe(2);
  });

  it("反过来：决定那条被拒，ack 已经成了 ⇒ 退出码是「部分成功」，不是「全失败」", async () => {
    const { ask, client } = await world();
    const parts = await decide(client, ask.id, "B");
    const out: string[] = [];
    const r = await sendAll(parts, async (e) => {
      if ((e as { kind: string }).kind === "note") throw new ClientError(409, { error: "rejected", rule: "note", message: "nope" });
      return { id: "01A", line: "01A  ack" };
    }, (l) => out.push(l), () => {});
    expect(r.exit).toBe(EXIT_PARTIAL);
    expect(out[0]).toBe("01A  ack");                       // ack 那一件成了，事实留在终端上
    expect(out.some((l) => l === partsSkipped(1)), "最后一件失败没有「后面」可说").toBe(false);
  });
});
