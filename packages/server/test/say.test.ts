/**
 * t-030: POST /say puts one sentence from the human into the log; the board then says where it went.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SAID_PREFIX } from "@ateam/core";
import { createApp } from "../src/app.js";
import { ownerKey, ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

const TOKEN = "secret-token";
const HUMAN = "human";
let app: ReturnType<typeof createApp>;
let base = "";

// t-234：「说一句」是人说的，所以走主人自己那把钥匙；管理钥匙不再代他说话
let OWNER = "";
const say = (text: string, headers?: Record<string, string>) =>
  fetch(`${base}/say`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(headers ?? { authorization: `Bearer ${OWNER}` }) }, body: new URLSearchParams({ text }), redirect: "manual" });
const boardJson = async () => (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json();
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  OWNER = await ownerKey(base, TOKEN);
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-030 · POST /say", () => {
  it("anonymous is 401; empty or too long is 400 and writes nothing", async () => {
    expect((await say("你好", {})).status).toBe(401);
    expect((await say("   ")).status).toBe(400);
    expect((await say("字".repeat(501))).status).toBe(400);
    expect((await boardJson()).said).toEqual([]);
  });

  it("with the token it lands as a note from the human, prefixed; a browser is sent back to /", async () => {
    const r = await say("登录后应该回到我刚才那页");
    expect(r.status).toBe(201);
    const note = await r.json();
    expect(note).toMatchObject({ kind: "note", actor: HUMAN, body: `${SAID_PREFIX}登录后应该回到我刚才那页` });
    const html = await say("再说一句", { authorization: `Bearer ${OWNER}`, accept: "text/html" });
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toBe("/");
    const b = await boardJson();
    expect(b.said.map((x: { body: string; label: string }) => [x.body, x.label])).toEqual([["再说一句", "已收到"], ["登录后应该回到我刚才那页", "已收到"]]);
  });

  it("the cookie from /?k= works like the Bearer, as for /decide", async () => {
    const cookie = await ownerCookie(base, TOKEN);
    expect((await say("用 cookie 说", { cookie })).status).toBe(201);
    expect((await say("坏 cookie", { cookie: "ateam=wrong" })).status).toBe(401);
  });

  it("the board follows the sentence into a task", async () => {
    const note = await (await say("部署要一键")).json();
    await post("pm", { kind: "task", op: "create", task: "t-50", title: "一键部署", criteria: ["按钮"], refs: [note.id] , no_human_impact: true});
    const b = await boardJson();
    expect(b.said[0]).toMatchObject({ id: note.id, status: "task", label: "已成为任务：一键部署" });
  });
});
