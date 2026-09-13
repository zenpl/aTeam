/**
 * t-221 判据 1、3、4：**那几个数旧了，人那一页就不给数。**
 *
 * 真样本：15:05:01 量的那份包含事实让牌桌从 15:05 一直显示 `pending_deploy = 0`，而 release 17:06 重跑得到 6 件。
 * **两小时里「没有东西等着上线」是一句会让人放心的假话**，而它的形态正是「一行字都不出现」——0 件时这一行本来
 * 就该消失，于是**陈旧与真没有长得一模一样**。
 */
import { describe, it, expect } from "vitest";
import { Builder, type Board } from "@ateam/core";
import { waitingLine } from "../src/html.js";

const SHA = "a".repeat(40);

async function world(after: boolean): Promise<Board> {
  const b = new Builder({ start: Date.now() - 3 * 3600_000, stepMs: 60_000 });
  await b.reading("pm", "roles", ["pm", "dev", "qa"], { surface: "project" });
  await b.task.create("pm", "t-1", "第一件", ["判据"], { no_human_impact: true });
  await b.task.claim("dev", "t-1", ["a.ts"]);
  await b.task.done("dev", "t-1", { evidence: `${SHA.slice(0, 7)} 完成`, no_human_impact: true });
  await b.task.verify("qa", "t-1", "repo", true, { evidence: "跑过了" });
  await b.reading("release", "deployed.sha", SHA, { surface: "production" });
  // 这条事实把 t-1 判成「还没进生产」，所以 pending_deploy 是 1——**这一格才分得出改动前后**：
  // 0 件那一格在改动之前就已经被既有的「unknown > 0」那一支接住了（我核过），它不是这次修的那一半。
  await b.reading("release", "deployed.tasks", { sha: SHA, contained: [], not_contained: ["t-1"], unmeasured: [], method: "git-ancestor" }, { surface: "production" });
  if (after) {
    await b.task.create("pm", "t-2", "事实之后才做的那一件", ["判据"], { no_human_impact: true });
    await b.task.claim("dev", "t-2", ["b.ts"]);
    await b.task.done("dev", "t-2", { evidence: `${"b".repeat(7)} 完成`, no_human_impact: true });
    await b.task.verify("qa", "t-2", "repo", true, { evidence: "跑过了" });
  }
  return b.board(new Date());
}

describe("t-221 · 人那一页：陈旧的 0 不再长得像「都上线了」", () => {
  it("事实还答得了时，照旧把数说出来（这一条没变）", async () => {
    const line = waitingLine(await world(false));
    expect(line).toContain("1 件验过了，等一次上线");
  });

  it("**事实答不了时，那个数一个字都不给**：只说不知道，加它的依据", async () => {
    const line = waitingLine(await world(true));
    expect(line, "旧的数不许被当成此刻的答案").not.toContain("1 件验过了");
    expect(line).toContain("不知道有多少件在等上线");
    expect(line, "依据里说得出是哪条事实、对哪个 sha、测于何时").toContain("deployed.tasks");
  });

  it("判据 4：两份的 `pending_deploy` 是同一个数，而人读到的那一行不一样", async () => {
    const [fresh, stale] = [await world(false), await world(true)];
    expect(fresh.release.counts.pending_deploy).toBe(stale.release.counts.pending_deploy);
    expect(waitingLine(fresh)).not.toBe(waitingLine(stale));
  });
});
