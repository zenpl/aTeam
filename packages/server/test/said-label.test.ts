/**
 * t-243：**core 的 `SAID_LABEL` 在 i18n.ts:68 还有第二份，两份可以各走各的。**
 *
 * 判据 1 先判是不是缺陷：**是重复**。两份此刻逐字相同（四条全同），而页面读的是 core 算好的 `label`，
 * i18n 那一份只在「板没带 label」时才走得到——**core 每一行都算了 label，所以它一次都走不到**。
 * 一份走不到、又与 core 逐字相同的表，唯一的作用是哪天悄悄分叉。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SAID_LABEL, SAY_HINT } from "@ateam/core";
import { UI } from "../src/i18n.js";
import { saidStatus } from "../src/html.js";

const i18nSrc = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");

describe("t-243 · 那四个词只有一处出处", () => {
  it("i18n 里不再有第二张表；要那几个词的去 core", () => {
    expect((UI as unknown as { saidStatus?: unknown }).saidStatus).toBeUndefined();
    expect(i18nSrc).not.toContain("saidStatus:");
    for (const w of Object.values(SAID_LABEL)) expect(i18nSrc, `${w} 不该再逐字住在 i18n 里`).not.toContain(`"${w}"`);
  });

  it("页面那一支退路读的是 core 那张表，文字与 core 逐字相同", () => {
    for (const [status, word] of Object.entries(SAID_LABEL)) {
      expect(saidStatus({ status, body: "", at: "2026-09-12T00:00:00.000Z" } as never)).toBe(word);
    }
  });

  it("板自己带了 label 时，照旧用它（那一支本来就是这么设计的）", () => {
    expect(saidStatus({ status: "task", label: "已成为任务：某件事", body: "", at: "x" } as never)).toBe("已成为任务：某件事");
  });

  it("那句提示里的三个词也从 core 来：改 core 的表，提示跟着变（此前它是一份转述）", () => {
    expect(UI.sayHint).toBe(SAY_HINT);
    for (const k of ["received", "requirement", "task"] as const) expect(UI.sayHint).toContain(SAID_LABEL[k]);
  });
});
