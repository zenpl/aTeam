/**
 * t-130 over the wire: the declaration is checked by the service, not kept in someone's head, and the number it makes
 * reaches the dig layer without ever reaching 需要你. Times relative to now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, STOOD_IN_PREFIX, STAND_IN_ASK_TITLE, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>, base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { rule?: string; message?: string; id?: string } };
};
const board = async () => (await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json()) as Board;

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  for (const [id, title] of [["t-113", "接缝按符号判"], ["t-9", "还没验的一件"]] as const) {
    await post("pm", { kind: "task", op: "create", task: id, title, criteria: ["能用"] , no_human_impact: true});
    await post("dev", { kind: "task", op: "claim", task: id, touches: [`packages/${id}.ts`] });
    await post("dev", { kind: "task", op: "done", task: id, evidence: `abc1234: ${id}` , no_human_impact: true});
  }
  await post("qa", { kind: "task", op: "verify", task: "t-113", surface: "repo", pass: true });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-130 · 顶替：服务当场校验，不是一份手工清单", () => {
  it("说得出替代的是哪一件、那件确实已验未上线 → 收；否则 409 并说清为什么", async () => {
    expect((await post("pm", { kind: "note", body: `${STOOD_IN_PREFIX}我又手裁了一条接缝`, task: "t-113" })).status).toBe(201);
    const noTask = await post("pm", { kind: "note", body: `${STOOD_IN_PREFIX}又手裁了一条` });
    expect(noTask.status).toBe(409);
    expect(noTask.body.rule).toBe("stand-in");
    expect(noTask.body.message).toContain("要指名它替代的是哪一件任务");
    const notVerified = await post("pm", { kind: "note", body: `${STOOD_IN_PREFIX}顶了 t-9`, task: "t-9" });
    expect(notVerified.status).toBe(409);
    expect(notVerified.body.message).toContain("不是 verified");
  });

  it("这个数按被替代的任务分组，进挖层，不进「需要你」", async () => {
    await post("qa", { kind: "note", body: `${STOOD_IN_PREFIX}我也手裁了一条`, task: "t-113" });
    const b = await board();
    expect(b.stand_ins.total).toBe(2);
    expect(b.stand_ins.by_task).toEqual([{ task: "t-113", title: "接缝按符号判", count: 2, last_at: expect.any(String), who: ["pm", "qa"] }]);
    expect(b.stand_ins.summary).toContain("t-113 2 次");
    expect(JSON.stringify(b.needs_human)).not.toContain("顶");
  });

  it("同一件第三次：服务自己给 human 发一张具体的卡，一天只发一张", async () => {
    expect((await board()).needs_human.some((c) => JSON.stringify(c).includes(STAND_IN_ASK_TITLE))).toBe(false);
    expect((await post("dev", { kind: "note", body: `${STOOD_IN_PREFIX}第三次了`, task: "t-113" })).status).toBe(201);
    const b = await board();
    const card = b.needs_human.find((c) => JSON.stringify(c).includes(STAND_IN_ASK_TITLE))!;
    expect(card).toBeTruthy();
    expect(JSON.stringify(card)).toContain("t-113");
    expect(JSON.stringify(card)).toContain("3 次");
    // a fourth in the same day adds no second card
    expect((await post("qa", { kind: "note", body: `${STOOD_IN_PREFIX}第四次`, task: "t-113" })).status).toBe(201);
    const after = await board();
    expect(after.needs_human.filter((c) => JSON.stringify(c).includes(STAND_IN_ASK_TITLE))).toHaveLength(1);
    expect(after.stand_ins.total).toBe(4);
  });
});
