/**
 * t-166 判据 2 的另一半：牌桌上的任务页。命令行那一份在 packages/cli/test/criteria-moved.test.ts。
 * 人看的是这一页；「搬走了」如果只在命令行里看得见，判据 2 保护不到读页面的人。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, reduce, board, append, MOVED_MARK, type NewEvent } from "@ateam/core";
import { renderTask, esc } from "../src/html.js";

const HUMAN = "human";

async function fixture() {
  const store = new MemoryStore();
  let t = Date.parse("2026-09-06T06:00:00Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-141", title: "旧件",
    criteria: ["还归这件的一条", "也还归这件", "已经搬到 t-148 的那条"], no_human_impact: true });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-148", title: "接手的那件", criteria: ["接过来"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-141", touches: ["x"] });
  return { store, emit };
}
const pageOf = async (store: MemoryStore, id: string) => {
  const state = reduce(await store.read());
  return renderTask(board(state, HUMAN), state, id, { sha: "abc1234", human: HUMAN, base: "" })!;
};
/** 取出这一页上的判据列表，只看 <li>，免得别处出现的同一个任务 id 混进来 */
const items = (html: string) => [...html.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]).filter((li) => /归这件|搬到 t-148/.test(li));

describe("t-166 · 判据 2：牌桌的任务页上分得开", () => {
  it("标之前：三条判据长得一样，页面上没有任何「搬走了」的痕迹", async () => {
    const { store } = await fixture();
    const html = await pageOf(store, "t-141");
    expect(html).toContain("已经搬到 t-148 的那条");
    expect(items(html).some((li) => li.includes("moved"))).toBe(false);
    expect(items(html).some((li) => li.includes(MOVED_MARK))).toBe(false);
  });

  it("标之后：那一条仍然列着（原文不动），但带上 class 与承接方那句话", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-141", moved: { index: 3, to: "t-148" } });
    const html = await pageOf(store, "t-141");
    const li = items(html);
    expect(li).toHaveLength(3);                                        // 还是三条：标注不是删除
    const moved = li.filter((x) => x.includes('class="moved"'));
    expect(moved).toHaveLength(1);                                     // 只有被标的那一条带 class
    expect(moved[0]).toContain("已经搬到 t-148 的那条");                 // 原文一字不动
    expect(moved[0]).toContain(`${MOVED_MARK} t-148`);                   // 记号 + 承接方，与命令行同一个记号
    // 冻结开着：这一条上不许多出汉字，分得开靠 CSS（淡化 + 删除线）与记号，不靠新话
    const han = (x: string) => (x.match(/[\u4e00-\u9fff]/g) ?? []).length;
    expect(han(moved[0])).toBe(han("已经搬到 t-148 的那条"));
    // 样式表里那条规则也要真的在，否则 class 只是个看不见的记号
    expect(html).toContain("ol.criteria li.moved");
  });

  it("承接方的任务 id 是转义过的，和页面上别处一样", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-<x>", title: "尖括号", criteria: ["a"], no_human_impact: true });
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-141", moved: { index: 3, to: "t-<x>" } });
    const html = await pageOf(store, "t-141");
    expect(html).toContain("t-&lt;x&gt;");
    expect(html).not.toContain("t-<x>，");
  });
});
