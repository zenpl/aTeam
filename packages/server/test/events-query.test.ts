/**
 * t-291 判据 1、2、3、4：**GET /events 收到不认识的查询参数时当场 400，而合法那条路一个字不变。**
 *
 * 起因是 pm 05:3x 焦点①：三份外部反馈各自排第一的那件事是同一个形状——**输入被静默丢弃**。`?since=…` 此前
 * 静默变成「从头开始」，于是要「只要一截」的人拿到全量、并且以为是别处坏了。
 *
 * pd 05:30 ① 的定稿在这里**逐字写死**，不从 core 取：拿实现核实现，pd 哪天被改了字这条也照样绿。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "t";
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let base = "";
const head = (actor: string) => ({ authorization: `Bearer ${TOKEN}`, "x-actor": actor });
const get = (actor: string, q = "") => fetch(`${base}/events${q}`, { headers: head(actor) });
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { ...head(actor), "content-type": "application/json" }, body: JSON.stringify(body) });
const fullBoard = async () => (await fetch(`${base}/board?full=1`, { headers: head("pm") })).json();

/** pd 05:30 ① 的定稿，逐字。 */
const PD = "我不认识参数 since。你要的大概是 after=<上次返回的 cursor>。这个地址认的参数只有 after、wait。";

beforeEach(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0, testHooks: true });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
});
afterEach(() => new Promise<void>((r) => app.close(() => r())));

describe("t-291 · GET /events 拒收未知查询参数", () => {
  it("判据 1：当场 400，正文是 pd 的定稿，一个字不差", async () => {
    const res = await get("dev", "?since=01ABC");
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(PD);
  });

  it("判据 2：since 的拒收里写明要的是 after", async () => {
    expect((await (await get("dev", "?since=01ABC")).json()).message).toContain("你要的大概是 after");
  });

  it("判据 2：limit / kind / to 这三个今天同样被静默吞掉的，一律拒收而不是忽略", async () => {
    for (const q of ["?limit=10", "?kind=note", "?to=dev"]) {
      const res = await get("dev", q);
      expect(res.status, q).toBe(400);
      const body = await res.json();
      expect(body.message, q).toContain("我不认识参数");
      expect(body.message, q).toContain("这个地址认的参数只有 after、wait。");
    }
  });

  it("判据 2：合法参数混着一个不认识的，照样拒——「其余都对」不是放过它的理由", async () => {
    const res = await get("dev", "?after=01ABC&limit=10");
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("参数 limit");
  });

  it("判据 3：?after=<cursor>&wait=25000 行为不变，仍 200", async () => {
    const first = await (await post("pm", { kind: "note", body: "第一条" })).json();
    await post("pm", { kind: "note", body: "第二条" });
    const res = await get("dev", `?after=${first.id}&wait=25000`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.shape).toBeTruthy();
    expect(body.events.map((e: { body?: string }) => e.body)).toContain("第二条");
  });

  it("判据 3：什么参数都不带的那条路也不变", async () => {
    const res = await get("dev");
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).events)).toBe(true);
  });

  it("判据 4：这次拒收进 refusals，与拒收未知 kind 同一条路", async () => {
    const before = (await fullBoard()).refusals.total;
    await get("dev", "?since=01ABC");
    await post("dev", { kind: "没这种", body: "x" }); // 未知 kind：t-212 那条路
    const b = await fullBoard();
    expect(b.refusals.total).toBe(before + 2);
    expect(b.refusals.by_rule.map((x: { rule: string }) => x.rule)).toContain("query");
    expect(b.refusals.by_who.find((x: { who: string }) => x.who === "dev")!.n).toBe(2);
  });

  it("被拒的那一次什么都没发生：游标不动", async () => {
    await post("pm", { kind: "note", body: "一条" });
    await get("dev", "?since=01ABC");
    expect(store.cursors.get("dev")).toBeUndefined();
    await get("dev");
    expect(store.cursors.get("dev")).toBeTruthy();
  });
});
