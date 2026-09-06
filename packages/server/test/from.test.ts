/**
 * t-088 / t-089 over the API: an event carried in from somewhere else lands once, and an imported number lands expired.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let base = "";
const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: "Bearer k", "x-actor": actor, "content-type": "application/json", "x-ateam-client": "2" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const log = async () => (await (await fetch(`${base}/log`, { headers: { authorization: "Bearer k", "x-actor": "pm", "x-ateam-client": "2" } })).json()).events as { id: string; from?: string }[];

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: "k", human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-088 · POST /events with from", () => {
  it("first write is 201 created, a repeat is 200 with the same id and nothing appended, even when several race", async () => {
    const first = await post("pm", { kind: "note", body: "旧单据 #7", from: "tracker#7" });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const again = await post("dev", { kind: "note", body: "第二次搬同一张", from: "tracker#7" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, created: false, body: "旧单据 #7" });
    const racers = await Promise.all([1, 2, 3, 4].map((i) => post("pm", { kind: "note", body: `并发 ${i}`, from: "tracker#8" })));
    const ids = new Set(racers.map((r) => r.body.id));
    expect(ids.size).toBe(1); // one event, whoever got there first
    expect(racers.filter((r) => r.body.created)).toHaveLength(1);
    const events = await log();
    expect(events.filter((e) => e.from === "tracker#7")).toHaveLength(1);
    expect(events.filter((e) => e.from === "tracker#8")).toHaveLength(1);
    // an event without from is unaffected: two writes, two events
    await post("pm", { kind: "note", body: "普通" });
    await post("pm", { kind: "note", body: "普通" });
    expect((await log()).filter((e) => !e.from && !("op" in e))).toHaveLength(2);
  });
});

describe("t-089 · an imported reading over the API", () => {
  it("without measured_at it is 409 with the rule and the missing field; with it, it lands expired and is not current", async () => {
    const bad = await post("pm", { kind: "reading", surface: "production", key: "users.count", value: 1200, from: "旧看板/指标页" });
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ error: "rejected", rule: "reading" });
    expect(bad.body.message).toContain("measured_at");
    const ok = await post("pm", { kind: "reading", surface: "production", key: "users.count", value: 1200, from: "旧看板/指标页", measured_at: new Date(Date.now() - 60_000).toISOString() });
    expect(ok.status).toBe(201);
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: "Bearer k", "x-actor": "qa", "x-ateam-client": "2" } })).json();
    const row = b.readings.find((r: { key: string }) => r.key === "users.count");
    expect(row).toMatchObject({ valid: false, why: "搬进来的数字：在这里没有测过，谁用谁重测" });
  });
});

describe("t-092 · the check card over the API", () => {
  it("a note saying the import is done makes the service ask the human, with counts it took from the log", async () => {
    await post("pm", { kind: "task", op: "create", task: "m-1", title: "旧任务", criteria: ["旧判据"], from: "pm/单据#1" });
    await post("dev", { kind: "task", op: "claim", task: "m-1", touches: ["m-1"] });
    await post("pm", { kind: "note", body: "现行决定", decision: true, from: "pm/台账#1" });
    await post("pm", { kind: "reading", surface: "production", key: "users.count", value: 12, from: "pm/进度板", measured_at: new Date(Date.now() - 60_000).toISOString() });
    const done = await post("pm", { kind: "note", body: "导入完成：搬完了" });
    expect(done.status).toBe(201);
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: "Bearer k", "x-actor": "qa", "x-ateam-client": "2" } })).json();
    const card = b.needs_human.find((x: { body: string }) => x.body.startsWith("搬过来了，对吗？"));
    expect(card).toBeTruthy();
    // this file's earlier test imported a reading too, so the fact count comes from the board, not from a number typed here
    const facts = b.readings.filter((r: { why?: string }) => r.why === "搬进来的数字：在这里没有测过，谁用谁重测").length;
    expect(card.body).toBe(`搬过来了，对吗？在途 1 件、1 条现行决定、${facts} 个数字、0 个等你答的问题。搬来的数字都标了要重测。旧的那边一条没删。`);
    expect(facts).toBeGreaterThan(0);
    expect(card.options).toEqual(["对", "有漏"]);
    // answering it sends the importer one instruction
    const r = await fetch(`${base}/decide`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id: card.id, option: "对" }) });
    expect(r.status).toBe(201);
    const events = await log() as unknown as { kind: string; to?: string; body?: string }[];
    const told = events.filter((e) => e.kind === "instruction" && e.to === "pm" && e.body?.startsWith("human 说清单对"));
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("迁移完成");
  });
});

describe("t-096 · display names over the API", () => {
  it("a task carries its old number to the board, the name can change, and lookups still go by id", async () => {
    expect((await post("pm", { kind: "task", op: "create", task: "L-1", title: "登录超时", criteria: ["x"], label: "T-07", from: "pm/单据#7" })).status).toBe(201);
    expect((await post("pm", { kind: "task", op: "create", task: "L-2", title: "另一件", criteria: ["x"], label: "T-07" })).status).toBe(201);
    const byId = await (await fetch(`${base}/task/L-1`, { headers: { authorization: "Bearer k", "x-actor": "qa", "x-ateam-client": "2" } })).json();
    expect(byId.task).toMatchObject({ id: "L-1", label: "T-07", title: "登录超时" });
    expect((await fetch(`${base}/task/T-07`, { headers: { authorization: "Bearer k", "x-actor": "qa", "x-ateam-client": "2" } })).status).toBe(404); // a label finds nothing
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: "Bearer k", "x-actor": "qa", "x-ateam-client": "2" } })).json();
    const open = b.tasks.open as { id: string; label?: string }[];
    expect(open.filter((t) => t.label === "T-07").map((t) => t.id).sort()).toEqual(["L-1", "L-2"]); // same name, two ids
    expect((await post("dev", { kind: "task", op: "label", task: "L-1", label: "T-07 登录" })).status).toBe(201);
    const after = await (await fetch(`${base}/task/L-1`, { headers: { authorization: "Bearer k", "x-actor": "qa", "x-ateam-client": "2" } })).json();
    expect(after.task).toMatchObject({ id: "L-1", label: "T-07 登录", title: "登录超时" });
  });
});
