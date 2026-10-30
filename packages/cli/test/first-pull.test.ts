/**
 * t-293 判据 7：**节点没有游标时，不许静默消费那一批日志。**
 *
 * pd 06:21 的现场：92 条被标成读过而它一个字没看见（含解除叫停与三张新单），于是它照着一份 34 分钟前的
 * FOCUS 去抬一个一小时前就抬了的闸，在日志上多下了一个决策。读数 repo:init.consumed.silently = 92。
 *
 * 两条断言是这次事故本身要的，缺一条都验不到它：**说出条数与范围**，而且**说在那一批之前**——他丢的不是
 * 「没印出来」，是印出来之后被截断（97 行），摆结尾的总结 `head` 照样看不到。
 */
import { describe, it, expect } from "vitest";
import { firstPullLine } from "@ateam/core";
import { sync, type CursorStore, type Puller, type PullResult } from "../src/loop.js";

const ID = (n: number) => `01M6200000000000000000${String(n).padStart(4, "0")}`;
const LOG = Array.from({ length: 92 }, (_, i) => ({ id: ID(i), at: "2026-10-30T06:00:00.000Z", kind: "note", actor: "pm", body: `第 ${i} 条` }));
const EMPTY_OWED = { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 };

const store = (init: string | null): CursorStore & { value: string | null } => {
  const s = { value: init, read: () => s.value, write: (c: string | null) => { s.value = c; } };
  return s;
};
const puller = (): Puller => ({
  async pull(after: string | null): Promise<PullResult> {
    const rest = after ? LOG.filter((e) => e.id > after) : LOG;
    return { events: rest, for_me: [], cursor: rest.length ? rest[rest.length - 1].id : after, owed: EMPTY_OWED } as unknown as PullResult;
  },
});

describe("t-293 判据 7 · 第一次拉取不许静默消费", () => {
  it("没有位置 ⇒ 那一句与 pd 07:39 的定稿逐字相同", async () => {
    const lines: string[] = [];
    await sync(puller(), "dev", store(null), 0, (l) => lines.push(l));
    // pd 07:39 的定稿，逐字写死（不拼 firstPullLine 自己的那几段——拿实现核实现，pd 改了字也不会红）
    expect(lines[0]).toBe(`这台机器以前没在这儿读过日志，所以下面是从头开始的 92 条（${ID(0)} 到 ${ID(91)}）。这一批只送一次：读完这一次，游标就停在最后一条，下一次 sync 不会再给你它们。`);
    expect(lines[0]).toBe(firstPullLine(92, ID(0), ID(91)));
    expect(lines[0]).toContain("92");
    expect(lines[0]).toContain(ID(0));
    expect(lines[0]).toContain(ID(91));
  });

  it("**说在那一批之前**：pd 丢的 92 条是印完被截断，摆结尾的总结 head 照样看不到", async () => {
    const lines: string[] = [];
    await sync(puller(), "dev", store(null), 0, (l) => lines.push(l));
    const summary = lines.findIndex((l) => l.includes("以前没在这儿读过日志"));
    const firstEvent = lines.findIndex((l) => l.includes(ID(0)) && l.includes("第 0 条"));
    expect(summary, "总结要在").toBeGreaterThanOrEqual(0);
    expect(firstEvent, "事件也要在").toBeGreaterThan(0);
    expect(summary, "总结在那一批之前").toBeLessThan(firstEvent);
    // 真正要防的那一幕：只留开头 5 行（`head -5`）也看得见这一句
    expect(lines.slice(0, 5).some((l) => l.includes("以前没在这儿读过日志")), "head -5 之后它还在").toBe(true);
  });

  it("已经有位置的那一次不说它——那不是「第一次」，那一批也不是全部", async () => {
    const lines: string[] = [];
    await sync(puller(), "dev", store(ID(90)), 0, (l) => lines.push(l));
    expect(lines.some((l) => l.includes("以前没在这儿读过日志")), "不是第一次就不说").toBe(false);
    expect(lines.some((l) => l.includes(ID(91))), "该印的那一条照旧印").toBe(true);
  });

  it("第一次拉取但日志是空的 ⇒ 不说它（没有任何东西被消费）", async () => {
    const lines: string[] = [];
    const empty: Puller = { async pull() { return { events: [], for_me: [], cursor: null, owed: EMPTY_OWED } as unknown as PullResult; } };
    await sync(empty, "dev", store(null), 0, (l) => lines.push(l));
    expect(lines.some((l) => l.includes("以前没在这儿读过日志"))).toBe(false);
  });

  it("那句话里三样都在：条数、首、尾——少一样就不是「范围」", () => {
    const line = firstPullLine(92, ID(0), ID(91));
    for (const part of ["92", ID(0), ID(91)]) expect(line, part).toContain(part);
    // pd 07:39 的第二条约束：**第二句不许删**——「只送一次」是这一句存在的全部理由。
    expect(line, "只送一次那半句").toContain("这一批只送一次");
    expect(line, "说清游标停在哪儿").toContain("游标就停在最后一条");
    expect(line, "不许加「要不要现在看」那种问法").not.toContain("要不要");
  });
});
