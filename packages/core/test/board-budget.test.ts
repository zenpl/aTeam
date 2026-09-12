/**
 * t-070 判据 3：**给 agent 的那一份有一个绝对上限，不是一个比例。**
 *
 * 这件的标题是「board JSON 不随日志无限增长」，而它此前做到的是**一个常数倍的缩小**：日志 1,571 条时瘦身板
 * 58.6KB，8,600 多条时 **397,640 字节**——判据字面一直是「小于 60KB」，超它 6.5 倍，而用例全绿，因为 pm 21:32
 * 曾把判据改成「默认板 < 完整板 12%」。它 17:49 自己把那次更正作废，理由是：**完整板随日志无限长，无上限的
 * 12% 仍然无上限**。
 *
 * 这一份守的是砍法本身：**上限是给定的，砍谁不是随便砍的，砍了多少看得见**。用例里给一个小上限，是因为要测的是
 * 「装不下的时候它怎么办」——生产那一档的真数另有读数。
 */
import { describe, it, expect } from "vitest";
import { Builder, slimBoard, BOARD_BYTES, omittedPaths, type Board } from "../src/index.js";

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** 一天的形状：几十件任务各带长正文，一百多条指令，几十条读数，若干接缝。 */
async function aDay(): Promise<Board> {
  const b = new Builder({ start: Date.now() - 6 * 3600_000, stepMs: 10_000 });
  const long = (n: number, s: string) => Array.from({ length: n }, (_, i) => `${s} ${i} ${"判据正文很长，说明人能看到什么".repeat(4)}`);
  await b.reading("pm", "roles", ["pm", "dev", "qa", "frontend"], { surface: "project" });
  for (let i = 0; i < 30; i++) {
    const id = `t-${String(i).padStart(3, "0")}`;
    await b.task.create("pm", id, `任务 ${i}`, long(3, "判据"), { no_human_impact: true });
    const owner = i % 2 ? "dev" : "frontend";
    await b.task.claim(owner, id, [`packages/x/${i}.ts`, ...(i % 7 === 0 ? ["packages/server/src/app.ts"] : [])]);
    await b.task.done(owner, id, { evidence: `${(1000000 + i).toString(16)}abcd：${"证据正文".repeat(20)}`, shows: "人能看到的一句话" });
    if (i < 24) await b.task.verify("qa", id, "repo", true, { evidence: "跑过了" });
  }
  for (let i = 0; i < 120; i++) {
    await b.tell("pm", ["dev", "qa", "frontend"][i % 3], `第 ${i} 条：${"请你去做这件事".repeat(6)}`, { ackByMs: 3600_000 });
    await b.reading("qa", `k${i}`, { n: i, note: "量出来的".repeat(8) }, { surface: "repo" });
  }
  return b.board(new Date());
}

describe("t-070 判据 3 · 装不下的时候，砍谁、砍多少、看不看得见", () => {
  it("**上限是绝对的**：同一份输入，给多小的预算就压到多小以内", async () => {
    const full = await aDay();
    for (const limit of [60_000, 20_000, 8_000]) {
      const slim = slimBoard(full, limit);
      expect(bytes(slim), `预算 ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("BOARD_BYTES 是写死的 60 KiB，判据的字面就是这个数", () => {
    expect(BOARD_BYTES).toBe(61_440);
  });

  it("**砍了多少看得见**：每张被砍短的名单都在 omitted 里报出「少了几条、原来几条」", async () => {
    const full = await aDay();
    const slim = slimBoard(full, 8_000);
    const cut = slim.omitted.filter((p) => / of \d+\]/.test(p));
    expect(cut.length, "砍了却不说，正是这道闸要防的那一族").toBeGreaterThan(0);
    expect(slim.omitted, "omitted 是算出来的，不是手写的").toEqual(omittedPaths(full, slim));
  });

  it("**先砍历史，后砍此刻要用的**：终态任务砍光了，才轮到还挂着的指令", async () => {
    const full = await aDay();
    // 给一个刚好要动第 1 层、还动不到第 2 层的预算：从「一条不砍」往下试，找到第一个砍了东西的档
    const roomy = slimBoard(full, 10_000_000);
    const verifiedFull = (roomy.tasks.verified ?? []).length;
    expect(verifiedFull, "样本里本来就有一批终态任务").toBeGreaterThan(5);
    let last = roomy;
    for (const limit of [60_000, 40_000, 30_000]) {
      const slim = slimBoard(full, limit);
      const verified = (slim.tasks.verified ?? []).length;
      const instructions = slim.instructions.length;
      // 只要终态任务还没砍光，指令就不该先掉
      if (verified > 1) expect(instructions, `预算 ${limit}：历史还在，指令不该先被砍`).toBe(last.instructions.length);
      last = slim;
    }
  });

  it("**第 2 层按份额平分，不是谁大砍谁**：指令与读数都还剩下东西，不会一张只剩一条而另一张一条没动", async () => {
    const full = await aDay();
    const slim = slimBoard(full, 12_000);
    expect(slim.instructions.length, "指令没被砍到只剩一条").toBeGreaterThan(1);
    expect(slim.readings.length, "读数也没被砍光").toBeGreaterThan(1);
  });

  it("**一条都不砍的那几样**：needs_human、focus、在途与待办的任务、开着的接缝", async () => {
    const full = await aDay();
    const roomy = slimBoard(full, 10_000_000);
    const tight = slimBoard(full, 6_000);
    expect(tight.needs_human).toEqual(roomy.needs_human);
    expect(tight.focus).toEqual(roomy.focus);
    expect((tight.tasks.open ?? []).length).toBe((roomy.tasks.open ?? []).length);
    expect((tight.tasks.working ?? []).length).toBe((roomy.tasks.working ?? []).length);
    expect(tight.seams.filter((x) => x.open).length).toBe(roomy.seams.filter((x) => x.open).length);
  });

  it("装得下的时候一刀不砍：小日志的瘦身板与不给预算时逐字段相同", async () => {
    const b = new Builder({ start: Date.now() - 3600_000, stepMs: 10_000 });
    await b.task.create("pm", "t-1", "一件小事", ["判据"], { no_human_impact: true });
    const small = await b.board(new Date());
    expect(slimBoard(small, BOARD_BYTES)).toEqual(slimBoard(small, 10_000_000));
  });
});
