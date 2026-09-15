/**
 * t-277：`parse` 说不认得的时候，指得出最接近的那个真名（判据 3、4）。
 *
 * 判据 4 的反面尤其要紧：**判据 2 清单里的每一个真 flag 都不许被这道闸咬到。** 那份清单不是手抄的——
 * 它就是 `allFlagNames()`，与 `known()` 同一份，所以这条用例会随名单一起长。
 */
import { describe, it, expect } from "vitest";
import { parse, allFlagNames, UsageError } from "../src/args.js";

const threw = (argv: string[]): string => {
  try { parse(argv); } catch (e) { if (e instanceof UsageError) return e.message; throw e; }
  throw new Error("expected UsageError");
};

describe("t-277 · 不认得的开关，指名最接近的那个", () => {
  it("正：拼错一个字母 ⇒ 指对，而且不再说「你这支旧了」", () => {
    const m = threw(["task", "create", "t-1", "x", "--critera", "一"]);
    expect(m).toContain("不认得这个开关：--critera");
    expect(m).toContain("你是不是要写 --criteria？");
    expect(m).not.toContain("git pull");
  });

  it("正：`--X=值` 那种写法同样指得对", () => {
    expect(threw(["task", "create", "t-1", "x", "--critera=一"])).toContain("你是不是要写 --criteria？");
  });

  it("正：带空格、带中文的名字 ⇒ 照样拒，只是指不出近的", () => {
    for (const bad of ["带 空格", "完全不存在的东西"]) {
      const m = threw(["task", "create", "t-1", "x", `--${bad}`, "v"]);
      expect(m).toContain(`不认得这个开关：--${bad}`);
      expect(m).not.toContain("你是不是要写");
    }
  });

  it("反：判据 2 清单里的每一个真 flag 都跑得通，一个都没被这道闸咬到", () => {
    const names = allFlagNames();
    expect(names.length, "名单不该是空的，否则下面这条就是空绿").toBeGreaterThan(40);
    for (const n of names) {
      expect(() => parse([`--${n}`, "v"]), `--${n} 被咬了`).not.toThrow();
      expect(() => parse([`--${n}-file`, "/dev/null"]), `--${n}-file 被咬了`).not.toThrow();
    }
  });
});
