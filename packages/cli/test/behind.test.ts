/**
 * t-211：命令行是各人各自 build 的，发车只换服务端——CLI 侧的每一处修复对别人都不生效。
 *
 * 真样本（qa 14:50 自己撞的）：它用早上的构建落了一条带两个 `--refs` 的 note，服务只收到一个，另一个在本机被
 * 吃掉（那份构建不含 t-197）。丢掉的恰好是一条它确实答过的追问——**「我动过」被算成了没动**，而且事后从日志里
 * 查不出来。所以这句提醒要印在每回合都会跑的那条命令上（判据 1），不靠谁记得。
 */
import { describe, it, expect } from "vitest";
import { behindDeploys, cliBehindLine, cliStaleBuildLine, type PullResult } from "@ateam/core";
import { sync, type Behind } from "../src/loop.js";

const DEPLOYS = ["d1", "d2", "d3"];
const behindWith = (mine: string | null, hasList: string[]): Behind => ({
  head: () => mine,
  has: (sha) => hasList.includes(sha),
});
const puller = (deploys?: string[]) => ({
  pull: async (): Promise<PullResult> => ({ events: [], for_me: [], cursor: null, ...(deploys ? { deploys } : {}) }),
});
const cursor = () => { let v: string | null = null; return { read: () => v, write: (x: string | null) => { v = x; } }; };
const run = async (deploys: string[] | undefined, behind: Behind | undefined) => {
  const out: string[] = [];
  await sync(puller(deploys), "dev", cursor(), 0, (l) => out.push(l), behind);
  return out;
};

describe("t-211 判据 1、5 · 旧构建会被当场说出来", () => {
  it("落后两次上线：印出那句，并说得出差几次", async () => {
    const out = await run(DEPLOYS, behindWith("mine", ["d1"]));
    expect(out.some((l) => l === cliBehindLine(2))).toBe(true);
    expect(out.join("\n")).toContain("2");
  });

  it("与生产同版：一个字都不多说（判据 5 的反面）", async () => {
    const out = await run(DEPLOYS, behindWith("mine", DEPLOYS));
    expect(out.join("\n")).not.toContain("比生产旧");
  });
});

describe("t-211 · 说不出就闭嘴，不报平安", () => {
  it("不是 git 检出（head 给 null）：不说", async () => {
    expect((await run(DEPLOYS, behindWith(null, []))).join("\n")).not.toContain("比生产旧");
  });

  it("服务太旧、根本没送这份名单：不说——缺字段是「不知道」，不是「你是最新的」", async () => {
    expect((await run(undefined, behindWith("mine", []))).join("\n")).not.toContain("比生产旧");
    // 这一格今天在真服务上走到过：生产此刻跑的是 c83e986，还没有这个字段，sync 一个字没说
  });

  it("git 答不上来（has 给 null）：整句不说，不拿「答不上来」当「你没有」", async () => {
    const flaky: Behind = { head: () => "mine", has: (sha) => (sha === "d2" ? null : true) };
    expect((await run(DEPLOYS, flaky)).join("\n")).not.toContain("比生产旧");
    expect(behindDeploys("mine", DEPLOYS, flaky.has)).toBeNull();
  });

  it("没人给 behind（老调用方）：sync 照常跑，不崩也不说", async () => {
    expect((await run(DEPLOYS, undefined)).join("\n")).not.toContain("比生产旧");
  });
});

describe("t-211 · 数的是上线次数，不是提交数", () => {
  it("本地含前两次上线、缺最后一次 ⇒ 1", () => {
    expect(behindDeploys("mine", DEPLOYS, (s) => s !== "d3")).toBe(1);
  });

  it("一次上线都没有过：说不出（不是 0）", () => {
    expect(behindDeploys("mine", [], () => true)).toBeNull();
    expect(behindDeploys("mine", undefined, () => true)).toBeNull();
  });
});

describe("t-211 · qa 16:02 找到的两个反过来的结果", () => {
  it("**从不 fetch 的那棵树**：本地根本没有上线那个 sha ⇒ 算「我没有」，照样印出来", async () => {
    // 第一版把「本地没有这个对象」当成说不出，于是最该看到提醒的节点一个字都收不到
    const neverFetched: Behind = { head: () => "mine", has: () => false };
    const out = await run(DEPLOYS, neverFetched);
    expect(out.some((l) => l === cliBehindLine(3))).toBe(true);
  });

  it("**只 git pull 不重编**：HEAD 追上了、dist 还是旧的 ⇒ 另一句话说出来", async () => {
    const pulled: Behind = { head: () => "mine", has: () => true, built: () => false };
    const out = await run(DEPLOYS, pulled);
    expect(out.join("\n")).not.toContain("比生产旧");     // 按 HEAD 算确实不落后了
    expect(out).toContain(cliStaleBuildLine);            // 但跑着的不是这棵树的代码
  });

  it("两样都旧：两句都说，各说各的", async () => {
    const both: Behind = { head: () => "mine", has: (s) => s === "d1", built: () => false };
    const out = await run(DEPLOYS, both);
    expect(out).toContain(cliBehindLine(2));
    expect(out).toContain(cliStaleBuildLine);
  });

  it("dist 说不出（没有产物）：不说——「不知道」不等于「你是新的」", async () => {
    const unknown: Behind = { head: () => "mine", has: () => true, built: () => null };
    expect((await run(DEPLOYS, unknown)).join("\n")).not.toContain("dist");
  });

  it("老调用方没有 built：照旧只判上线那一半，不崩", async () => {
    const out = await run(DEPLOYS, { head: () => "mine", has: () => true });
    expect(out.join("\n")).not.toContain("dist");
  });
});
