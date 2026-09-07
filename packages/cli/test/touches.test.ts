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

  it("没有 diff 的介质退回手工修订：声明的留着，人补的加进去，并说清为什么没算", () => {
    const r = revise(["docs/第三章.md"], null, ["docs/第四章.md"], "这个项目没有 git");
    expect(r.measured).toBe(false);
    expect(r.touches).toEqual(["docs/第三章.md", "docs/第四章.md"]);
    expect(r.lines.join("\n")).toContain("触点没法从 diff 算（这个项目没有 git）。按手工修订：补了 docs/第四章.md");
    // 什么都不补时，沿用声明的，而且说出来
    expect(revise(["docs/第三章.md"], null, [], "没有 claim 起点").lines.join("\n")).toContain("沿用 claim 时声明的");
  });

  it("空白与重复不进最终值", () => {
    const r = revise([" a.ts ", "a.ts", ""], [" a.ts", "b.ts", "  "], ["b.ts", " c#x "], "x");
    expect(r.touches).toEqual(["a.ts", "b.ts", "c#x"]);
  });
});
