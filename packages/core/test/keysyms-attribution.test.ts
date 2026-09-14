/**
 * t-264：**`KEY_SYMBOLS` 的归属错配，另一半。**
 *
 * frontend `09-07 09:27` 报过：那道闸「按上一个 export 之后」归属字符串，于是紧跟一个 export 下面的非导出函数，
 * 它的话被记在了上面那个常量头上。**`speaking()` 那一半后来被 t-204 顺带修好了**（切段认所有顶层声明），
 * 而 **`deciding()` 那一半原样活着**——dev `14:29` 在 HEAD `927bfe7` 上重新点名，欠了六天。
 *
 * pm 判据 7：错配是**两个方向**的——
 * · **误拦**：一个符号被错记进名单，声明它就被判成碰了人可见的东西。看得见，有人会来吵。
 * · **静默放行**：一个符号的证据被记到邻居头上、它自己掉出名单，声明它就当 internal 放过去，
 *   **而它其实真的在决定人看到什么。没人会来吵。**
 *
 * pm 判据 8 裁 B：切段认所有顶层声明，**但一个非导出 helper 的证据，算给正文里真的调用了它的那些导出**。
 * 理由是这四个里 `manual` **真的调** `common()`，而 `manual` 生成的是人读的角色手册——只切段不看调用，
 * 它会悄悄掉出闸外，正是「静默放行」那个方向。
 *
 * 判据 2 要求两半用**同一条用例**守着，所以下面的合同两半各测一遍，不各写一套。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { speaking, deciding, sourceFiles } from "../src/index.js";

/**
 * 真源码。路径**相对这份用例自己**找（`import.meta.url`），不看 cwd——vitest 的 cwd 是包目录，
 * 拿 `packages/core/src` 去读会读到一个空表，**而一个空表会让下面每一条 `not.toContain` 都凭空为真**。
 * 我第一版就是这么错的：三条里两条红得不对（`expected [] to include 'manual'`），
 * 而那条「误拦」还因此假绿了。
 */
const real = () => {
  const files = sourceFiles(new URL("../src", import.meta.url).pathname, "").map((f) => f.replace(/^\//, ""));
  return Object.fromEntries(files.map((f) => [f, readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")]));
};

/** 一份合成源码：`up` 是导出的、自己什么证据都没有；`helper` 非导出、带着证据；`calls` 决定 up 调不调它。 */
const fixture = (calls: boolean, evidence: string) => ({
  "packages/core/src/x.ts": [
    `export function up(x: number) {`,
    `  return ${calls ? "helper(x)" : "x + 1"};`,
    `}`,
    ``,
    `function helper(x: { title: string }) {`,
    `  return ${evidence};`,
    `}`,
    ``,
  ].join("\n"),
});

describe("t-264 · 一个非导出 helper 的东西，不许仅因为挨着就算在上面那个导出头上", () => {
  it("**`deciding`：挨着但没被调用 ⇒ 不算**（这条此刻是红的）", () => {
    expect(deciding(fixture(false, "x.title"))).toEqual([]);
  });

  it("**`deciding`：真的被调用 ⇒ 算**（判据 8 的 B，`manual` 靠的就是这一条）", () => {
    expect(deciding(fixture(true, "x.title"))).toEqual(["up"]);
  });

  it("`speaking`：同一条合同的另一半——挨着的中文字面量也不许记在上面那个头上（t-204 已修，这里守着它不回头）", () => {
    const src = {
      "packages/core/src/y.ts": [
        `export const UP = 1;`,
        ``,
        `function helper() {`,
        `  return "这是一句会被人看见的话";`,
        `}`,
        ``,
      ].join("\n"),
    };
    expect(speaking(src)).toEqual(["helper"]);      // 记在它自己头上，不是 UP
  });
});

describe("t-264 判据 1、7 · 真源码上，四个符号各自的方向", () => {
  const d = () => deciding(real());

  it("**误拦**：`blockedWhy`、`shapeFor` 只是挨着，正文里根本没提那个 helper ⇒ 不该在里面", () => {
    expect(d()).not.toContain("blockedWhy");
    expect(d()).not.toContain("shapeFor");
  });

  it("**该在里面、而且要为对的理由在**：`manual` 真的调 `common()`，生成的是人读的角色手册", () => {
    expect(d()).toContain("manual");
  });

  it("**静默放行，此刻正在发生**：`advance` 调了带证据的 helper，却一直漏在闸外 ⇒ 补进来", () => {
    expect(d()).toContain("advance");
  });
});
