/**
 * t-068: GET /task/<id> is one task in full — criteria, evidence, verifications, seams — for a page that only inlines
 * this version's tasks. Unknown id is 404.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } });

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "task", op: "create", task: "t-1", title: "牌桌显示 sha", criteria: ["GET /health 有 sha", "牌桌显示它"] });
  await post("pm", { kind: "task", op: "create", task: "t-2", title: "限流", criteria: ["429"] });
  await post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["app.ts"] });
  await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "abc1234: 本地看到", shows: "牌桌第一行是版本" });
  await post("frontend", { kind: "task", op: "claim", task: "t-2", touches: ["app.ts"] });
  await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: true });
  await post("pd", { kind: "note", body: "评审过了", task: "t-1" });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-068 · GET /task/<id>", () => {
  it("returns the task with criteria, evidence, verifications, notes, era and the seams touching it; 404 for an unknown id; needs a key", async () => {
    const r = await get("/task/t-1");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.task).toMatchObject({ id: "t-1", title: "牌桌显示 sha", status: "verified", criteria: ["GET /health 有 sha", "牌桌显示它"], evidence: "abc1234: 本地看到", shows: "牌桌第一行是版本", era: "this_version", summary: "✓ repo" });
    expect(j.task.verifications).toMatchObject([{ surface: "repo", pass: true, by: "qa" }]);
    expect(j.task.notes).toMatchObject([{ actor: "pd", body: "评审过了" }]);
    expect(j.seams).toMatchObject([{ id: "seam:t-1+t-2", stacked: { done: "t-1", on: "t-2" } }]);
    expect((await get("/task/t-9")).status).toBe(404);
    expect((await fetch(`${base}/task/t-1`)).status).toBe(401);
    // every task on the board carries its layer, so the page can decide what to inline
    const b = await (await get("/board")).json();
    for (const t of Object.values(b.tasks as Record<string, { era: string }[]>).flat()) expect(["this_version", "earlier"]).toContain(t.era);
  });
});
