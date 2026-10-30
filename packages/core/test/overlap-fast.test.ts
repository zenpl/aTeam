/**
 * t-250 ①：`overlapOf` 从「两两比对」换成「三个集合各问一次」。
 *
 * **换实现最怕的是换了语义**，所以这一份不写「我认为它该返回什么」，而是**拿定义去对拍**：
 * `touchesOverlap` 仍然是定义（一个字没改），这里用它现算一份朴素答案，与 `overlapOf` 逐条比。
 * 输入既有手写的边角，也有穷举生成的几千对——**穷举那一半才是这条用例的价值**，手写的那几条只会证明我想到的情况。
 */
import { describe, it, expect } from "vitest";
import { overlapOf, overlapIsLight, touchesOverlap } from "../src/index.js";

/** 定义直译：两两比对，两边各自收。换实现之前 `overlapOf` 就是这么写的。 */
function naive(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const x of a) if (b.some((y) => touchesOverlap(x, y))) out.add(x);
  for (const y of b) if (a.some((x) => touchesOverlap(x, y))) out.add(y);
  return [...out];
}
/**
 * 定义直译，第二个：收集两侧指名了同一个文件的那些路径，照旧比符号。
 * **t-280 改了其中一句**：以前「重叠但路径不同」（也就是目录包住了另一侧）当场返回「不轻」，现在它只记不挡。
 * 这一份是拿来对拍的定义，所以它跟着定义一起改——**改的是同一句话，不是把断言迁就实现**：
 * 没有任何重叠 ⇒ 没有接缝，照旧 false；有重叠但两侧没指名过同一个文件 ⇒ 只可能是目录包出来的 ⇒ true。
 */
function naiveLight(a: string[], b: string[]): boolean {
  const pathOf = (t: string) => t.split("#")[0].replace(/\/+$/, "");
  const symbolOf = (t: string) => (t.includes("#") ? t.slice(t.indexOf("#") + 1) : null);
  const paths = new Set<string>();
  let any = false;
  for (const x of a) for (const y of b) {
    if (!touchesOverlap(x, y)) continue;
    any = true;
    if (pathOf(x) === pathOf(y)) paths.add(pathOf(x));
  }
  if (!any) return false;
  if (!paths.size) return true;   // t-280：只被目录包住
  for (const p of paths) {
    const syms = (side: string[]) => side.filter((t) => pathOf(t) === p).map(symbolOf);
    const as = syms(a), bs = syms(b);
    if (as.includes(null) || bs.includes(null)) return false;
    if (as.some((x) => bs.includes(x))) return false;
  }
  return true;
}

const same = (a: string[], b: string[]) => {
  expect(overlapOf(a, b).slice().sort()).toEqual(naive(a, b).slice().sort());
  expect(overlapIsLight(a, b), `overlapIsLight(${JSON.stringify(a)}, ${JSON.stringify(b)})`).toBe(naiveLight(a, b));
};

describe("t-250 · 新的 overlapOf 与定义逐条相同", () => {
  it("手写的那几种：相等、符号、目录包含、目录被包含、毫不相干、非路径的触点", () => {
    same(["packages/core/src/reduce.ts"], ["packages/core/src/reduce.ts"]);
    same(["packages/core/src/reduce.ts#overlapOf"], ["packages/core/src/reduce.ts"]);
    same(["packages/core/src/reduce.ts#overlapOf"], ["packages/core/src/reduce.ts#detectSeams"]);
    same(["packages/core"], ["packages/core/src/reduce.ts"]);           // 目录包含文件
    same(["packages/core/src/reduce.ts"], ["packages/core"]);           // 反过来
    same(["packages/core/"], ["packages/core/src/a.ts"]);               // 尾斜杠
    same(["packages/core/src/a.ts"], ["packages/server/src/a.ts"]);     // 同名不同处，不相干
    same(["GET /health"], ["GET /health"]);
    same(["GET /health"], ["GET "]);                                     // 非路径也按同一条定义走
    same(["docs"], ["docs/product.md", "docs/design.md"]);
    same([], ["packages/core"]);
    same(["packages/core"], []);
    same(["a/b/c/d/e.ts"], ["a/b"]);                                     // 隔了好几级
    same(["a/b"], ["a/bc/d.ts"]);                                        // **前缀但不是上级**：ab 不含 a/bc
  });

  it("穷举：从一小池路径里生成的每一对都对拍一遍", () => {
    const pool = ["a", "a/b", "a/b/c.ts", "a/b/c.ts#f", "a/b/c.ts#g", "a/bc", "a/bc/d.ts", "a/", "b", "b/a.ts", "x.ts", "x.ts/y", "GET /h", "docs", "docs/p.md"];
    let pairs = 0;
    for (const x of pool) for (const y of pool) { same([x], [y]); pairs++; }
    // 多条对多条：取每一对三元组
    for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j++) {
      const a = [pool[i], pool[(i + 3) % pool.length], pool[(i + 7) % pool.length]];
      const b = [pool[j], pool[(j + 5) % pool.length]];
      same(a, b); pairs++;
    }
    expect(pairs).toBeGreaterThan(400);
  });

  it("重复的触点、两边同一条、以及一条同时既包含又被包含", () => {
    same(["a/b", "a/b", "a/b/c.ts"], ["a/b/c.ts", "a"]);
    same(["a", "a/b/c.ts"], ["a/b", "z"]);
  });
});
