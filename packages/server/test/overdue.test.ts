/**
 * t-139 over the wire: the three states reach a reader, and a role that is listening never becomes a card asking the
 * human to start another one. Times relative to now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SERVICE_ACTOR, missingRoleOf, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";
let app: ReturnType<typeof createApp>, base = "", store: MemoryStore;

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const pull = (actor: string) => fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } }).then((r) => r.json());
const board = async () => (await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json()) as Board;

beforeAll(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-139 · 三态到得了读的人手里", () => {
  it("在听的那一堆不生成「起一个」卡；缺人的才生成", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // release is here and pulling, and is sitting on two overdue instructions
    await post("pm", { kind: "instruction", to: "release", body: "装一批", ack_by: past });
    await post("pm", { kind: "instruction", to: "release", body: "再装一批", ack_by: past });
    await pull("release");
    // qa has never pulled at all
    await post("pm", { kind: "instruction", to: "qa", body: "验一件", ack_by: past });

    const b = await board();
    const g = b.overdue_by_presence;
    expect(g.listening.roles).toEqual(["release"]);
    expect(g.listening.count).toBe(2);
    expect(g.listening.line).toBe("在听，2 条没确认");
    expect(g.missing.roles).toContain("qa");
    expect(g.missing.line).toMatch(/^缺人 \d+ 分钟，\d+ 条没送到$/);

    // the cards the service raised: about qa, never about release — release is right here
    const cards = b.needs_human.filter((c) => missingRoleOf(c.body));
    expect(cards.map((c) => missingRoleOf(c.body))).not.toContain("release");
    expect(JSON.stringify(cards)).not.toContain("起一个 release");
  });

  it("三堆各自可读，且加起来正好是 overdue 全部——但从不作为一个数出现", async () => {
    const b = await board();
    const g = b.overdue_by_presence;
    expect(g.missing.count + g.deaf.count + g.listening.count).toBe(b.overdue.length);
    for (const k of ["missing", "deaf", "listening"] as const) {
      expect(Array.isArray(g[k].instructions)).toBe(true);
      expect(g[k].count).toBe(g[k].instructions.length);
      if (!g[k].count) expect(g[k].line).toBe("");
    }
    // no field anywhere adds them up for the reader
    expect(Object.keys(g).sort()).toEqual(["deaf", "listening", "missing"]);
  });

  it("卡上的措辞来自 core 一处，服务端不自己再拼一遍", async () => {
    const b = await board();
    const card = b.needs_human.find((c) => missingRoleOf(c.body) === "qa");
    expect(card).toBeTruthy();
    expect(card!.body).toMatch(/^qa (缺人|没在听) \d+ 分钟，\d+ 条没送到/);
    expect(card!.from).toBe(SERVICE_ACTOR);
  });
});
