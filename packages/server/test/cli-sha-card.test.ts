/**
 * t-257：**「你手上的命令行旧了」这句提醒只在已经装了它的地方出声——最旧的那个人恰好听不到。**
 *
 * 量出来的事实（读数 repo:t257.server.knows="nothing"）：旧 CLI 与新 CLI 发给服务端的头逐字相同，
 * 两支唯一的差别是新的那支多发一次 POST 自报构建 sha（t-211 的 recordCliSha）。所以服务端知道一个节点
 * 是哪一版的唯一来源就是它自报，而旧节点恰恰不自报。这里不猜它多旧（判据 3），只说「我说不出你是哪一版」。
 *
 * 分成两半：**信号在拉取时记进游标**（零新增写入，不是日志事件），**卡在牌桌那条路上发**（pm 17:02 的裁定）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, CLI_SHA_UNKNOWN_PREFIX, CLI_SHA_CARD_GRACE_MS, cliShaUnknownCard, reduce, NODE_SURFACE, CLI_SHA_KEY } from "@ateam/core";
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

describe("t-257 · 那张卡：说哪一句，什么时候不说", () => {
  const at = (ms: number) => new Date(Date.now() + ms);
  const bodyFor = async (role: string) => cliShaUnknownCard(reduce(await store.read()), role, at(CLI_SHA_CARD_GRACE_MS + 60_000));

  it("有过普通拉取 ⇒ 排除「从没跑过 sync」，那一句里不该出现「偶尔跑一次」", async () => {
    await pull("dev");
    const body = await bodyFor("dev");
    expect(body).toContain(CLI_SHA_UNKNOWN_PREFIX);
    expect(body).toContain("你这一次跑的是普通 sync");
    expect(body).toContain("早于 t-211");
    expect(body, "③ 已排除，不该叫它去修没坏的东西").not.toContain("偶尔跑一次");
  });

  it("只长轮询过 ⇒ 三种成因都说，并且含「偶尔跑一次 ateam sync」", async () => {
    await post("qa", { kind: "note", body: "我在干活" });     // 有过自己的事件，宽限从它算起
    await pull("qa", "?wait=1");
    const body = await bodyFor("qa");
    expect(body).toContain("长轮询");
    expect(body).toContain("偶尔跑一次 ateam sync");
    expect(body).toContain("早于 t-211");
  });

  it("宽限期内不说：刚 join 完、还没跑过第一条 sync 的新节点不该先挨一句", async () => {
    await pull("dev");
    const s = reduce(await store.read());
    expect(cliShaUnknownCard(s, "dev", new Date()), "刚刚才拉过").toBeNull();
    expect(cliShaUnknownCard(s, "dev", at(CLI_SHA_CARD_GRACE_MS + 60_000)), "过了宽限才说").toBeTruthy();
  });

  it("自报过的、没拉过的、不是角色的、服务自己，都不说", async () => {
    await pull("dev");
    await post("dev", { kind: "reading", surface: NODE_SURFACE, key: `dev:${CLI_SHA_KEY}`, value: "abc1234def", method: "自报" });
    expect(await bodyFor("dev"), "说得出就没有这张卡的意义").toBeNull();
    expect(await bodyFor("pm"), "从没拉过").toBeNull();
    expect(await bodyFor("stranger"), "不是这个项目的角色").toBeNull();
    expect(await bodyFor("ateam"), "服务自己").toBeNull();
  });

  it("牌桌那条路真的会发它，而且只发一次——一个不含 t-211 的 CLI 下一次拉取就收得到", async () => {
    await pull("dev");                                   // 一次普通拉取，信号落进游标
    const board = (who: string) => fetch(`${base}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": who } });
    await board("pm");
    const cards = () => [...store.events].filter((e) => (e as { body?: string }).body?.startsWith(CLI_SHA_UNKNOWN_PREFIX));
    expect(cards(), "宽限期内，一张都没有").toHaveLength(0);

    // 用服务端自己的测试钩子把它的钟往前拨过宽限期——不是改夹具，是让「过了很久」这件事真的发生
    await fetch(`${base}/_test/clock`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ offset_ms: CLI_SHA_CARD_GRACE_MS + 60_000 }) });
    await board("pm");
    expect(cards(), "过了宽限，牌桌那一路发了一张").toHaveLength(1);
    expect((cards()[0] as { to?: string }).to, "发给那个节点本人，不是发给人").toBe("dev");
    expect((cards()[0] as { body: string }).body).toContain("你这一次跑的是普通 sync");

    await board("pm");
    await board("qa");
    expect(cards(), "再看几次牌桌也不会有第二张").toHaveLength(1);
  });
});
