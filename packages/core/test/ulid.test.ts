/**
 * t-278：**同一毫秒里连造两个 id，它们之间也要排得出先后。**
 *
 * 这个洞是被 t-278 踩出来的，不是我推理出来的：服务在同一刻连发两张卡之后，`fixture-parity`（t-062
 * built≡served）开始**时红时绿**——单独跑绿，整包跑红，取决于别的用例把进程里的随机数推到了哪儿。
 * 成因是 `ulidAt` 每次换一条全新的随机尾巴，于是同一毫秒的两条按 id 排序是随机的；而日志按 id 排序，
 * 两边同一对事件因此排出了相反的顺序。`ulid`（活服务那支）早就有这道保险，`ulidAt` 没有。
 */
import { describe, it, expect } from "vitest";
import { ulidAt, ulid } from "../src/ulid.js";

describe("t-278 · ulidAt 在同一毫秒里也是单调的", () => {
  it("同一个 ms 连造 50 个：严格递增，且时间位逐字不变", () => {
    const ms = Date.parse("2026-09-16T04:00:00.000Z");
    const ids = Array.from({ length: 50 }, () => ulidAt(ms));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(new Set(ids.map((x) => x.slice(0, 10))).size, "时间位不许因为单调而漂移").toBe(1);
  });

  it("换一个 ms 就换一条新尾巴，而且不同 ms 之间照旧按时间排", () => {
    const a = ulidAt(1_000_000);
    const b = ulidAt(2_000_000);
    expect(a < b).toBe(true);
    expect(ulidAt(1_000_000).slice(0, 10)).toBe(a.slice(0, 10));
  });

  it("活服务那支的口径没被动到：`ulid` 照旧单调", () => {
    const now = Date.now();
    const ids = [ulid(now), ulid(now), ulid(now)];
    expect([...ids].sort()).toEqual(ids);
  });
});
