/**
 * t-229：**角色间指令的期限，此刻是一句印着好看的话。**
 *
 * 每个人都在 `tell` 上写 `--ack-by 15m`，而那个时刻过去之后什么都不会发生：`overdue` 只认带选项的卡
 * （t-147 之后），`overdue_by_presence` 按在不在场分桶、根本不看期限。qa 15:43 实测 80 条已过期，牌桌报 0。
 * **一个不起作用的期限，教的是所有人忽略期限**——而我们已经为此付过账（pm 46 条、dev 10 条）。
 *
 * 判据 2 我选①：期限对角色间指令也成为一道闸，过期的进一个看得见的桶（`late`）。理由写在 board.ts 那段注释里，
 * 也写进了证据：选②（不再印期限）会把「这件事我要你今天办」这句话从工具里删掉，而队里每天都在用它。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, slimBoard, lateLine, span, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  return { s, put };
}
const boardAt = async (w: { s: MemoryStore }, mins = 0) => board(reduce(await w.s.read(), at(mins), HUMAN), HUMAN, at(mins));

describe("t-229 判据 1、4 · 未 ack 且已过期的角色间指令，有一个看得见的数", () => {
  it("过了期限还没 ack：进桶，带着它晚了多久", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "把 t-1 交了", ack_by: at(-60).toISOString() }, -120);
    const b = await boardAt(w);
    expect(b.late.count).toBe(1);
    expect(b.late.oldest_s).toBe(3600);
    expect(b.late.instructions[0]).toMatchObject({ to: "dev", from: "pm", body: "把 t-1 交了", age_s: 3600 });
  });

  it("四种不算：ack 过的、撤回的、期限还没到的、发给人的", async () => {
    const w = await world();
    const acked = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "已 ack 的", ack_by: at(-60).toISOString() }, -120);
    await w.put({ kind: "ack", actor: "dev", of: acked.id }, -110);
    const gone = await w.put({ kind: "instruction", actor: "pm", to: "qa", body: "要撤回的", ack_by: at(-60).toISOString() }, -120);
    await w.put({ kind: "untell", actor: "pm", of: gone.id, reason: "不做了" }, -100);
    await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "还没到期", ack_by: at(60).toISOString() }, -10);
    await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "给人的，没选项", ack_by: at(-60).toISOString() }, -120);
    const b = await boardAt(w);
    expect(b.late.count, "四条各挡一种，一条都不该进桶").toBe(0);
    expect(b.late.oldest_s).toBeNull();
  });

  it("与 overdue 不重叠：人那张带选项的卡过期算 overdue，不算 late——同一条不许数两遍", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "A 还是 B？", ack_by: at(-30).toISOString(), options: ["A", "B"] }, -120);
    await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "角色间那条", ack_by: at(-30).toISOString() }, -120);
    const b = await boardAt(w);
    expect(b.overdue.map((o) => o.to)).toEqual([HUMAN]);
    expect(b.late.instructions.map((o) => o.to)).toEqual(["dev"]);
  });

  it("最久的在前，`oldest_s` 就是它——80 条全是刚过期，和其中一条已经三天，是两种麻烦", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "刚过期", ack_by: at(-1).toISOString() }, -30);
    await w.put({ kind: "instruction", actor: "pm", to: "qa", body: "很久了", ack_by: at(-60 * 24 * 3).toISOString() }, -60 * 24 * 4);
    const b = await boardAt(w);
    expect(b.late.instructions.map((o) => o.body)).toEqual(["很久了", "刚过期"]);
    expect(b.late.oldest_s).toBe(60 * 60 * 24 * 3);
    expect(lateLine(b.late)).toContain("2 条");
    expect(lateLine(b.late)).toContain(span(b.late.oldest_s! * 1000)!);
  });

  it("瘦身板砍的是名单，不是那两个数——「有几条」与「是哪几条」不是同一个问题", async () => {
    const w = await world();
    for (let i = 0; i < 40; i++) await w.put({ kind: "instruction", actor: "pm", to: "dev", body: `第 ${i} 条要办的事，写长一点好让它占字节`, ack_by: at(-60).toISOString() }, -120);
    const b = await boardAt(w);
    expect(b.late.count).toBe(40);
    const slim = slimBoard(b, 4_000);                       // 小得一定砍到名单
    expect(slim.late.count, "数还在").toBe(40);
    expect(slim.late.oldest_s).toBe(3600);
    expect(slim.late.instructions.length, "名单被砍了").toBeLessThan(40);
    expect(slim.omitted.some((o) => o.startsWith("late.instructions")), "砍了什么要自己说").toBe(true);
  });
});

/**
 * 判据 4 在真日志上量的时候撞见的那一条：**这个桶里有两种东西。** 105 条里 33 条是「事情办了、只差一个 ack」，
 * 72 条是没人动过。混成一个数，读它的人会按最轻的那一种去理解它——那正是本件要修的病换个地方再来一次。
 */
describe("t-229 · 这个桶里的两种：办了没 ack，和没人动过", () => {
  it("办过的那条（引用了它的事件）算在 acted，没动过的算在 untouched，两者之和是总数", async () => {
    const w = await world();
    const done = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "办了但没 ack", ack_by: at(-60).toISOString() }, -120);
    await w.put({ kind: "note", actor: "dev", body: "照做了", refs: [done.id] }, -100);
    await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "没人动过", ack_by: at(-60).toISOString() }, -120);
    const b = await boardAt(w);
    expect(b.late.count).toBe(2);
    expect(b.late.acted).toBe(1);
    expect(b.late.untouched).toBe(1);
    expect(b.late.instructions.find((x) => x.body === "办了但没 ack")!.acted).toBe(true);
    expect(lateLine(b.late)).toContain("1 条没人动过");
    expect(lateLine(b.late)).toContain("1 条事情办了只差一个 ack");
  });
});
