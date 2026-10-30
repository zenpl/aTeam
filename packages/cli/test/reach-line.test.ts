/**
 * t-307：**开着的指令按 reach 分三桶，而这一句的读者是读这块板的那个节点自己。**
 *
 * pd 18:15 连读者与位置一起定了：**不上人那一页**（除非它挡住了人要拍的板），所以它活在 `ateam board` 上。
 * 人那一页那一侧由 `packages/server/test/page-history.test.ts` 反向钉着（那一页上一个字都没有）。
 *
 * **中间那一桶的措辞是这件事里最要紧的一处**：`read` 同时装着「办了但没引用」与「看见了什么也没做」，
 * 而这一侧没有任何独立信号能分开它们（`reduce.ts:637-643`）。pd 的推论：**两种相反的情形若真的分不开，
 * 句子要说出「分不开」，不许替其中一种说话**——把它印成「没动」是替一种说话，而那一种恰好是责备人的那一种。
 * 所以这一份用例一个中文字都不自己写：字从 core 取，措辞哪天改了用例跟着改，而一个钉死字面量的实现会当场红。
 */
import { describe, it, expect } from "vitest";
import { board } from "../src/format.js";
import { reachCountLine, type Board } from "@ateam/core";

const NOW = "2026-10-30T18:40:00.000Z";
const empty = (): Board => ({
  now: NOW, focus: undefined, instructions: [], tasks: {}, readings: [], seams: [], contained_seams: [],
  needs_human: [], overdue: [], undelivered: [], late: { count: 0, acted: 0, untouched: 0, oldest_s: null, instructions: [] },
  overdue_by_presence: { missing: { roles: [], count: 0, away_s: null, instructions: [], line: "" }, deaf: { roles: [], count: 0, away_s: null, instructions: [], line: "" }, listening: { roles: [], count: 0, away_s: null, instructions: [], line: "" } },
  in_flight: {}, release: {}, live: { deployed_sha: null, recent: [], earlier: [], verified_on_production: [] },
  said: [], batches: [], disowned: [], contested: [], presence: [], roles: [], role_names: {}, coverage: [], stalled: [],
  allocation: { warnings: [], summary: "" }, stand_ins: { total: 0, since: "", by_task: [], summary: "" },
  alert: { status: "unanswered" }, omitted: [], shape: 2,
  reach_counts: { open: 0, unread: 0, read: 0, acted: 0, by_to: {} },
} as unknown as Board);

const withCounts = (by_to: Record<string, { open: number; unread: number; read: number; acted: number }>): Board => {
  const b = empty();
  const total = Object.values(by_to).reduce((a, c) => ({ open: a.open + c.open, unread: a.unread + c.unread, read: a.read + c.read, acted: a.acted + c.acted }), { open: 0, unread: 0, read: 0, acted: 0 });
  b.reach_counts = { ...total, by_to };
  return b;
};

describe("t-307 · 三桶那一行，按读它的那个节点自己", () => {
  it("印的是**发给我的**那一份，不是整份——另一个角色那一桶再大也不出现在我这块板上", () => {
    const b = withCounts({ frontend: { open: 3, unread: 1, read: 1, acted: 1 }, pm: { open: 700, unread: 0, read: 700, acted: 0 } });
    const mine = board(b, "frontend");
    expect(mine).toContain(reachCountLine(3, 1, 1, 1));
    expect(mine, "别人那一桶不是我的事").not.toContain(reachCountLine(700, 0, 700, 0));
    expect(board(b, "pm")).toContain(reachCountLine(700, 0, 700, 0));
  });

  it("中间那一桶说的是「看不出来」，而不是「没动」——那一句出自 core，这里只核它被印了", () => {
    const line = reachCountLine(5, 2, 2, 1);
    expect(line).toContain("办没办看不出来");
    expect(line, "不许替其中一种说话").not.toContain("没动");
    expect(board(withCounts({ qa: { open: 5, unread: 2, read: 2, acted: 1 } }), "qa")).toContain(line);
  });

  it("没有开着的事就不印：一条「发给你的还开着 0 条」每轮都出现，是把一句没有用处的话变成背景噪音", () => {
    expect(board(withCounts({ qa: { open: 0, unread: 0, read: 0, acted: 0 } }), "qa")).not.toContain("发给你的还开着");
    expect(board(withCounts({ pm: { open: 2, unread: 2, read: 0, acted: 0 } }), "qa")).not.toContain("发给你的还开着");
  });

  it("一条老服务不发这个字段，那就不印——不替它编一个", () => {
    const b = empty();
    delete (b as unknown as { reach_counts?: unknown }).reach_counts;
    expect(() => board(b, "frontend")).not.toThrow();
    expect(board(b, "frontend")).not.toContain("发给你的还开着");
  });
});
