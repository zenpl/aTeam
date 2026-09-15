/**
 * t-257（pm 17:11 裁定走 E 之后的范围）：**本件只落那个信号，不发任何卡。**
 *
 * 起因量出来的事实（读数 repo:t257.server.knows="nothing"）：旧 CLI 与新 CLI 发给服务端的头逐字相同，
 * 两支唯一的差别是新的那支多发一次 POST 自报构建 sha（t-211 的 recordCliSha）——所以服务端知道一个节点
 * 是哪一版的唯一来源就是它自报，而旧节点恰恰不自报。要对旧节点说话，先得有个能分开成因的信号。
 *
 * 这个信号是「**这个节点有没有过一次不带 wait 的拉取**」：`sync` 默认不带、`watch` 恒带、而 `sync --wait`
 * 也带，所以**带了分不出是哪一种，不带则一定是一次普通 sync**（单向，只用来排除「从没跑过 sync」）。
 * 记在游标那一行上：**它本来每次拉取就写，所以这是零新增写入**；而它不是日志事件，`built ≡ served`（t-062）
 * 因此一个字不动。**发卡那一半在 t-278，此刻 blocked——本件做完，没有任何旧节点会收到任何东西。**
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, reduce } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "t";
let store: MemoryStore;
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const pull = async (actor: string, q = "") => (await fetch(`${base}/events${q}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } })).json();

beforeEach(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0, testHooks: true });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
});
afterEach(() => new Promise<void>((r) => app.close(() => r())));

describe("t-257 · 那个信号：这个节点有没有过一次普通拉取", () => {
  it("不带 wait 的拉取记下 plain_pull_at；带 wait 的不记", async () => {
    await pull("dev");
    expect(store.cursors.get("dev")?.plain_pull_at, "不带 wait ⇒ 记").toBeTruthy();
    await pull("qa", "?wait=1");
    expect(store.cursors.get("qa")?.plain_pull_at, "带 wait ⇒ 不记").toBeUndefined();
  });

  it("记过之后，一次长轮询不许把它抹掉——这是「有没有过」，不是「这一次是不是」", async () => {
    const first = await pull("dev");
    const had = store.cursors.get("dev")!.plain_pull_at!;
    await pull("dev", `?after=${first.cursor}&wait=1`);
    expect(store.cursors.get("dev")?.plain_pull_at, "旧值保留").toBe(had);
    expect(store.cursors.get("dev")?.at, "而 at 照旧往前走").not.toBe(had);
  });

  it("它进得了 presence，而且只往前", async () => {
    await pull("dev");
    const s = reduce(await store.read());
    expect(s.presence.get("dev")?.plain_pull_at).toBe(store.cursors.get("dev")!.plain_pull_at);
    expect(s.presence.get("qa")?.plain_pull_at, "从没拉过的那个：没有就是没有").toBeUndefined();
  });
});
