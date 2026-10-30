/**
 * t-290 判据 5：**提前叫醒一个等待者的，只能是「有东西还没送到他眼前」。**
 *
 * 两条事实分开说，因为它们不是同一件事，而判据的那句话只覆盖了后者：
 *
 * ① **判据里点名的那一条，在本件之前就已经成立**（本支 86ec251 实测）：一个常年挂着 `untouched` 的角色，
 *    它的 `wait=2000` 长轮询老老实实挂了 2,003 ms，没有一起来就退出。所以这一条**改前改后都绿**——
 *    我把它写进来是为了钉住它别被这次改动弄坏，**不是因为它曾经红过**。外部 frontend 报的「守望等于没有」
 *    在我们这一侧不是由 `untouched` 造成的。
 *
 * ② **真的坏着的是另一条**：此前任何一条本项目事件都叫醒所有等待者。实测：别人发一条与 dev 无关的 note，
 *    dev 那条 `wait=5000` 的长轮询 206 ms 就回来了，回包里 `for_me=0`。这一条在改之前红、改之后绿。
 *
 * 代价写在 app.ts 那段注释里：不是发给他的事件要等这一轮 `wait` 到点才拿到，它们没有丢。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "t";
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let base = "";
const h = (actor: string) => ({ authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" });
const post = (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: h(actor), body: JSON.stringify(body) });
const get = (actor: string, q = "") => fetch(`${base}/events${q}`, { headers: h(actor) });
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

beforeEach(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0, maxWaitMs: 30_000 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
});
afterEach(() => new Promise<void>((r) => app.close(() => r())));

describe("t-290 判据 5 · 长轮询只为「还没送到他眼前的」提前醒", () => {
  it("别人发的一条无关事件不再叫醒他：挂满整轮，而不是 200 ms 就回来", async () => {
    const first = await (await get("dev")).json();
    const t0 = Date.now();
    const waiting = get("dev", `?after=${first.cursor}&wait=700`).then((r) => r.json());
    setTimeout(() => void post("qa", { kind: "note", body: "qa 自己的一句，与 dev 无关" }), 100);
    const r = await waiting;
    const ms = Date.now() - t0;
    expect(r.for_me, "本来就没有一条是给他的").toHaveLength(0);
    expect(ms, "挂满整轮（改之前这里是 ~200 ms）").toBeGreaterThanOrEqual(600);
  });

  it("真给他的一条照旧立刻叫醒他——这次改动不许把长轮询改成定时轮询", async () => {
    const first = await (await get("dev")).json();
    const t0 = Date.now();
    const waiting = get("dev", `?after=${first.cursor}&wait=5000`).then((r) => r.json());
    setTimeout(() => void post("pm", { kind: "instruction", to: "dev", body: "这一条是给 dev 的", ack_by: soon() }), 100);
    const r = await waiting;
    expect(Date.now() - t0, "远小于 wait").toBeLessThan(2_000);
    expect(r.for_me).toHaveLength(1);
  });

  it("那条无关事件一条都没丢：下一次拉取照旧全给", async () => {
    const first = await (await get("dev")).json();
    await post("qa", { kind: "note", body: "qa 的一句" });
    const next = await (await get("dev", `?after=${first.cursor}`)).json();
    expect(next.events.map((e: { body?: string }) => e.body)).toContain("qa 的一句");
  });

  it("常年挂着 untouched 的角色，守望不会一起来就退出（改前改后都绿，钉住别被弄坏）", async () => {
    await post("pm", { kind: "instruction", to: "dev", body: "一条发完就一直挂着没人动", ack_by: soon() });
    const first = await (await get("dev")).json();
    expect(first.owed.untouched, "它确实欠着一条").toHaveLength(1);
    const t0 = Date.now();
    const r = await (await get("dev", `?after=${first.cursor}&wait=700`)).json();
    expect(Date.now() - t0, "挂满整轮").toBeGreaterThanOrEqual(600);
    expect(r.events, "没有新东西").toHaveLength(0);
  });

  it("**自己那一次回包里「还没送到他眼前」必然是空的**，这是构造决定的，不是巧合", async () => {
    // `pull` 在回包之前就写了游标（app.ts 那段注释：owed 是在 pull 记下游标之后算的），
    // 所以这一批里的每一条当场就算「走过了」。判据 5 的唤醒条件因此等价于「刚落的这条是发给他的指令」——
    // 这个推导写在 app.ts 那段注释里，这条用例是它的实测那一半。
    await post("pm", { kind: "instruction", to: "dev", body: "一条给 dev 的", ack_by: soon() });
    const first = await (await get("dev")).json();
    expect(first.owed.untouched, "同一条当场就算送到了、还没动").toHaveLength(1);
    const t0 = Date.now();
    await get("dev", `?after=${first.cursor}&wait=700`);
    expect(Date.now() - t0, "它欠着，但那不是提前叫醒他的理由").toBeGreaterThanOrEqual(600);
  });
});
