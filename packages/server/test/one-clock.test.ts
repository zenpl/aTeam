/**
 * t-195 · 一页只有一个钟（qa 11:08）。
 *
 * `html.ts` 里那句「期限 还有 N 分钟」原来用 `Date.now()`，而整页别处用 `b.now`。**生产上两者差不到一秒，
 * 看页面永远看不出来**——是 qa 把牌桌的钟拨前 30 分钟才让它露出来：同一时刻，带默认那张卡说「还有 30 分钟」，
 * 这一句说「还有 59 分钟」，同页差 29 分钟。
 *
 * 判据 4 是 pm 从这件里抽出来的通则：**测试不许与被测共用同一个时间源。**原来抓不到它，正是因为夹具也用
 * `Date.now()`——两个钟是同一个，于是无论被测读哪一个都对得上。所以下面这条测试的第一件事就是把两个钟分开：
 * `b.now` 定在一个与真实时间相差很远的时刻，然后问「页面听谁的」。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, reduce, board, until, type Board } from "@ateam/core";
import { renderBoard } from "../src/html.js";

const HUMAN = "human";
/** 与真实时间差得足够远：任何一处偷用真实时钟都会当场对不上。 */
const BOARD_NOW = "2026-09-07T03:00:00.000Z";
const ACK_BY = "2026-09-07T03:40:00.000Z";      // 相对 b.now 还有 40 分钟

describe("t-195 · 页面上的时间只听 b.now", () => {
  const rendered = async () => {
    const state = reduce(await new MemoryStore().read());
    const b: Board = board(state, HUMAN);
    b.now = BOARD_NOW;
    // 一张**没有默认**的卡：走的正是那一句「期限 还有 N」的分支（有默认的走 says_default）
    b.needs_human.push({
      kind: "ask", id: "01NODEF", from: "pm", body: "旧渠道那份对不对？", title: "旧渠道那份对不对",
      detail: "", summary: "", since: BOARD_NOW, options: ["对", "有漏"], ack_by: ACK_BY,
    } as unknown as Board["needs_human"][number]);
    return renderBoard(b, state, { human: HUMAN });
  };

  it("期限那一句按 b.now 算，不按真实时钟", async () => {
    const html = await rendered();
    const want = until(Date.parse(ACK_BY) - Date.parse(BOARD_NOW));
    expect(want, "夹具本身要有意义：这个差值必须落在「还有 N 分钟」那一档").toBe("还有 40 分钟");
    expect(html, `页面应当说「期限 ${want}」`).toContain(`期限 ${want}`);
  });

  /**
   * 反面：如果那一处偷用真实时钟，它算出来的是「距 03:40 还有多久」按**此刻**算——那是过去，
   * `until` 对负数给出最小档。所以下面这条钉的是「页面没有说出任何一句由真实时钟算出来的话」。
   * 把 `now` 改回 `Date.now()`，这一条就红。
   */
  it("真实时钟算出来的那句话，一个字都不许出现在页面上", async () => {
    const html = await rendered();
    const byRealClock = until(Date.parse(ACK_BY) - Date.now());
    expect(byRealClock, "这条断言要有意义：两个钟必须算出不同的话").not.toBe(until(Date.parse(ACK_BY) - Date.parse(BOARD_NOW)));
    expect(html, `页面上出现了按真实时钟算的「期限 ${byRealClock}」`).not.toContain(`期限 ${byRealClock}`);
  });
});
