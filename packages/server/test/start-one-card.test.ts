/**
 * t-202 判据 4，走真接口：**那张「起一个 X？」的卡只在起一个新的真能解决问题的那一态出现。**
 *
 * 一正一反在同一次 `/_test/run` 里跑，因为要证的正是「同一时刻、同一份状态，两个角色得到不同的结论」：
 * · 反例（deaf）：`quiet` 从没拉过，但刚写过东西——它还活着、还在写，只是没来读日志。起第二个解决不了它。
 * · 正例（missing）：`gone` 从没拉过、也没写过——没人在跑这个角色，起一个新的正是那件人做得到的事。
 *
 * 真样本（pm 12:51 建这件时给的）：12:46:06 那份牌桌上 dev 6.8 分钟没拉、2.6 分钟前刚交过两件活，人的首屏
 * 却挂着「dev 没在听了 13 分钟，起一个 dev？」。
 *
 * 用例里没有绝对时间戳：ack_by 由 Date.now() 往回推。
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SERVICE_ACTOR, missingRoleOf, type Board, type Event } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";
const apps: ReturnType<typeof createApp>[] = [];
afterAll(() => Promise.all(apps.map((a) => new Promise<void>((r) => a.close(() => r())))));

async function up() {
  const store = new MemoryStore();
  const app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0, testHooks: true });
  apps.push(app);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const hdr = (actor: string) => ({ authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" });
  return {
    store,
    post: (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: hdr(actor), body: JSON.stringify(body) }).then((r) => r.json()),
    run: () => fetch(`${base}/_test/run`, { method: "POST", headers: hdr("pm"), body: "{}" }).then((r) => r.json()),
    board: () => fetch(`${base}/board?full=1`, { headers: hdr("pm") }).then((r) => r.json()) as Promise<Board>,
  };
}

describe("t-202 · 「起一个 X？」只在起一个新的解决得了的那一态出现", () => {
  it("同一次 run：还在写只是没读的不出卡，真没人在跑的出卡", async () => {
    const w = await up();
    const past = new Date(Date.now() - 60_000).toISOString();
    await w.post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "quiet", "gone"] });
    // 两个角色各欠一条已经到期、也从没读到的指令——「要不要起卡」的前提两边一样
    await w.post("pm", { kind: "instruction", to: "quiet", body: "干一件", ack_by: past });
    await w.post("pm", { kind: "instruction", to: "gone", body: "干一件", ack_by: past });
    // 唯一的区别：quiet 刚写过东西（deaf），gone 什么都没有（missing）
    await w.post("quiet", { kind: "note", body: "我在写，只是没来读" });

    const b0 = await w.board();
    expect(b0.presence.find((p) => p.actor === "quiet")!.status, "先确认两边真的是两态").toBe("deaf");
    expect(b0.presence.find((p) => p.actor === "gone")!.status).toBe("missing");

    await w.run();
    const raised = ((await w.store.read()).events as Event[])
      .filter((e) => e.kind === "instruction" && e.actor === SERVICE_ACTOR && missingRoleOf(e.body))
      .map((e) => missingRoleOf((e as { body: string }).body));
    expect(raised, "真没人在跑的那个，卡照出").toContain("gone");
    expect(raised, "还在写只是没读的那个，人不该被叫去起第二个").not.toContain("quiet");

    const b = await w.board();
    const cards = b.needs_human.filter((c) => missingRoleOf(c.body));
    expect(cards.map((c) => missingRoleOf(c.body))).toEqual(["gone"]);
    expect(JSON.stringify(cards)).not.toContain("起一个 quiet");
    // deaf 那一态人仍然看得到，只是在分组那一层，不以「起一个 X？」的形状进首屏
    expect(b.overdue_by_presence.deaf.roles).toContain("quiet");
  });

  it("已经挂着的那张卡，在它变成 deaf 的那一刻就从首屏撤下——不必等它回来读日志", async () => {
    const w = await up();
    const past = new Date(Date.now() - 60_000).toISOString();
    await w.post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "quiet"] });
    await w.post("pm", { kind: "instruction", to: "quiet", body: "干一件", ack_by: past });
    await w.run();
    let b = await w.board();
    expect(b.needs_human.filter((c) => missingRoleOf(c.body)).map((c) => missingRoleOf(c.body)), "先让卡真的挂上去").toEqual(["quiet"]);
    // 它开口了：还是没读日志，但它显然活着
    await w.post("quiet", { kind: "note", body: "我在写" });
    b = await w.board();
    expect(b.presence.find((p) => p.actor === "quiet")!.status).toBe("deaf");
    expect(b.needs_human.filter((c) => missingRoleOf(c.body)), "卡是按此刻的状态活着的，不是按它被写下时的状态").toEqual([]);
  });
});
