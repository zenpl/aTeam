/**
 * t-140 (pd 06:23): the two sentences a node is shown about what it still owes — an answer to a card, and an action
 * on everything else. They exist because under the model of 05:39 those are different debts with different ways out,
 * and the second sentence must always carry both exits: silence is no longer an answer, and a refusal is information.
 */
import { describe, it, expect } from "vitest";
import { owedLines } from "../src/board.js";

const now = new Date("2026-09-07T06:30:00.000Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();

describe("t-140 · 欠的两件事，两句话", () => {
  it("says nothing at all when nothing is owed", () => {
    expect(owedLines([], now)).toEqual([]);
  });

  it("separates a card waiting for an answer from work waiting to be done", () => {
    const lines = owedLines([
      { id: "a", at: ago(12), body: "先上哪个？两个都行。", options: ["报表", "导出"] },
      { id: "b", at: ago(40), body: "把灰字改成读 core 那句。细节在 note 里。" },
    ], now);
    expect(lines).toHaveLength(2);
    // splitTitle drops the delimiter, the same first sentence a card shows on the board
    expect(lines[0]).toBe("有 1 条在等你答，最久的 12 分钟：先上哪个");
    expect(lines[1]).toBe("你读过还没动的有 1 条，最久 40 分钟：把灰字改成读 core 那句。办了它，或者写一句「不办：原因」。");
  });

  it("keeps both ways out in the second sentence — a line offering neither reads as nagging", () => {
    const [line] = owedLines([{ id: "a", at: ago(5), body: "做这个" }], now);
    expect(line).toContain("办了它");
    expect(line).toContain("不办：原因");
  });

  it("counts from the oldest of each kind, not the newest", () => {
    const lines = owedLines([
      { id: "a", at: ago(3), body: "新的", options: ["好"] },
      { id: "b", at: ago(90), body: "旧的", options: ["好"] },
    ], now);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 条");
    expect(lines[0]).toContain("90 分钟");
    expect(lines[0]).toContain("旧的");
  });
});
