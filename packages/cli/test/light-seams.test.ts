/**
 * t-114: a light seam (t-113) says one sentence, and `ateam board` says the same one the page does — pm 01:20:
 * a reader of the CLI and a reader of the board should not see two different pictures of the same thing.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, slimBoard, boardTask, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";

async function fixture() {
  const store = new MemoryStore();
  let t = Date.now() - 3_600_000;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  for (const [id, title] of [["t-a", "接缝"], ["t-b", "读数"], ["t-c", "导出"], ["t-d", "导入"]]) {
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["能用"] , no_human_impact: true});
  }
  // t-a + t-b: both named the symbols they would touch in one file, and named different ones — a light seam.
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["packages/core/test/replay.test.ts#seams"] });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["packages/core/test/replay.test.ts#readings"] });
  // t-c + t-d: neither said which half of the file — still a collision.
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-c", touches: ["src/io.ts"] });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-d", touches: ["src/io.ts"] });
  return board(reduce(await store.read()), HUMAN);
}

describe("t-114 · CLI 与牌桌说同一句", () => {
  it("board prints the light seam in its own group after 等人裁决, in pd's words, and counts it nowhere", async () => {
    const b = await fixture();
    const out = fmt.board(b);
    expect(out).toContain("都动了同一个文件");
    expect(out).toContain("t-b 与 t-a 都动了 packages/core/test/replay.test.ts，各自的符号不相交，验收不挡。");
    // the file, not the two different symbols: printing those would say they met, which is what the sentence denies
    expect(out).not.toContain("replay.test.ts#seams，各自的符号");
    // position: after the group that is waiting on a person (pm 01:21)
    expect(out.indexOf("等人裁决")).toBeGreaterThan(0);
    expect(out.indexOf("等人裁决")).toBeLessThan(out.indexOf("都动了同一个文件"));
    // it is a heads-up, not work: it is not among the open seams and not in the STACKED group either
    expect(b.seams.filter((s) => s.open)).toHaveLength(1);
    const stacked = out.slice(out.indexOf("STACKED") >= 0 ? out.indexOf("STACKED") : out.length);
    expect(stacked).not.toContain("t-a");
  });

  it("task show never calls a light seam OPEN, and says the same sentence as the board", async () => {
    const b = await fixture();
    const light = fmt.task(boardTask(b, "t-a")!, b.seams, []);
    expect(light).toContain("都动了同一个文件");
    expect(light).toContain("都动了 packages/core/test/replay.test.ts，各自的符号不相交，验收不挡。");
    expect(light).not.toContain("OPEN");
    // the seams block does not say "(none)" while listing one
    const seamsBlock = light.slice(light.indexOf("\nseams"), light.indexOf("\nnotes"));
    expect(seamsBlock).not.toContain("(none)");
    expect(seamsBlock).toContain("都动了同一个文件");
    // the same sentence, one source: what the board says about this seam appears verbatim on the task
    const line = fmt.board(b).split("\n").find((l) => l.includes("都动了 packages"))!.trim();
    expect(light).toContain(line);
    // a seam nobody declared symbols for is still OPEN and still says so
    const heavy = fmt.task(boardTask(b, "t-c")!, b.seams, []);
    expect(heavy).toContain("OPEN");
    expect(heavy).not.toContain("都动了同一个文件");
  });

  it("the slim board keeps a light seam's file, so the CLI never prints half a sentence", async () => {
    const b = await fixture();
    const slim = slimBoard(b);
    const out = fmt.board(slim, slim.omitted ?? []);
    expect(out).toContain("都动了 packages/core/test/replay.test.ts，各自的符号不相交，验收不挡。");
    for (const residue of [/都动了 ，/, /都动了 undefined/, /都动了$/m]) expect(out).not.toMatch(residue);
  });
});
