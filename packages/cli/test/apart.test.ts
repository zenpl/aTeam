/**
 * t-292 判据 2（pd 05:33 五）：**落后与分叉拆成两句，判据是「读者读完就知道该做哪一个动作」。**
 *
 * 真样本是 frontend 08:45 自己收到的那一句：生产头 5f6e2b6，我这棵树 6ddb080，sync 说「你手上的命令行比生产旧
 * 2 次上线，跑 git pull && pnpm build」。而两个方向各数一遍是**生产 2 条、我 49 条**——拉一下接不上，直接推
 * 也会被拒。那一句不是说得不够细，是**给了一个做不到的动作**。
 */
import { describe, it, expect } from "vitest";
import { APART_LINES, apartFromLive, apartLine, cliBehindLine, cliStaleBuildLine, type PullResult } from "@ateam/core";
import { sync, type Behind } from "../src/loop.js";

const LIVE = "5f6e2b6ca56cfef2b9869e8f8ee198dd6fe13be0";
const DEPLOYS = ["d1", "d2", LIVE];

const puller = (over: Partial<PullResult> = {}) => ({
  pull: async (): Promise<PullResult> => ({ events: [], for_me: [], cursor: null, deploys: DEPLOYS, sha: LIVE, ...over }),
});
const cursor = () => { let v: string | null = null; return { read: () => v, write: (x: string | null) => { v = x; } }; };
const run = async (behind: Behind | undefined, over: Partial<PullResult> = {}) => {
  const out: string[] = [];
  await sync(puller(over), "frontend", cursor(), 0, (l) => out.push(l), behind);
  return out;
};
/** 一棵树：两个方向各多出几条；`has` 照旧按包含关系答，好让退路那一句在该出现时出现。 */
const tree = (counts: { mine: number; theirs: number } | null, has: string[] = ["d1"]): Behind => ({
  head: () => "mine",
  has: (sha) => has.includes(sha),
  apart: () => counts,
});

describe("t-292 判据 2 · 落后与分叉是两句话", () => {
  it("落后：只说拉一下，不提合并——一句话一个动作", async () => {
    const out = await run(tree({ mine: 0, theirs: 3 }));
    expect(out).toContain(APART_LINES.behind(3));
    const line = out.find((l) => l.includes("旧了"))!;
    expect(line).toContain("拉一下");
    expect(line).not.toContain("并");          // 落后不需要合并
    expect(line).not.toContain("不能直接推");
  });

  it("分叉（08:45 的现场）：说出两边各几条，给的动作是先并一次，不是拉一下", async () => {
    const out = await run(tree({ mine: 49, theirs: 2 }));
    expect(out).toContain(APART_LINES.diverged(49, 2));
    const line = out.find((l) => l.includes("各走了一段"))!;
    expect(line).toContain("49");
    expect(line).toContain("2");
    expect(line).toContain("要先并一次");
    expect(line).not.toContain("拉一下就能接上");   // 这就是那条做不到的动作
  });

  it("**该挡住的那一格**：分叉时，按上线次数算的那句旧话不许再出现", async () => {
    // 名单里我只含 d1，退路那一句会算出「旧 2 次上线，跑 git pull」——那正是 08:45 说出来的那一句。
    const out = await run(tree({ mine: 49, theirs: 2 }));
    expect(out).not.toContain(cliBehindLine(2));
    expect(out.join("\n")).not.toContain("git pull");
  });

  it("**不该挡的那一格**：数不出两个方向时，旧话照旧说——说不出不等于没话说", async () => {
    expect(await run(tree(null))).toContain(cliBehindLine(2));                 // apart 给 null
    expect(await run({ head: () => "mine", has: (s) => s === "d1" })).toContain(cliBehindLine(2));  // 老调用方没有 apart
    expect(await run(tree({ mine: 1, theirs: 1 }), { sha: undefined })).toContain(cliBehindLine(2)); // 服务没报自己在跑哪一版
  });

  it("线上一条都不多：两句都不说（领先与同版都不是毛病）", async () => {
    for (const counts of [{ mine: 0, theirs: 0 }, { mine: 49, theirs: 0 }]) {
      const out = await run(tree(counts, DEPLOYS));
      expect(out.join("\n"), JSON.stringify(counts)).not.toContain("旧了");
      expect(out.join("\n"), JSON.stringify(counts)).not.toContain("各走了一段");
    }
  });

  it("dist 那一句照旧各说各的：它说的是另一件事", async () => {
    const out = await run({ head: () => "mine", has: () => false, built: () => false, apart: () => ({ mine: 49, theirs: 2 }) });
    expect(out).toContain(APART_LINES.diverged(49, 2));
    expect(out).toContain(cliStaleBuildLine);
  });
});

describe("t-292 判据 2 · 分类本身", () => {
  it("两个方向都要数：只看一个方向分不出这两种", () => {
    // 09-13 栽过的那一次：is-ancestor 单向为 false，被读成「分叉」，实际只是落后。
    expect(apartFromLive({ mine: 0, theirs: 7 })).toEqual({ kind: "behind", theirs: 7 });
    expect(apartFromLive({ mine: 1, theirs: 7 })).toEqual({ kind: "diverged", mine: 1, theirs: 7 });
  });

  it("说不出就是 null，不编一个数，也不报平安", () => {
    for (const bad of [null, undefined, { mine: -1, theirs: 2 }, { mine: 1.5, theirs: 2 }, { mine: 1, theirs: Number.NaN }]) {
      expect(apartFromLive(bad as never), JSON.stringify(bad)).toBeNull();
    }
    expect(apartLine(null)).toBeNull();
  });

  it("每一句都只给一个动作（pd 的判据）", () => {
    expect(APART_LINES.behind(3).match(/拉一下|先并一次/g)).toHaveLength(1);
    expect(APART_LINES.diverged(49, 2).match(/拉一下|先并一次/g)).toHaveLength(1);
  });
});
