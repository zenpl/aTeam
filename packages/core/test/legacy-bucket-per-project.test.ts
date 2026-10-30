/**
 * t-290 判据 2、3：**旁桶的起算点由每个项目自己的日志算，一个任务 id 都不认。**
 *
 * 被修掉的形状：起算点原来是「第一批含着 `t-147` 的那一批」。第二个租户的日志里永远不会有这样一批，
 * 于是起算点恒算不出来（`undefined`），而 `owedFull` 据此「一条都不进旁桶」——**他们的全部历史落进活欠账**
 * （读数 repo:owed.legacy.second-tenant = 0；本项目同一时刻是 legacy=5 / untouched=3）。
 *
 * 新口径（pm 07:46 裁 A）：**这个项目第一条 `batch.*` 读数的时刻**，也就是它第一次发车；一条都没有时退回
 * 第一条事件的时刻。下面每一条日志里**都没有任何 `contains` 含本项目任务 id 的批次读数**——那正是判据 3
 * 要求的「第二租户的形状」。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, owedNow, actedRuleLiveAt, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-30T06:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);

/** 第二个租户：`batchAt` 给 null 就是「它一次都没发过车」。 */
async function tenant({ before, after, batchAt }: { before: number; after: number; batchAt: number | null }) {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  for (let i = 0; i < before; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `发车之前的第 ${i} 条`, ack_by: at(-500).toISOString() }, -500 + i);
  // 它自己的批次读数：**contains 里是它自己的任务 id**，与我们的任何 id 无关
  if (batchAt !== null) await put({ kind: "reading", actor: "release", surface: "repo", key: "batch.1", value: { sha: "aaaaaaa", base: "bbbbbbb", contains: ["x-900", "x-901"] } }, batchAt);
  for (let i = 0; i < after; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `发车之后的第 ${i} 条`, ack_by: at(-100).toISOString() }, -200 + i);
  return reduce(await s.read(), at(0), HUMAN);
}

describe("t-290 判据 2、3 · 旁桶起算点按项目算", () => {
  it("判据 3：第二租户的旧指令进旁桶，不再全部落进活欠账", async () => {
    const owed = await owedNow(await tenant({ before: 5, after: 3, batchAt: -400 }), "dev");
    expect(owed.legacy_before_acted_rule_count, "发车之前那 5 条进旁桶（改之前这里是 0）").toBe(5);
    expect(owed.untouched, "发车之后那 3 条才是活欠账").toHaveLength(3);
  });

  it("判据 2：起算点就是它第一条 batch.* 的时刻，不看那一批装了谁", async () => {
    const s = await tenant({ before: 2, after: 2, batchAt: -300 });
    expect(actedRuleLiveAt(s)).toBe(at(-300).toISOString());
  });

  it("判据 2：一条 batch.* 都没有 ⇒ 退回第一条事件的时刻，而不是 undefined", async () => {
    const s = await tenant({ before: 4, after: 0, batchAt: null });
    expect(actedRuleLiveAt(s), "不再返回 undefined").toBe(at(-600).toISOString());
    expect(typeof actedRuleLiveAt(s)).toBe("string");
    const owed = owedNow(s, "dev");
    expect(owed.legacy_before_acted_rule_count, "从没发过车的项目，历史里没有「旧规矩」那一段").toBe(0);
    expect(owed.untouched, "四条都还欠着，一条都没被藏起来").toHaveLength(4);
  });

  it("两批时取最早那一条，不是最后一条——规矩是第一次发车带到的", async () => {
    const s = new MemoryStore();
    const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
    await put({ kind: "reading", actor: "release", surface: "repo", key: "batch.1", value: { sha: "aaaaaaa", base: "b", contains: ["x-1"] } }, -300);
    await put({ kind: "reading", actor: "release", surface: "repo", key: "batch.2", value: { sha: "ccccccc", base: "a", contains: ["x-2"] } }, -100);
    expect(actedRuleLiveAt(reduce(await s.read(), at(0), HUMAN))).toBe(at(-300).toISOString());
  });

  it("日志一条事件都没有时给空串，而空串让一条都不进旁桶——安全的那一头", async () => {
    const s = reduce({ events: [], cursors: [], deliveries: [] }, at(0), HUMAN);
    expect(actedRuleLiveAt(s)).toBe("");
    expect("2026-10-30T06:00:00.000Z" < "", "空串比任何 ISO 时刻都小 ⇒ i.at < since 恒假").toBe(false);
  });
});
