/**
 * t-218 判据 1、2、3：**命令行自己抛的那几种拒绝从 `POST /refusals` 进 t-212 那本同一本账**，
 * 而账上两栏并排数得出它们（`by_origin`）——**一本不说自己缺哪一类的账，会让人不再去核它完不完整。**
 *
 * 判据 3 的边界：服务端那一路（t-212 的两个出口）一个字没动，这里只补它看不见的那一类。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, cliRefusalOp, ulid, type EventStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const board = async () => (await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json());
const one = (rule = "decide", op = cliRefusalOp("decide"), id = ulid()) => ({ kind: "refused", id, at: new Date().toISOString(), who: "dev", rule, op });

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-218 · 补报进来的拒绝，与服务端自己挡下的，在同一本账上分两栏", () => {
  it("捎上来一条：记下了、回的是它的 id，账上多一条且算在 cli 那一栏", async () => {
    const r = one();
    const res = await post("dev", "/refusals", { refusals: [r] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recorded: [r.id], counted: true });
    const b = await board();
    expect(b.refusals.total).toBe(1);
    expect(b.refusals.by_origin).toEqual({ server: 0, cli: 1 });
    expect(b.refusals.by_rule).toMatchObject([{ rule: "decide", n: 1 }]);
    expect(b.refusals.by_who).toMatchObject([{ who: "dev", n: 1 }]);
  });

  it("同一条捎两遍只算一次：捎成了没听见回答的那次重来，不许把账撑大", async () => {
    const r = one("usage", cliRefusalOp("tell"));
    await post("dev", "/refusals", { refusals: [r] });
    await post("dev", "/refusals", { refusals: [r] });
    const b = await board();
    expect(b.refusals.by_rule.find((x: { rule: string }) => x.rule === "usage").n).toBe(1);
  });

  it("who 是这把钥匙说话的那个人，正文里写谁都不算——补的是自己的账，不是替别人记账", async () => {
    await post("qa", "/refusals", { refusals: [{ ...one("seam"), who: "human" }] });
    const b = await board();
    expect(b.refusals.by_who.map((x: { who: string }) => x.who)).not.toContain("human");
    expect(b.refusals.by_who.find((x: { who: string }) => x.who === "qa").n).toBe(1);
  });

  it("op 不带 `cli ` 前缀的不许混进服务端那一栏：认不出就记成说不出的那一种", async () => {
    await post("dev", "/refusals", { refusals: [{ ...one("shape"), op: "POST /events" }] });
    const b = await board();
    const forged = b.refusals.by_rule.find((x: { rule: string }) => x.rule === "shape");
    expect(forged.n).toBe(1);
    expect(b.refusals.by_origin.server, "服务端那一栏只数服务端真挡下的").toBe(0);
  });

  it("id 不是 id、规则名空着的那几条跳过，其余照记——一条坏的不该让整批捎不上去", async () => {
    const good = one("done", cliRefusalOp("task done"));
    const res = await post("dev", "/refusals", { refusals: [{ ...one(), id: "not-an-id" }, { ...one(), rule: " " }, good] });
    expect(await res.json()).toMatchObject({ recorded: [good.id] });
  });

  it("服务端自己挡下的那一路一个字没动：它仍算在 server 那一栏（判据 3 的边界）", async () => {
    await post("dev", "/events", { kind: "task", op: "done", task: "t-nope", evidence: "x" });
    const b = await board();
    expect(b.refusals.by_origin.server).toBeGreaterThan(0);
    expect(b.refusals.total).toBe(b.refusals.by_origin.server + b.refusals.by_origin.cli);
  });

  it("这个存储没有这本账时回 counted:false、recorded 空——**不许说记下了**，命令行那边因此不划掉", async () => {
    const bare = new MemoryStore() as EventStore;
    (bare as { recordRefusal?: unknown }).recordRefusal = undefined;   // 自己这一层盖住原型上那个，于是这个存储「没有这本账」
    const app2 = createApp({ store: bare, token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app2.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(app2.address() as AddressInfo).port}`;
    const res = await fetch(`${at}/refusals`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "dev", "content-type": "application/json" }, body: JSON.stringify({ refusals: [one()] }) });
    expect(await res.json()).toEqual({ recorded: [], counted: false });
    await new Promise<void>((r) => app2.close(() => r()));
  });

  it("没有钥匙的谁都不许往这本账里写", async () => {
    const res = await fetch(`${base}/refusals`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refusals: [one()] }) });
    expect(res.status).toBe(401);
  });
});
