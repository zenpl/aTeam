/**
 * t-036: POST /ack acks an instruction as the human in one click, optionally with a "not now" note.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, DEFER_PREFIX } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
let app: ReturnType<typeof createApp>;
let base = "";
const auth = { authorization: `Bearer ${TOKEN}` };
const ack = (fields: Record<string, string>, headers: Record<string, string> = auth) =>
  fetch(`${base}/ack`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields), redirect: "manual" });
const post = async (actor: string, body: unknown) =>
  (await fetch(`${base}/events`, { method: "POST", headers: { ...auth, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const boardJson = async () => (await fetch(`${base}/board?full=1`, { headers: { ...auth, "x-actor": "qa" } })).json();
const later = () => new Date(Date.now() + 3_600_000).toISOString();

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-036 · POST /ack", () => {
  it("anonymous is 401; an unknown id is refused by the ack rule (409); nothing is written", async () => {
    expect((await ack({ id: "01X" }, {})).status).toBe(401);
    expect((await ack({ id: "01X" })).status).toBe(409);
    expect((await boardJson()).instructions).toEqual([]);
  });

  it("without a note: one ack event as the human; the card leaves needs_human", async () => {
    const i = await post("pm", { kind: "instruction", to: HUMAN, body: "第 3 批已上线。共 10 项", ack_by: later(), intent: "info" });
    expect((await boardJson()).needs_human.map((n: { id: string; kind: string; title: string }) => [n.id, n.kind, n.title])).toEqual([[i.id, "info", "第 3 批已上线"]]);
    const r = await ack({ id: i.id });
    expect(r.status).toBe(201);
    const { events } = await r.json();
    expect(events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([["ack", HUMAN]]);
    const b = await boardJson();
    expect(b.needs_human).toEqual([]);
    const acked = b.instructions.find((x: { id: string }) => x.id === i.id);
    expect(acked.status).toBe("acked");
    expect(acked.deferred).toBeUndefined();
    expect((await ack({ id: i.id })).status).toBe(409); // acked twice is a rejection
  });

  it("with a note: ack then a 'not now' note from the human that refs the instruction and, when named, hangs on the task", async () => {
    await post("pm", { kind: "task", op: "create", task: "t-9", title: "一键部署", criteria: ["按钮"] , no_human_impact: true});
    const i = await post("pm", { kind: "instruction", to: HUMAN, body: "部署 t-9。合并后推到 production", ack_by: later() });
    const r = await ack({ id: i.id, note: "明天再部署" }, { ...auth, accept: "text/html" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/");
    const b = await boardJson();
    const it = b.instructions.find((x: { id: string }) => x.id === i.id);
    expect(it).toMatchObject({ status: "acked", kind: "do", title: "部署 t-9", deferred: { body: "明天再部署" } });
    const task = b.tasks.open.find((t: { id: string }) => t.id === "t-9");
    expect(task.notes.map((n: { body: string; actor: string }) => [n.actor, n.body])).toEqual([[HUMAN, `${DEFER_PREFIX}明天再部署`]]);
    expect(b.needs_human).toEqual([]);
  });
});
