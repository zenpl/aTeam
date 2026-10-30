/**
 * t-290 判据 4：**「还没送到他眼前」与「他看过还没动」是两件事，不许算成一格。**
 *
 * 那一格印出来的话是「你读过还没动的有 N 条」。对一条根本没送到的指令，这句话是假的，而且是最坏的那种假：
 * **它把「我们没送到」说成「你看过了不办」。** 量过（读数 repo:owed.untouched.counts-unseen = yes）：
 * 一条都没送到的合成日志上，8 条指令 `reach` 全是 `unread`，而 `untouched` 仍然是 8。
 *
 * 分桶的依据是 `reach`，而 `reach` 由游标算（`reduce.ts`：`upto >= 它的 id` 才算 read）——所以这里用
 * `setCursor` 造「送到了」，不是用 `recordDelivery`：投递表记的是「我们发过」，游标记的是「它走过它」，
 * 而 `reach` 读的是后者。**第一版我拿 recordDelivery 造，造不出 read，这条注释是那次的收获。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryStore, append, reduce, owedNow, owedFull, capOwed, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-30T06:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);

/** n 条发给 dev 的指令；`readUpto` 条被游标走过（于是算「送到了」）。 */
async function world(n: number, readUpto: number) {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await put({ kind: "instruction", actor: "pm", to: "dev", body: `第 ${i} 条：做一件事`, ack_by: at(-500).toISOString() }, -500 + i)).id);
  if (readUpto > 0) await s.setCursor({ actor: "dev", last_event_id: ids[readUpto - 1], at: at(-100).toISOString() });
  return { s, ids };
}
const st = async (w: Awaited<ReturnType<typeof world>>) => reduce(await w.s.read(), at(0), HUMAN);

describe("t-290 判据 4 · owedNow 把那一格拆成两格", () => {
  it("一条都没走过游标 ⇒ 全在 unseen，untouched 是 0（此前这里是 8）", async () => {
    const w = await world(8, 0);
    const owed = owedNow(await st(w), "dev");
    expect(owed.unseen).toHaveLength(8);
    expect(owed.untouched, "一条都没送到，就没有「你读过还没动」").toHaveLength(0);
  });

  it("游标走过前 5 条 ⇒ 那 5 条是 untouched，其余 3 条是 unseen", async () => {
    const w = await world(8, 5);
    const owed = owedNow(await st(w), "dev");
    expect(owed.untouched).toHaveLength(5);
    expect(owed.unseen).toHaveLength(3);
    expect(owed.untouched.map((x) => x.instruction)).toEqual(w.ids.slice(0, 5));
    expect(owed.unseen.map((x) => x.instruction)).toEqual(w.ids.slice(5));
  });

  it("两格加起来不多不少，一条都没丢（拆桶不是丢桶）", async () => {
    for (const upto of [0, 3, 8]) {
      const w = await world(8, upto);
      const owed = owedNow(await st(w), "dev");
      expect(owed.unseen.length + owed.untouched.length + owed.unanswered.length, `upto=${upto}`).toBe(8);
    }
  });

  it("办了的一条两格都不进（owedTo 本来就滤掉 acted，这里只是钉住它没被拆桶带歪）", async () => {
    const w = await world(3, 3);
    await append(w.s, { kind: "note", actor: "dev", body: "办了", refs: [w.ids[0]] } as NewEvent, { human: HUMAN, now: at(-50) });
    await w.s.setCursor({ actor: "dev", last_event_id: w.ids[2], at: at(-40).toISOString() });
    const owed = owedNow(await st(w), "dev");
    expect(owed.untouched.map((x) => x.instruction), "被引用过的那一条出局").not.toContain(w.ids[0]);
    expect(owed.untouched).toHaveLength(2);
    expect(owed.unseen).toHaveLength(0);
  });

  it("owedFull 与 owedNow 由同一段代码算（t-239 立的那条），两格都对得上", async () => {
    const w = await world(8, 5);
    const s = await st(w);
    const full = owedFull(s, "dev");
    const now = owedNow(s, "dev");
    expect(now.unseen).toEqual(full.unseen);
    expect(now.untouched).toEqual(full.untouched);
  });

  it("capOwed 把新那一格也算进预算；**untouched 在 unseen 之前**，因为 unseen 那几条在 for_me 里还有一份", async () => {
    const w = await world(8, 5);
    const owed = owedNow(await st(w), "dev");
    const tiny = capOwed(owed, 200);
    expect(tiny.more, "200 字节装不下 8 条").toBe(true);
    expect(tiny.untouched.length, "先装 untouched——那是这个节点唯一能知道自己欠着它的地方（t-227）").toBeGreaterThan(0);
    if (tiny.unseen.length) expect(tiny.untouched.length, "装到 unseen 说明 untouched 已经装满").toBe(owed.untouched.length);
    const whole = capOwed(owed, 1_000_000);
    expect(whole.more).toBeUndefined();
    expect(whole.unseen).toHaveLength(3);
    expect(whole.untouched).toHaveLength(5);
  });

  it("判据 4：两个定义写在 core 的注释里，不只在提交信息里", () => {
    const src = readFileSync(new URL("../src/board.ts", import.meta.url), "utf8");
    const owedNowBlock = src.slice(src.indexOf("export interface OwedNow"), src.indexOf("legacy_before_acted_rule_count: number;"));
    expect(owedNowBlock, "unseen 的定义").toContain("还没送到收件人眼前");
    expect(owedNowBlock, "untouched 的定义").toContain("已送到、他看过、还没动");
  });
});
