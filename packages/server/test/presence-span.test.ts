/**
 * t-346：在场那一栏的时长也走那把梯子（pd 要求⑱ 是**一律**）。
 *
 * 这两句住在 `packages/server/src/i18n.ts`，此前自己收分钟（`缺人 ${min} 分钟`／`${min} 分钟没读日志了`），
 * 于是人那一页上会读到「缺人 1286 分钟」。现在收毫秒、四档的字由 core 的 `span` 给——**一个新词都没造**。
 * 收分钟不行：59 秒在调用处就被取整，「不到 1 分钟」那一档永远走不到（t-341 已证）。
 */
import { describe, it, expect } from "vitest";
import { UI } from "../src/i18n.js";
import { SPAN_UNDER_A_MINUTE } from "@ateam/core";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

describe("t-346 · 在场那一栏的四档", () => {
  const rungs: [string, number, string][] = [
    ["59 秒", 59 * S, SPAN_UNDER_A_MINUTE],
    ["3 分钟", 3 * M, "3 分钟"],
    ["1286 分钟", 1286 * M, "21 小时"],
    ["3 天", 3 * D, "3 天"],
  ];
  for (const [name, ms, want] of rungs) {
    it(`${name} ⇒ 缺人「${want}」／「${want}没读日志了」`, () => {
      expect(UI.missing(ms)).toBe(`缺人 ${want}`);
      expect(UI.deaf(ms)).toBe(`${want}没读日志了`);
      // 判据 6：只在梯子答的不是分钟那一档，才断言那个原始分钟数不再出现
      if (!want.includes("分钟")) expect(UI.missing(ms)).not.toContain(`${Math.round(ms / M)} 分钟`);
    });
  }

  it("**判据 5**：从没读过日志那一档不进梯子，用的是另一句（没有起点就没有时长）", () => {
    expect(UI.missingNever).toBe("缺人");
    expect(UI.deafNever).toBe("没读过日志");
    for (const s of [UI.missingNever, UI.deafNever]) expect(s).not.toMatch(/\d/);
  });
});
