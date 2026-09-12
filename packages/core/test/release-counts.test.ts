/**
 * t-221：**只在别人跑命令时才刷新的数，写成「0」时最像真话。**
 *
 * `release.counts` 是某个人某一刻跑 `ateam release` 用 git 逐件测出来的一条事实，**之后没有任何东西会刷新它**。
 * 真样本（pm 的判据 2）：**15:05:01 量的那份让牌桌从 15:05 一直显示 `pending_deploy = 0`，而 release 17:06
 * 重跑得到 6 件**——两小时里「没有东西等着上线」是一句会让人放心的假话。
 *
 * **而 0 是这里面最像真话的那个值**（release 17:06 的原话）：一个陈旧的数写成 0，读起来正好是「都上线了」。
 * 所以这一件把 t-078 那条老规矩推广一格：**算不出就说原因不给数字；算得出但已经旧了，也不许当成此刻的数给出去。**
 */
import { describe, it, expect } from "vitest";
import { Builder, unpackedCount, type Board } from "../src/index.js";

const SHA = "a".repeat(40);

/**
 * 一个刚发过车的项目：t-1 验过、已在生产里，包含事实是**那一刻**测的。
 * `after` 为真时，再让 t-2 在那条事实之后才 done＋验过——**这一件事实答不了**。
 */
async function world(after: boolean): Promise<Board> {
  const b = new Builder({ start: Date.now() - 3 * 3600_000, stepMs: 60_000 });
  await b.reading("pm", "roles", ["pm", "dev", "qa"], { surface: "project" });
  await b.task.create("pm", "t-1", "第一件", ["判据"], { no_human_impact: true });
  await b.task.claim("dev", "t-1", ["a.ts"]);
  await b.task.done("dev", "t-1", { evidence: `${SHA.slice(0, 7)} 完成`, no_human_impact: true });
  await b.task.verify("qa", "t-1", "repo", true, { evidence: "跑过了" });
  await b.reading("release", "deployed.sha", SHA, { surface: "production" });
  // 那一刻跑 ateam release 测出来的包含事实：t-1 在里面
  await b.reading("release", "deployed.tasks", { sha: SHA, contained: ["t-1"], not_contained: [], unmeasured: [], method: "git-ancestor" }, { surface: "production" });
  if (after) {
    await b.task.create("pm", "t-2", "事实之后才做的那一件", ["判据"], { no_human_impact: true });
    await b.task.claim("dev", "t-2", ["b.ts"]);
    await b.task.done("dev", "t-2", { evidence: `${"b".repeat(7)} 完成`, no_human_impact: true });
    await b.task.verify("qa", "t-2", "repo", true, { evidence: "跑过了" });
  }
  return b.board(new Date());
}

describe("t-221 判据 2、3 · 事实答不了此刻的问题时，这几个数不算数", () => {
  it("**事实之后没有新东西**：三个数就是此刻的答案", async () => {
    const b = await world(false);
    expect(b.release.counts_current).toBe(true);
    expect(b.release.counts.pending_deploy).toBe(0);
  });

  it("**复现那一幕**：一件在事实之后才验过 ⇒ `pending_deploy` 仍是 0，而这几个数已经不算数了", async () => {
    const b = await world(true);
    expect(b.release.counts.pending_deploy, "事实自己的数没变——它说的是它测的那一刻").toBe(0);
    expect(b.release.counts_current, "而它答不了此刻的问题").toBe(false);
    expect(b.release.counts.unknown, "那一件落进「说不出」，不是落进 0").toBeGreaterThan(0);
  });

  it("判据 4：**0 与「不知道」分得开**——一个是数，一个不是", async () => {
    const fresh = await world(false), stale = await world(true);
    expect([fresh.release.counts.pending_deploy, fresh.release.counts_current]).toEqual([0, true]);
    expect([stale.release.counts.pending_deploy, stale.release.counts_current]).toEqual([0, false]);
    // 两份的那个数一模一样，**分得开它们的是旁边那一格，不是数本身**
    expect(fresh.release.counts.pending_deploy).toBe(stale.release.counts.pending_deploy);
  });

  it("判据 1：**测量时刻和数放在一起**，不再只活在 basis 那一长串里", async () => {
    const b = await world(true);
    expect(b.release.counts_at, "取的是那条事实自己的时刻").toBeTruthy();
    expect(Date.parse(b.release.counts_at!)).toBeLessThan(Date.parse(b.now));
    expect(b.release.basis, "basis 照旧在，但它不再是唯一说得出时刻的地方").toContain("deployed.tasks");
  });

  it("**同一个病的第二处**：`unpackedCount` 也是从那个数推出来的，说不出就给 null，不拿 0 顶替", async () => {
    expect(unpackedCount(await world(false))).toBe(0);
    expect(unpackedCount(await world(true)), "不知道就是不知道").toBeNull();
  });

  it("一个候选都没有时，三个 0 就是此刻的答案——那时候不许说「不知道」", async () => {
    const b = new Builder({ start: Date.now() - 3600_000, stepMs: 60_000 });
    await b.reading("release", "deployed.sha", SHA, { surface: "production" });
    const board = await b.board(new Date());
    expect(board.release.candidates ?? []).toHaveLength(0);
    expect(board.release.counts_current).toBe(true);
  });
});
