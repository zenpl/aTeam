/**
 * t-341（pd 要求⑱ 在服务卡上的那一处）：**人那一页上服务卡里的时长走那把梯子。**
 *
 * 此前印的是「缺人 1286 分钟」——要人自己换算成小时才读得出严重程度（1286 分钟 ≈ 21 小时）。
 * 梯子早就在 core 里（`span`，t-199 把分档与取整抽进 `band`，三把梯子共用），这一件只是让卡去调它。
 *
 * **判据 5 的那一条我量了，结论是「有」**：`packages/core/src/board.ts:213` 的 `span(ms)` 四档正是判据 1 列的
 * 四档（`不到 1 分钟`／`N 分钟`／`N 小时`／`N 天`），所以没有新建第二处实现。
 * pd 给的线索（它那棵树里 `packages/server/src/i18n.ts` 的 missing 文案与线上一字不差、而它找不到梯子的实现）
 * 在我这棵树上对得上一半：i18n 那一处确实也印「缺人 N 分钟」，但它是**在场那一栏**，不是服务卡；
 * 服务卡的正文出自 `missingCard`。两处分别在哪，写在 done 的证据里。
 */
import { describe, it, expect } from "vitest";
import { missingCard, span, SPAN_UNDER_A_MINUTE } from "../src/index.js";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

describe("t-341 · 服务卡的时长走梯子，四档各命中一次", () => {
  // 判据 2 点名的四个输入。**59 秒那一档是这一件的要害**：原来参数是分钟，调用处先取整成 1，
  // 于是「不到 1 分钟」这一档永远走不到——取整必须留给梯子。
  const cases: [string, number, string][] = [
    ["59 秒", 59 * S, SPAN_UNDER_A_MINUTE],
    ["3 分钟", 3 * M, "3 分钟"],
    ["1286 分钟", 1286 * M, "21 小时"],
    ["3 天", 3 * D, "3 天"],
  ];

  for (const [name, ms, want] of cases) {
    it(`${name} ⇒ 「${want}」`, () => {
      expect(span(ms), "梯子自己先答一遍").toBe(want);
      const card = missingCard("release", "missing", ms, 1);
      expect(card).toBe(`release 缺人 ${want}，1 条没送到。起一个 release？`);
      // **只在梯子答的不是分钟那一档才断言这个**：59 秒答「不到 1 分钟」、3 分钟答「3 分钟」，
      // 那两档里「分钟」正是对的答案。我第一版不分档地断言「不许出现分钟」，于是把两条对的输出判成了错。
      if (!want.includes("分钟")) expect(card, "换算过了，就不许再出现那个原始分钟数").not.toContain(`${Math.round(ms / M)} 分钟`);
    });
  }

  it("pd 量到的那一张逐字对上：1286 分钟 ⇒ 「缺了 21 小时」那个量级，不再是「1286 分钟」", () => {
    const card = missingCard("release", "missing", 1286 * M, 1);
    expect(card).toContain("21 小时");
    expect(card).not.toContain("1286");
  });

  it("deaf 那一支同一把梯子（它那句话是 pd 的，一个字没动）", () => {
    expect(missingCard("dev", "deaf", 1286 * M, 3)).toBe("dev 有 21 小时没读日志了，3 条没送到——它还在写，只是没来读。起一个 dev？");
    expect(missingCard("dev", "deaf", 59 * S, 3)).toContain(`有 ${SPAN_UNDER_A_MINUTE}没读日志了`);
  });

  it("**从没读过日志那一档不变**：没有起点就没有时长，这一支压根不进梯子（t-091）", () => {
    expect(missingCard("qa", "missing", null, 1)).toBe("qa 从没读过日志，1 条没送到。起一个 qa？");
    expect(missingCard("qa", "missing", null, 1), "一个时长都不许出现").not.toMatch(/\d+ (分钟|小时|天)/);
  });
});
