/**
 * t-147: ack 退役。送达由服务从每个角色自己的拉取算出，显式回执只留给带选项的卡。
 *
 * 今晚的病灶：一条指令「送到了没有」以有没有 ack 事件为准，于是 release 一边稳定产出一边挂着 22 条「没确认」，
 * 而真正没人在的角色和它堆在一处——那一堆两件事都说不清。pd 05:40 的口径是：读没读到、动没动，日志里本来就写着
 * （游标和当事人自己的事件），不必回执；人只欠两件——带选项的卡要一个答案，不打算办的写一句「不办：<原因>」。
 *
 * 时间一律相对 now。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, empty, advance, settle, reduce, board, owedNow, owedTo, REACH_STATES, REACH_WORDS, REACH_RULE, DECLINE_PREFIX, type NewEvent, type Event } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  return { s, put };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-147 · 判据 1：读到哪一条了，是从游标算出来的", () => {
  it("拉过就算读到，没拉过就算没读到；同一条指令，有没有 ack 事件都不改变这个值", async () => {
    const w = await world();
    const one = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    const two = await w.put({ kind: "instruction", actor: "pm", to: "qa", body: "验 A", ack_by: at(15).toISOString() }, -60);
    expect((await st(w.s)).instructions.get(one.id)!.reach).toBe("unread");

    // dev 拉到了 one：游标越过它的 id
    await w.s.setCursor({ actor: "dev", last_event_id: one.id, at: at(-50).toISOString() });
    expect((await st(w.s)).instructions.get(one.id)!.reach).toBe("read");
    expect((await st(w.s)).instructions.get(two.id)!.reach).toBe("unread");   // qa 没拉过

    // qa 补一个 ack：它确实动了，所以是「办了」——但那是因为它写了事件，不是因为那事件叫 ack
    await w.put({ kind: "ack", actor: "qa", of: two.id }, -40);
    const s2 = await st(w.s);
    expect(s2.instructions.get(two.id)!.reach).toBe("acted");
    expect(REACH_STATES).toEqual(["unread", "read", "acted"]);
  });

  it("「办了」由当事人自己的事件证明，牌桌把那条事件的 id 一并给出来，读的人可以自己去看", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "认领 t-9", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: i.id, at: at(-50).toISOString() });
    // 一条 note 正文里写下这条指令的 id，就是动过它的证据；不必回执
    const n = await w.put({ kind: "note", actor: "dev", body: `按 ${i.id} 认领了 t-9` }, -40);
    const b = board(await st(w.s), HUMAN, at(0));
    const row = b.instructions.find((x) => x.id === i.id)!;
    expect(row.reach).toBe("acted");
    expect(row.acted_by_event).toBe(n.id);
    expect(REACH_WORDS[row.reach]).toBe("办了");
  });
});

describe("t-147 · 判据 2 与 3：欠的是答案，不是回执", () => {
  it("不带选项的指令过了期限也不算逾期；带选项的卡到期没答案才算", async () => {
    const w = await world();
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(-10).toISOString() }, -60);
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: card.id, at: at(-5).toISOString() });
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    const s = await st(w.s);
    expect(s.instructions.get(plain.id)!.overdue).toBe(false);
    expect(s.instructions.get(card.id)!.overdue).toBe(true);
    const b = board(s, HUMAN, at(0));
    expect(b.overdue.map((o) => o.instruction)).toEqual([card.id]);
  });

  it("同一条不在两处各算一次——而且这不是巧合：带选项只发给人（rules.ts），人不进在场三态，两处按构造就不相交", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    await w.s.setCursor({ actor: "dev", last_event_id: plain.id, at: at(-1).toISOString() });
    const b = board(await st(w.s), HUMAN, at(0));
    const grouped = Object.values(b.overdue_by_presence).flatMap((g) => g.instructions);
    expect(b.overdue.map((o) => o.instruction)).toEqual([card.id]);
    expect(grouped).toEqual([plain.id]);
    expect(grouped.filter((id) => b.overdue.some((o) => o.instruction === id))).toEqual([]);
    // 给角色发带选项的指令，服务当场拒绝——这是「不相交」的出处，不是我们排出来的巧合
    await expect(w.put({ kind: "instruction", actor: "pm", to: "dev", body: "你选一个", options: ["A", "B"], ack_by: at(15).toISOString() }, -1)).rejects.toThrow(/options are for the human/);
  });

  it("一句「不办：<原因>」是答案，卡就此了结；沉默不是答案", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    expect((await st(w.s)).instructions.get(card.id)!.overdue).toBe(true);
    await w.put({ kind: "note", actor: HUMAN, body: `${DECLINE_PREFIX}这一批不该带上它，理由在 t-129 的 note 里`, refs: [card.id] }, -3);
    const s = await st(w.s);
    expect(s.instructions.get(card.id)!.overdue).toBe(false);
    expect(s.instructions.get(card.id)!.chosen).toBeTruthy();
    expect(owedTo(s, HUMAN).map((x) => x.instruction.id)).not.toContain(card.id);
  });
});

describe("t-147 · 判据 4：历史不重算", () => {
  it("已有的 ack 事件原样留在日志里，acked_at 仍在，新口径只作用于显示与判定", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    const a = await w.put({ kind: "ack", actor: "dev", of: i.id }, -50);
    const log = await w.s.read();
    expect(log.events.find((e: Event) => e.id === a.id)).toMatchObject({ kind: "ack", of: i.id, actor: "dev" });
    const s = await st(w.s);
    expect(s.instructions.get(i.id)!.acked_at).toBe(a.at);
    expect(s.instructions.get(i.id)!.reach).toBe("acted");
  });

  it("增量折叠与全量重算给出同一个 reach：新口径可以被 t-128 的增量状态承载", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: i.id, at: at(-50).toISOString() });
    await w.put({ kind: "note", actor: "dev", body: `办完了 ${i.id}` }, -40);
    const inc = settle(advance(empty(), await w.s.read()), at(0));
    const full = await st(w.s);
    expect(inc.instructions.get(i.id)!.reach).toBe(full.instructions.get(i.id)!.reach);
    expect(inc.instructions.get(i.id)!.acted_by_event).toBe(full.instructions.get(i.id)!.acted_by_event);
  });
});

describe("t-147 · 判据 5：新口径在 core 一处有中文说明", () => {
  it("REACH_RULE 说清了两件欠的事和沉默的代价，t-141 的说明书直接引用它，不转述", () => {
    expect(REACH_RULE).toContain("不必回执");
    expect(REACH_RULE).toContain("带选项的卡要一个答案");
    expect(REACH_RULE).toContain(DECLINE_PREFIX);
    expect(REACH_RULE).toContain("沉默不是答案");
  });
});

describe("t-147 · 判据 6：拉取时随手给出「此刻你欠什么」", () => {
  it("角色欠的是「读过还没动」那一类；办了的和别人的都不在里面", async () => {
    const w = await world();
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(15).toISOString() }, -60);
    const done = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "认领 t-9", ack_by: at(15).toISOString() }, -60);
    const other = await w.put({ kind: "instruction", actor: "pm", to: "qa", body: "验 t-9", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: other.id, at: at(-5).toISOString() });
    await w.put({ kind: "note", actor: "dev", body: "认领了", refs: [done.id] }, -4);

    const o = owedNow(await st(w.s), "dev");
    expect(o.untouched.map((x) => x.instruction)).toEqual([plain.id]);
    expect(o.untouched[0]).toMatchObject({ from: "pm", body: "去看一眼 CI" });
    // 带选项只发给人，所以今天角色这一类必然是空的——这是规则的后果，不是这条用例的巧合
    expect(o.unanswered).toEqual([]);
    expect(JSON.stringify(o)).not.toContain(done.id);   // 办了的不欠
    expect(JSON.stringify(o)).not.toContain(other.id);  // 别人的不欠
  });

  it("人拉取时，欠的是那些还没答的卡：同一个字段，两类都用得上", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], default: "B", ack_by: at(10).toISOString() }, -60);
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    const o = owedNow(await st(w.s), HUMAN);
    expect(o.unanswered.map((x) => x.instruction)).toEqual([card.id]);
    expect(o.unanswered[0]).toMatchObject({ from: "pm", options: ["A", "B"], default: "B", overdue: false });
  });
});
