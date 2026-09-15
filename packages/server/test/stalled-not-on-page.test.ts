/**
 * t-279 判据 1：**范围只到命令行的牌桌，`GET /` 上一个字都不许出现。**
 *
 * 那一页要不要因此给人出一张卡、出的话说什么、门槛定在哪，是 `t-266` 留给 `pd` 的那一半；`pd` 缺席也不搬。
 * 所以这一条钉的不是「我没写」，是**造出那个会触发的状态，再证明页面上确实没有它**——
 * 「我没往那边写」与「那边确实不显示」是两句话，而本件只认后一句。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, STALLED_HEADING, reduce, board } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "t";
let app: ReturnType<typeof createApp>;
let store: MemoryStore;
let base = "";
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles",
    value: { pm: { responsibilities: ["R4"] }, dev: { responsibilities: ["R5"] }, qa: { responsibilities: ["R6"] } } });
  await post("qa", { kind: "note", body: "我判完上一批了" });
  await post("pm", { kind: "task", op: "create", task: "t-901", title: "一件", criteria: ["x"], no_human_impact: true });
  await post("dev", { kind: "task", op: "claim", task: "t-901", touches: ["src/a.ts"] });
  await post("dev", { kind: "task", op: "done", task: "t-901", evidence: "abc1234: 做完了", no_human_impact: true });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-279 · 这一格不上人那一页", () => {
  it("先证那个状态真的会触发：同一份数据，把钟拨过门槛，牌桌那一侧算得出这一行", async () => {
    await store.setCursor({ actor: "qa", last_event_id: null, at: new Date(Date.now() + 2 * 3600_000).toISOString() });
    const later = new Date(Date.now() + 2 * 3600_000);
    const b = board(reduce(await store.read(), later), "human", later);
    expect(b.stalled.map((x) => x.role), "触发条件成立").toEqual(["qa"]);
  });

  it("而 GET / 那一页上，一个字都没有", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html.length, "页面本身是好的，不是空的").toBeGreaterThan(500);
    expect(html).not.toContain(STALLED_HEADING);
    expect(html).not.toContain("没写过任何事件");
    expect(html).not.toContain("件等它判");
    expect(html).not.toContain("stalled");
  });
});
