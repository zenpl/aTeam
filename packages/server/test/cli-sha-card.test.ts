/**
 * t-257：**「你手上的命令行旧了」这句提醒只在已经装了它的地方出声——最旧的那个人恰好听不到。**
 *
 * 我量过（读数 repo:t257.server.knows="nothing"）：旧 CLI 与新 CLI 发给服务端的头逐字相同，
 * 两支唯一的差别是新的那支多发一次 POST 自报构建 sha（t-211 的 recordCliSha）。所以服务端知道
 * 一个节点是哪一版的唯一来源就是它自报，而旧节点恰恰不自报。这里不猜它多旧（判据 3），
 * 只说「我说不出你是哪一版」，并按这一次带不带 wait 给出分得开成因的下一步。
 *
 * 这张卡是一条普通指令，所以一个不含 t-211 的 CLI 照样把它印出来——判据 1 要的就是这个。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, CLI_SHA_UNKNOWN_PREFIX, NODE_SURFACE, CLI_SHA_KEY } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "t";
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const pull = async (actor: string, q = "") => (await fetch(`${base}/events${q}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } })).json();
const cards = (r: { events: { body?: string }[] }) => r.events.filter((e) => e.body?.startsWith(CLI_SHA_UNKNOWN_PREFIX)).map((e) => e.body!);

beforeEach(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
});
afterEach(() => new Promise<void>((r) => app.close(() => r())));

describe("t-257 · 说不出你是哪一版的那张卡", () => {
  it("第一次拉取（after 为空）不发：一个刚 join 完、还没跑过第一条 sync 的新节点不该先挨一句", async () => {
    expect(cards(await pull("qa"))).toEqual([]);
  });

  it("第二次拉取、不带 wait ⇒ 发普通 sync 那一句；它不提「偶尔跑一次 sync」——那是叫人修没坏的东西", async () => {
    const first = await pull("qa");
    const got = cards(await pull("qa", `?after=${first.cursor}`));
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("你这一次跑的是普通 sync");
    expect(got[0]).toContain("早于 t-211");
    expect(got[0]).toContain("自报在你那儿失败了");
    expect(got[0], "③ 已被排除，不该再叫它去 sync").not.toContain("偶尔跑一次");
  });

  it("第二次拉取、带 wait ⇒ 发长轮询那一句，三种成因都说，且包含「偶尔跑一次 sync」", async () => {
    const first = await pull("qa");
    const got = cards(await pull("qa", `?after=${first.cursor}&wait=0`));   // wait=0 仍是不带
    expect(got[0]).toContain("你这一次跑的是普通 sync");
    const app2 = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app2.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(app2.address() as AddressInfo).port}`;
    await fetch(`${b2}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }) });
    const f = await (await fetch(`${b2}/events`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json();
    const r2 = await (await fetch(`${b2}/events?after=${f.cursor}&wait=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json();
    const poll = cards(r2);
    expect(poll).toHaveLength(1);
    expect(poll[0]).toContain("长轮询");
    expect(poll[0]).toContain("偶尔跑一次 ateam sync");
    expect(poll[0]).toContain("早于 t-211");
    await new Promise<void>((r) => app2.close(() => r()));
  });

  it("只发一次：发过之后再拉几次都不再来——说不出就是说不出，催第二遍催不出任何东西", async () => {
    const first = await pull("qa");
    expect(cards(await pull("qa", `?after=${first.cursor}`))).toHaveLength(1);
    const second = await pull("qa", `?after=${first.cursor}`);
    expect(cards(await pull("qa", `?after=${second.cursor}`))).toEqual([]);
    expect(cards(await pull("qa", `?after=${second.cursor}`))).toEqual([]);
  });

  it("自报过的节点一张都不发：说得出就没有这张卡的意义", async () => {
    await post("dev", { kind: "reading", surface: NODE_SURFACE, key: `dev:${CLI_SHA_KEY}`, value: "abc1234def", method: "自报" });
    const first = await pull("dev");
    expect(cards(await pull("dev", `?after=${first.cursor}`))).toEqual([]);
  });

  it("不是这个项目声明的角色：一张都不发", async () => {
    const first = await pull("stranger");
    expect(cards(await pull("stranger", `?after=${first.cursor}`))).toEqual([]);
  });

  it("人与服务自己根本拉不动（另一道更早的闸），所以这张卡与它们无关", async () => {
    for (const who of ["human", "ateam"]) {
      const r = await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": who } });
      expect(r.status, who).toBe(403);
    }
  });
});
