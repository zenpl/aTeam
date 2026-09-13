/**
 * t-233 判据 2：**类别要跟着这条拒绝走到客户端。** 此前 409 的正文只有 rule 与一句话，命令行要分辨
 * 「那件事已经发生过了」只能去匹配话里的字——而那正是这件任务不许的做法。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-233 · 409 的正文自己说这是哪一类", () => {
  it("第二次 ack：409 带 already，时刻就是第一次 ack 那一条事件的时刻", async () => {
    const i = await (await post("pm", { kind: "instruction", to: "dev", body: "办一件事", ack_by: new Date(Date.now() + 6e5).toISOString() })).json();
    const ok = await (await post("dev", { kind: "ack", of: i.id })).json();
    const res = await post("dev", { kind: "ack", of: i.id });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "rejected", rule: "ack", already: { at: ok.at } });
    expect(body.message).toContain("already acked");
  });

  it("另一类的 409 不带 already——**「说不出类别」与「已经办好了」要分得开**", async () => {
    const res = await post("dev", { kind: "note", body: "   " });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.rule).toBe("note");
    expect(body.already).toBeUndefined();
  });
});
