/**
 * t-263：**那句「你的命令行比生产旧 N 次上线」按上线次数算，不按内容算——生产一回滚，它就叫所有人把自己降级。**
 *
 * 真样本（dev 14:26 自己撞的）：`14:11` release 把生产从 `09256fd` 回滚到 `3e50e5b`（内容与第 20 批
 * `d57acbc` 逐字相同）。`3e50e5b` 是一个**新造的提交对象，谁的功能分支里都不会有**，于是每个在场的人——
 * 不管手上多新——跑 `sync` 都被告知：
 *
 *     你手上的命令行比生产旧 1 次上线，跑 git pull && pnpm build
 *
 * **而照做会把命令行降到 `t-223` 之前。** 这不是一件排队的改进，是一条正在发出的有害建议（pm 15:08）。
 *
 * 这份用例造**真的 git**（一个真的回滚提交：`commit-tree` 出来的、树与旧版逐字相同的新对象），
 * 并且**一律从 `sync` 印出来的那几行上断言**——判据说的是「不许给一条会让人退化的建议」，
 * 那就该在人真正看得到的那一层上判，而不是在一个内部函数的返回值上。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { realBehind } from "../src/release.js";
import { cliBehindLine, type PullResult } from "@ateam/core";
import { sync, type Behind } from "../src/loop.js";

let root = "";
const c: string[] = [];
let rolled = "";
const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "t263-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(root, `f${i}.txt`), String(i));
    git("add", ".");
    git("commit", "-qm", `c${i}`);
    c.push(git("rev-parse", "HEAD").stdout.trim());
  }
  // **真的回滚**：树取 c1、父取 c2——内容与 c1 逐字相同，历史只进不退。这正是 `ateam release --rollback` 造的形状。
  const tree = git("rev-parse", `${c[1]}^{tree}`).stdout.trim();
  rolled = git("commit-tree", tree, "-p", c[2], "-m", "回滚到 c1").stdout.trim();
  git("update-ref", "refs/heads/production", rolled);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const puller = (ds: string[]) => ({ pull: async (): Promise<PullResult> => ({ events: [], for_me: [], cursor: null, deploys: ds }) });
const cursor = () => { let v: string | null = null; return { read: () => v, write: (x: string | null) => { v = x; } }; };
const said = async (ds: string[], b: Behind) => {
  const out: string[] = [];
  await sync(puller(ds), "dev", cursor(), 0, (l) => out.push(l), b);
  return out.join("\n");
};
/** sha 要**懒取**：`describe` 体在 `beforeAll` 之前就跑完了，这时 `c[]` 还是空的。 */
const at = (sha: () => string, run: () => Promise<string>) => async () => {
  expect(git("checkout", "-q", sha()).status, "检出失败就别往下判").toBe(0);
  try { return await run(); } finally { git("checkout", "-q", "main"); }
};

describe("t-263 判据 1、2 · 生产头的内容比我旧时，不许叫我去 pull", () => {
  it("场景成立：回滚产物的树与 c1 逐字相同，我 HEAD 是 c3，两者互不包含", () => {
    expect(git("rev-parse", `${rolled}^{tree}`).stdout.trim()).toBe(git("rev-parse", `${c[1]}^{tree}`).stdout.trim());
    expect(realBehind(root).head()).toBe(c[3]);
    expect(realBehind(root).has(rolled), "它不是我的祖先").toBe(false);
    expect(spawnSync("git", ["merge-base", "--is-ancestor", c[3], rolled], { cwd: root }).status, "我也不是它的祖先").not.toBe(0);
  });

  it("**不说「你旧了」、也不教人 pull**——照做会把命令行降到回滚之前", async () => {
    const out = await said([c[0], c[1], c[2], rolled], realBehind(root));
    expect(out, "未修时这里逐字是「你手上的命令行比生产旧 1 次上线，跑 git pull && pnpm build」").not.toContain("比生产旧");
    expect(out).not.toContain("git pull");
  });
});

describe("t-263 判据 2 · 这道闸不是被关掉了，是问对了问题", () => {
  it("真落后（生产头是我的后代）⇒ 照旧数得出来、照旧教人 pull", at(() => c[1], async () => {
    const out = await said([c[0], c[1], c[2]], realBehind(root));
    expect(out).toContain(cliBehindLine(1));
    return out;
  }));

  it("与生产同版 ⇒ 照旧闭嘴", at(() => c[2], async () => {
    const out = await said([c[0], c[1], c[2]], realBehind(root));
    expect(out).not.toContain("比生产旧");
    return out;
  }));

  it("**从不 fetch 的那棵树**（本地根本没有生产那个对象）⇒ t-211 那条一个字不改，照旧印出来", async () => {
    const stranger = "0".repeat(40);
    expect(realBehind(root).has(stranger), "没有这个对象 ⇒ 我没有它，不是「说不出」").toBe(false);
    const out = await said([c[0], stranger], realBehind(root));
    expect(out, "关系答不出来时退回 t-211 的行为——「不知道」这里只由 has 说了算").toContain(cliBehindLine(1));
  });
});
