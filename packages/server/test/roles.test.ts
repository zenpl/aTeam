/**
 * t-106 over the wire: the refusal a real client gets, and the display names the page reads off the board.
 * qa 00:14 hit this with a real request; the point of the rule is that the refusal arrives as a refusal (409),
 * not as a team that silently disappears.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { rule?: string; message?: string } };
};
const board = async () => (await (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json()) as { roles: string[]; role_names: Record<string, string> };

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-106 · role ids over the wire", () => {
  it("a non-ASCII id comes back 409 with the way out, not a quietly broken team", async () => {
    const r = await post("pm", { kind: "reading", surface: "project", key: "roles", value: { 主编: ["R1"], 审稿: ["R6"] } });
    expect(r.status).toBe(409);                       // 判据 1：拒绝，不是 500，也不是默默收下
    expect(r.body.rule).toBe("reading");
    expect(r.body.message).toContain("这些不行：主编、审稿");
    expect(r.body.message).toContain('{"reviewer": {"name": "审稿", "responsibilities": ["R6"]}}');
    expect((await board()).roles).not.toContain("主编");
  });

  it("the fixed declaration goes through and the board carries the names for the page to render", async () => {
    const ok = await post("pm", { kind: "reading", surface: "project", key: "roles", value: {
      editor: { name: "主编", responsibilities: ["R1", "R4"] },
      writer: { name: "写手", responsibilities: ["R5"] },
      reviewer: { name: "审稿", responsibilities: ["R6"] },
      ops: { responsibilities: ["R9"] },
    } });
    expect(ok.status).toBe(201);
    const b = await board();
    expect(b.roles).toEqual(["editor", "writer", "reviewer", "ops"]);
    expect(b.role_names).toEqual({ editor: "主编", writer: "写手", reviewer: "审稿" });
    // 判据 2：显示名不设门槛——同一个 id 换一个很长的、混语言的名字，照收
    const long = "审稿 / Reviewer / Рецензент / 校閲 ".repeat(8);
    expect((await post("pm", { kind: "reading", surface: "project", key: "roles", value: { reviewer: { name: long, responsibilities: ["R6"] } } })).status).toBe(201);
    expect((await board()).role_names.reviewer).toBe(long.trim());   // 只去首尾空白，中间原样
  });

  it("an ASCII id still works as an actor end to end, so the rule changed nothing for a team that was already fine", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: { editor: { name: "主编", responsibilities: ["R1"] }, writer: { name: "写手", responsibilities: ["R5"] }, reviewer: { name: "审稿", responsibilities: ["R6"] } } });
    expect((await post("editor", { kind: "task", op: "create", task: "t-1", title: "题", criteria: ["能用"] })).status).toBe(201);
    expect((await post("writer", { kind: "task", op: "claim", task: "t-1", touches: ["x"] })).status).toBe(201);
    expect((await post("writer", { kind: "task", op: "done", task: "t-1", evidence: "abc1234" , no_human_impact: true})).status).toBe(201);
    expect((await post("reviewer", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: true })).status).toBe(201);
  });
});
