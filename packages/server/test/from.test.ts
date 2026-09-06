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
