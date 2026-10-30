/**
 * t-270：**人第一屏那句「为什么卡住」不在闸的名单里。**
 *
 * `html.ts` 里逐字有 `export const whyLine = blockedWhy;`——同一个函数，在页面那一侧有个别名。
 * 而那道闸此刻的答案是**两样**（我 11:22 用真规则跑出来的原样）：
 *
 *     触点 packages/server/src/html.ts#whyLine        ⇒ REJECTED：这件动了人看得到的字
 *     触点 packages/core/src/board.ts#blockedWhy      ⇒ **落库成功**，判成 internal
 *
 * **别名被护着，被别名的那个没有。** 声明后者就能合法说「不改变人看到的东西」——
 * 这就是 pm 判据 7 里那个「静默放行」：**没有人会来吵。**
 *
 * 成因（判据 3，量出来的）：`blockedWhy` 那一段**没有中文字面量**（`speaking` 看不见它）、
 * **也不读 `HUMAN_FIELDS`／不引用登记过的话**（`deciding` 看不见它）。它被认出来靠的**不是**它自己写了什么，
 * 而是**一个渲染文件把它再导出了**——那是一次「把这个 core 符号接到人眼前」的明确动作。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { KEY_SYMBOLS, RENDERING_FILES, touchesHumanVisible, rendered, sourceFiles } from "../src/index.js";

const renderSources = () => Object.fromEntries(RENDERING_FILES.map((f) => [f, readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8")]));

describe("t-270 判据 1、3 · 渲染文件再导出的 core 符号，是人可见的", () => {
  it("**量出来的，不是手写的**：`rendered()` 从渲染文件里读出那几个再导出", () => {
    expect(rendered(renderSources())).toEqual(["TITLE_MAX_CHARS", "blockedWhy"]);
  });

  it("`blockedWhy` 在名单里——而且它进来的理由是被量到，不是被谁加进去", () => {
    expect(KEY_SYMBOLS).toContain("blockedWhy");
  });

  it("**判据 2 那一幕不再成立**：声明碰了它，闸判人可见", () => {
    expect(touchesHumanVisible("packages/core/src/board.ts#blockedWhy")).toBe("human_visible");
  });

  it("别名与被别名的两侧，此刻答案一样（此前一个 human_visible、一个 internal）", () => {
    expect(touchesHumanVisible("packages/server/src/html.ts#whyLine")).toBe("human_visible");
    expect(touchesHumanVisible("packages/core/src/board.ts#blockedWhy")).toBe("human_visible");
  });

  it("`TITLE_MAX_CHARS` 同一条理由进来：`html.ts` 里 `export const TITLE_MAX = TITLE_MAX_CHARS;`——改那个 30，每一张卡的标题都变", () => {
    expect(KEY_SYMBOLS).toContain("TITLE_MAX_CHARS");
  });

  it("这条量法只认「再导出」，不把渲染文件 import 过的东西一律算上——不然它会一次吞进 31 个，变成一道人人忽略的闸", () => {
    const src = renderSources();
    expect(rendered(src).length, "此刻恰好两个").toBe(2);
    // 反面：`boardTask` 被 html.ts import 且调用，但没有被再导出 ⇒ 这条量法不收它（它归判据 4 那份清单）
    expect(rendered(src)).not.toContain("boardTask");
  });
});
