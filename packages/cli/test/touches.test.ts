/**
 * t-105, project layer. pd 00:09 的边界：平台只规定「done 的 touches 是最终值」，怎么算由项目档案说。本项目有 git，
 * 从分支相对 claim 起点的 diff 算；没有 diff 的介质退回手工修订，那条退化路径是一等公民，不是「以后再说」。
 */
import { describe, it, expect } from "vitest";
import { revise } from "../src/touches.js";

const DECLARED = ["packages/cli/src/watch.ts", "packages/cli/src/heartbeat.ts", "packages/cli/src/index.ts", "packages/cli/src/format.ts"];
const ACTUAL = ["packages/cli/src/deaf.ts", "packages/cli/src/lock.ts", "packages/cli/src/main.ts", "packages/cli/test/deaf.test.ts"];

describe("t-105 · what a task actually touched, measured", () => {
  it("今天 dev 那次四个文件全猜错：算出来的取代声明的，两边的差都看得见", () => {
    const r = revise(DECLARED, ACTUAL, [], "相对 claim 起点 3654136");
    expect(r.measured).toBe(true);
    expect(r.touches).toEqual(ACTUAL);                                  // 最终值是事实，不是并集
    const text = r.lines.join("\n");
    expect(text).toContain("相对 claim 起点 3654136");
    expect(text).toContain("claim 时没声明、实际改了：packages/cli/src/deaf.ts、packages/cli/src/lock.ts、packages/cli/src/main.ts、packages/cli/test/deaf.test.ts");
    expect(text).toContain("claim 时声明了、实际没改：packages/cli/src/watch.ts、packages/cli/src/heartbeat.ts、packages/cli/src/index.ts、packages/cli/src/format.ts");
  });

  it("diff 看不见的东西不会被算掉：符号、字段、接口名保留，人补的也进去", () => {
    const declared = ["packages/core/src/rules.ts", "packages/core/src/rules.ts#whoCanVerify", "GET /health", "deployed.sha"];
    const r = revise(declared, ["packages/core/src/rules.ts", "packages/core/src/board.ts"], ["packages/core/src/board.ts#projectRoles"], "相对 claim 起点 abc1234");
    expect(r.touches).toEqual([
      "packages/core/src/rules.ts", "packages/core/src/board.ts",
      "packages/core/src/rules.ts#whoCanVerify", "GET /health", "deployed.sha",
      "packages/core/src/board.ts#projectRoles",
    ]);
    expect(r.lines.join("\n")).toContain("diff 看不见、保留声明的：packages/core/src/rules.ts#whoCanVerify、GET /health、deployed.sha");
    expect(r.lines.join("\n")).toContain("你补的：packages/core/src/board.ts#projectRoles");
  });

  it("算出来的与声明一致时也说一句，人不必自己比对", () => {
    const r = revise(["a.ts", "b.ts"], ["b.ts", "a.ts"], [], "相对 claim 起点 abc1234");
    expect(r.touches).toEqual(["b.ts", "a.ts"]);
    expect(r.lines.join("\n")).toContain("与 claim 时声明的一致");
  });

  it("量不出来的介质：人写的就是事实，覆盖 claim 时那份（pd 00:23 定的说法）", () => {
    const r = revise(["docs/第三章.md", "docs/第五章.md"], null, ["docs/第三章.md", "docs/第四章.md"], "这个项目没有 git");
    expect(r.measured).toBe(false);
    expect(r.touches).toEqual(["docs/第三章.md", "docs/第四章.md"]);      // 覆盖，不是并集
    const text = r.lines.join("\n");
    expect(text).toContain("触点没法量（这个项目没有 git）");
    expect(text).toContain("按你写的实际碰到的算，覆盖 claim 时那份：docs/第三章.md、docs/第四章.md");
    expect(text).toContain("claim 时声明了、这次没写：docs/第五章.md");
    // 什么都不写时，沿用声明的那份，而且说出来——那是一个选择，不是遗漏
    const kept = revise(["docs/第三章.md"], null, [], "没记下 claim 起点");
    expect(kept.touches).toEqual(["docs/第三章.md"]);
    expect(kept.lines.join("\n")).toContain("你没写 --touches，沿用 claim 时声明的那份");
  });

  it("空白与重复不进最终值", () => {
    const r = revise([" a.ts ", "a.ts", ""], [" a.ts", "b.ts", "  "], ["b.ts", " c#x "], "x");
    expect(r.touches).toEqual(["a.ts", "b.ts", "c#x"]);
  });
});

/**
 * qa 00:29 验 t-105 时找到的两处：跟着这条规则自己给出的出路走一遍，触点就不再是事实了。
 * ① 出路第一步是「再 claim 一次把触点并进来」，而 claim 每次都重写量点，此后 diff 恒为空；
 * ② 量出 0 个文件时 CLI 说「改成 0 个」、落库却是声明的七条——说的和记的对不上。
 */
describe("t-105 · 走一遍出路之后，触点还得是事实（qa 00:29）", () => {
  it("量出 0 个改动时不悄悄抹掉声明，也不谎称改成了 0 条", () => {
    const r = revise(["a/x.ts", "a/y.ts"], [], [], "相对 claim 起点 4247d7d");
    expect(r.touches).toBeUndefined();                                  // 什么都不发，声明原样留着
    const text = r.lines.join("\n");
    expect(text).toContain("量出 0 个改动文件（相对 claim 起点 4247d7d）：先不改触点，沿用 claim 时声明的 2 条");
    expect(text).toContain("--touches");                                // 说出两条出路
    expect(text).not.toContain("改成 0 个文件");                         // 不再说一句与记录不符的话
  });

  it("量出 0 个但人自己写了实际碰到的：以人写的为准", () => {
    const r = revise(["a/x.ts"], [], ["a/z.ts"], "相对 claim 起点 4247d7d");
    expect(r.touches).toEqual(["a/z.ts"]);
  });

  it("真的什么都没碰、声明也是空的：照常走，不特殊对待", () => {
    expect(revise([], [], [], "x").touches).toEqual([]);
  });
});

/**
 * A diff measures a branch, not a task. One branch carrying three tasks in a row measures all three every time, and
 * no amount of measuring tells them apart — so when the person knows and the measurement cannot, they say so.
 */
describe("t-105 · --touches-only：我写的这几条就是全部", () => {
  it("replaces everything, says what the declaration had that this does not, and never claims to have measured", () => {
    const r = revise(["a/x.ts", "a/y.ts", "GET /health"], ["a/x.ts", "b/other-task.ts"], ["a/x.ts", "a/x.ts#f"], "相对 claim 起点 abc1234", true);
    expect(r.touches).toEqual(["a/x.ts", "a/x.ts#f"]);          // 量出来的 b/other-task.ts 不作数
    expect(r.measured).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("触点按你写的这 2 条算，量出来的不作数（--touches-only）");
    expect(text).toContain("claim 时声明了、这次没写：a/y.ts、GET /health");
  });
});
