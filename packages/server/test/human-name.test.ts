/**
 * t-216（qa 16:46 抓到的）：**新加的 `human` 参数只有用例在传。**
 *
 * 折叠那一侧要知道「人叫什么」，才分得开「本人自报／human 发的（当场生效）」与「第三方对一条署着 human 的
 * 事件的声明（要两个人）」。它有默认值 `"human"`，而这个项目的人恰好就叫 human——**于是没接线也看不出来**。
 * qa 把名字换成别的一试，本人自报那条路当场降成一票。
 *
 * 这份用例把人叫作 `boss`，走真的服务：**默认值再也藏不住一根没接的线。**
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const BOSS = "boss";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { id?: string; error?: string; message?: string } };
};
const board = async () => (await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json()) as {
  disowned: { of: string }[]; contested: { of: string; by: string[] }[];
};

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: BOSS, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-216 · 人不叫 human 的时候，那条线也接着", () => {
  it("**本人自报当场生效**——这一条在没接线的版本上会被降成一票", async () => {
    const note = await post("dev", { kind: "note", body: "dev 自己写的" });
    const d = await post("dev", { kind: "disown", of: note.body.id, reason: "手滑落的，不是我要说的话" });
    expect(d.status).toBe(201);
    const b = await board();
    expect(b.disowned.some((x) => x.of === note.body.id), "本人自报没有当场生效：human 那根线没接到折叠里").toBe(true);
    expect(b.contested.some((x) => x.of === note.body.id)).toBe(false);
  });

  it("署着 boss 的事件：一个角色声明只进争议，两个才生效", async () => {
    const mis = await post(BOSS, { kind: "note", body: "以 boss 名义落下的一条" });
    expect((await post("qa", { kind: "disown", of: mis.body.id, reason: "这不是 boss 写的，是我误落的" })).status).toBe(201);
    let b = await board();
    expect(b.contested.find((x) => x.of === mis.body.id)?.by).toEqual(["qa"]);
    expect(b.disowned.some((x) => x.of === mis.body.id)).toBe(false);

    expect((await post("release", { kind: "disown", of: mis.body.id, reason: "我也认为不是 boss 写的" })).status).toBe(201);
    b = await board();
    expect(b.disowned.some((x) => x.of === mis.body.id)).toBe(true);
    expect(b.contested.some((x) => x.of === mis.body.id)).toBe(false);
  });

  it("boss 本人一个人就够", async () => {
    const mine = await post(BOSS, { kind: "note", body: "boss 又写了一条" });
    expect((await post(BOSS, { kind: "disown", of: mine.body.id, reason: "写错了" })).status).toBe(201);
    expect((await board()).disowned.some((x) => x.of === mine.body.id)).toBe(true);
  });

  it("不是 boss 署名的事件，第三方仍然一个字都动不了", async () => {
    const note = await post("dev", { kind: "note", body: "dev 的另一条" });
    const r = await post("qa", { kind: "disown", of: note.body.id, reason: "我觉得不是 dev 写的" });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("只能由本人自报");
  });
});
