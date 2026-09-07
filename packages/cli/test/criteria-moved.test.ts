/**
 * t-166 判据 2：搬走的判据与仍然有效的判据，在 `task show` 与回溯里要一眼分得开。
 *
 * 只读判据、不读 note 的人，正是这条判据要保护的人：他打开 `task show`，看到第 3 条，就去做它——而它已经不属于
 * 这件任务了。所以「分得开」不是排版偏好，是这件事唯一的成品。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, boardTask, movedCriterion, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";
import { trace } from "../src/trace.js";

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
const shown = async (store: MemoryStore, id: string) => {
  const b = board(reduce(await store.read()), HUMAN);
  return fmt.task(boardTask(b, id)!, b.seams, b.omitted);
};

describe("t-166 · 判据 2：task show 上分得开", () => {
  it("标之前，第 3 条与前两条长得一模一样——这正是今晚出事的样子", async () => {
    const { store } = await fixture();
    const text = await shown(store, "t-141");
    expect(text).toContain("  3. 已经搬到 t-148 的那条");
    expect(text).not.toContain("t-148，这件不再据它验收");
  });

  it("标之后：原文仍在（不是删除），但带上记号与承接方", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-141", moved: { index: 3, to: "t-148" } });
    const text = await shown(store, "t-141");
    expect(text).toContain("已经搬到 t-148 的那条");                    // 原文一字不动
    expect(text).toContain(`3.→`);                                      // 序号上的记号
    expect(text).toContain(movedCriterion("t-148"));                    // 承接方，整句来自 core
    // 没被标的那两条不带任何记号：闸只标该标的，否则记号等于没有
    for (const line of text.split("\n").filter((l) => /^ {2}[12]\./.test(l))) {
      expect(line).not.toContain("→");
      expect(line).not.toContain("不再据它验收");
    }
  });

  it("回溯里也看得见：只走 trace 的人同样不会停在那一条上", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-141", moved: { index: 3, to: "t-148" } });
    const text = trace((await store.read()).events, "t-141", HUMAN).join("\n");
    expect(text).toContain("判据 3");
    expect(text).toContain("t-148");
    expect(text).toContain("不再据它验收");
  });

  it("追加与搬迁是两句不同的话，回溯里不混", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-141", add: ["后来加的一条"] });
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-141", moved: { index: 3, to: "t-148" } });
    const text = trace((await store.read()).events, "t-141", HUMAN).join("\n");
    expect(text).toContain("追加判据：「后来加的一条」");
    expect(text).toContain("标注：判据 3");
  });
});
