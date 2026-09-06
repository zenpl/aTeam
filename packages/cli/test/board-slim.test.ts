/**
 * t-075: the default board (t-070) drops criteria, evidence, notes, verdict detail and seam overlaps. The CLI must then
 * leave the fragment out or say where the rest is, never print a half sentence or an empty value.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, slimBoard, boardTask, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";
const RESIDUE = [/ at :/, /\(\)/, /：」/, /: *$/m, /=\s*$/m, /\[\]/, /undefined/, /null/];

async function fixture() {
  const store = new MemoryStore();
  let t = Date.now() - 3_600_000;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  await emit({ kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
  await emit({ kind: "reading", actor: "dev", surface: "staging", key: "users", value: 3, valid_until: new Date(t + 1000).toISOString() });
  for (const [id, title] of [["t-a", "登录"], ["t-b", "导出"], ["t-c", "限流"], ["t-d", "日志"]]) {
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["能用", "有测试"] });
  }
  // t-a done first, t-b claims the same file later: a stacked seam
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["src/io.ts"] });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "提交 1234567：两条都过" });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["src/io.ts"] });
  await emit({ kind: "note", actor: "qa", body: "concern: 导出很慢", task: "t-b" });
  // t-c and t-d: same owner on the same file
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-c", touches: ["src/limit.ts"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-d", touches: ["src/limit.ts"] });
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-a", surface: "repo", pass: true, evidence: "测试 14/14" });
  await emit({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["登录", "导出"], default: "登录", ack_by: new Date(t + 3_600_000).toISOString() });
  await emit({ kind: "instruction", actor: "pm", to: "dev", body: "认领 t-c", ack_by: new Date(t + 3_600_000).toISOString() });
  await emit({ kind: "reading", actor: "dev", surface: "staging", key: "users", value: 4 });
  return board(reduce(await store.read()), HUMAN);
}

describe("t-075 · the CLI prints no half sentence from the default board", () => {
  it("board: stacked and same-owner seams read without their overlap; every default-board line is a full-board line or a shorter form of one", async () => {
    const full = await fixture();
    const slim = slimBoard(full);
    expect(slim.seams.some((s) => s.stacked && !s.overlap.length)).toBe(true);
    const fullText = fmt.board(full, "dev"), slimText = fmt.board(slim, "dev");
    expect(fullText).toContain("t-b stacks on t-a (done first) at src/io.ts: merge t-a first");
    expect(slimText).toContain("t-b stacks on t-a (done first): merge t-a first");
    expect(fullText).toContain("t-d + t-c same owner at src/limit.ts: sequential work, land them in order");
    expect(slimText).not.toContain("same owner"); // the slim board drops same-owner seams altogether: nothing to print, so nothing printed
    // a same-owner seam that arrives without its overlap (an older or partial board) still reads whole
    expect(fmt.board({ ...slim, seams: [{ id: "seam:t-c+t-d", tasks: ["t-d", "t-c"], overlap: [], open: false, same_owner: true }] }, "dev")).toContain("t-d + t-c same owner: sequential work, land them in order");
    for (const re of RESIDUE) expect(slimText, String(re)).not.toMatch(re);
    // line by line: what the slim board prints is what the full board prints, minus fragments
    const fullLines = fullText.split("\n");
    for (const line of slimText.split("\n")) {
      const ok = fullLines.includes(line) || fullLines.some((f) => f.startsWith(line.replace(/:.*$/, "")) && f.length >= line.length);
      expect(ok, line).toBe(true);
    }
    // and nothing the human needs is gone: focus, live, needs-human, tasks, presence all survive
    for (const head of ["LIVE", "NEEDS HUMAN", "TASKS", "STACKED", "READINGS", "PRESENCE"]) expect(slimText).toContain(head);
  });

  it("task show on a default-board task says where the rest is instead of printing empty values", async () => {
    const full = await fixture();
    const slim = slimBoard(full);
    const text = fmt.task(boardTask(slim, "t-a")!, slim.seams);
    expect(text).toContain("criteria   (not in the default board; ateam task show t-a has them)");
    expect(text).toContain("evidence   sha 1234567; (not in the default board; ateam task show t-a has it)");
    expect(text).toContain("verifications\n  ✓ repo");
    expect(text).toContain("notes\n  (not in the default board; ateam task show t-a has them)");
    expect(text).toContain("stacked (t-b on t-a, blocks nothing)  with t-b");
    for (const re of RESIDUE) expect(text, String(re)).not.toMatch(re);
    // the full task reads as before
    const fullText = fmt.task(boardTask(full, "t-a")!, full.seams);
    expect(fullText).toContain("  1. 能用");
    expect(fullText).toContain("evidence   提交 1234567：两条都过");
    expect(fullText).toContain("with t-b: src/io.ts");
  });
});
