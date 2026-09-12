/**
 * t-224：**搬家这条路，端到端走一遍。**
 *
 * 判据 2 的原话是「同一份来源用这条路导两遍，日志不多出第二条……**本件只要求它在 CLI 这条路上被真走到一次**」。
 * t-088 的去重两年前就在 `appendFrom` 里，而它**从来没有被这条路走到过**：上线至今 7051 条事件里 `from` 出现 0 次。
 * 所以这一份不测「去重函数对不对」，测的是**真 CLI 的 `runImport` → 真 `Client` → 真 HTTP → 真服务端**这一整条。
 *
 * 为此 server 的 devDependencies 多了一条 `@ateam/cli`（CLAUDE.md 要求加依赖时说明为什么）：**两端各自测过、
 * 合起来那道缝没人看**，是这几天数过好几次的形状——qa 16:33 在 t-212 上刚点过同一处。用 stub 服务器测 CLI，
 * 或用 fetch 直接打服务器，都会让这一份变成「每一块都对」的又一个例子。只在用例里用，产物不依赖它。
 *
 * 判据 5 那一遍（**新建的空项目上、照说明书走**）不在这里：那是 qa 在真服务上做的事，repo 这一面顶不了它。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, IMPORT_NOTHING_WRITTEN, importSummary, importAlready, type Event } from "@ateam/core";
import { runImport, type Written } from "@ateam/cli/dist/import.js";
import { Client } from "@ateam/cli/dist/client.js";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let client: Client;

const SAMPLE = [
  '# 旧队伍导出的在途单据',
  JSON.stringify({ kind: "note", body: "把结算页拆成两步，前端等接口", from: "VersaHub/docs/pm/2026-08-30.md#L12" }),
  JSON.stringify({ kind: "note", body: "支付回调偶发重复，已挂着三天", from: "VersaHub/issues/318" }),
  JSON.stringify({ kind: "reading", key: "users.count", value: 1830, surface: "production", method: "旧看板导出", measured_at: "2026-09-01T00:00:00.000Z", from: "VersaHub/metrics/2026-09-01" }),
].join("\n");

const run = async (text: string) => {
  const out: string[] = [], err: string[] = [];
  // t-241：runImport 从此还带出「哪几条被拒了」（搬家也是一次发多件），这里只取退出码
  const { exit, failed } = await runImport(text, (e) => client.emit(e) as Promise<Written>, "dev", (l) => out.push(l), (l) => err.push(l));
  return { exit, failed, out, err };
};
const count = async () => (await store.read()).events.length;

beforeAll(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  client = new Client({ url: `http://127.0.0.1:${(app.address() as AddressInfo).port}`, token: TOKEN, me: "dev" });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-224 判据 1、2 · 导两遍，日志不多出第二条", () => {
  it("第一遍：三条都进去了，每一条都带着它在原处的身份", async () => {
    const before = await count();
    const { exit, out } = await run(SAMPLE);
    expect(exit, "全成").toBe(0);
    expect(await count()).toBe(before + 3);
    const written = (await store.read()).events.slice(-3) as (Event & { from?: string })[];
    expect(written.map((e) => e.from)).toEqual(["VersaHub/docs/pm/2026-08-30.md#L12", "VersaHub/issues/318", "VersaHub/metrics/2026-09-01"]);
    expect(out[out.length - 1]).toBe(importSummary(3, 0));
  });

  it("**第二遍：事件总数一个不变**，三条都说「早就搬过了」——这是判据 2 那件事", async () => {
    const before = await count();
    const { exit, out } = await run(SAMPLE);
    expect(await count(), "多出了第二份").toBe(before);
    expect(exit).toBe(0);
    expect(out.some((l) => l.endsWith(importAlready("VersaHub/issues/318"))), "带 id 的那一行说出它早就搬过了").toBe(true);
    expect(out[out.length - 1]).toBe(importSummary(0, 3));
  });

  it("**并发两遍也成立**：同时发同一份，总数仍然只加这么多", async () => {
    const fresh = JSON.stringify({ kind: "note", body: "并发那一条", from: "VersaHub/issues/999" });
    const before = await count();
    const [a, b] = await Promise.all([run(fresh), run(fresh)]);
    expect(await count(), "两个人同时搬同一条，日志里也只有一条").toBe(before + 1);
    expect([a.exit, b.exit]).toEqual([0, 0]);
    // 一次新写一次「早就有了」——谁先到不定，所以只数两边加起来
    const wrote = [a, b].filter((r) => r.out.includes(importSummary(1, 0))).length;
    expect(wrote, "恰好一次是新写的").toBe(1);
  });
});

describe("t-224 判据 3 · 一行不合格，一条都不发", () => {
  it("清单里夹着一条没 from 的：**另外两条也没写进去**，退出码 2，那几行两个流都说", async () => {
    const before = await count();
    const bad = [JSON.stringify({ kind: "note", body: "新的一条", from: "VersaHub/issues/500" }), JSON.stringify({ kind: "note", body: "没出处" })].join("\n");
    const { exit, out, err } = await run(bad);
    expect(exit).toBe(2);
    expect(await count(), "半份搬进去最贵").toBe(before);
    expect(out[0]).toBe(IMPORT_NOTHING_WRITTEN);
    expect(err[0]).toBe(IMPORT_NOTHING_WRITTEN);   // t-225：看它的进程只认 stdout，人只看 stderr，两处都要有
    expect(out.some((l) => l.includes("第 2 行"))).toBe(true);
  });

  it("改好那一行再跑一遍：先前那条不重复，只多了修好的这条", async () => {
    const before = await count();
    const fixed = [JSON.stringify({ kind: "note", body: "新的一条", from: "VersaHub/issues/500" }), JSON.stringify({ kind: "note", body: "补了出处", from: "VersaHub/issues/501" })].join("\n");
    const { exit } = await run(fixed);
    expect(exit).toBe(0);
    expect(await count()).toBe(before + 2);
    const again = await run(fixed);
    expect(await count(), "原样再跑一遍：一条都不多").toBe(before + 2);
    expect(again.out[again.out.length - 1]).toBe(importSummary(0, 2));
  });
});

describe("t-224 判据 4 · measured_at 那道闸没有为这件事放宽", () => {
  it("搬进来的事实不带 measured_at：**服务端照旧拒**，而且这条命令说得出是哪一条被拒", async () => {
    const before = await count();
    const { exit, out, err } = await run(JSON.stringify({ kind: "reading", key: "users.count", value: 7, surface: "production", from: "VersaHub/metrics/no-time" }));
    expect(exit, "全拒就是 2").toBe(2);
    expect(await count()).toBe(before);
    expect(out.join("\n")).toContain("measured_at");
    expect(err.join("\n")).toContain("VersaHub/metrics/no-time");   // 是哪一条，说得出来
  });

  it("带了 measured_at 就进得去——这道闸是照旧判，不是照旧拒", async () => {
    const before = await count();
    const { exit } = await run(JSON.stringify({ kind: "reading", key: "users.count", value: 7, surface: "production", measured_at: "2026-09-01T00:00:00.000Z", from: "VersaHub/metrics/with-time" }));
    expect(exit).toBe(0);
    expect(await count()).toBe(before + 1);
  });
});
