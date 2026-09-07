/**
 * t-154 走一遍真接口：结构化事实的那一句话随牌桌出门，值仍在字段里给要挖的人；瘦身板也带这一句。
 * 时间一律相对 now。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, DEPLOYED_TASKS_KEY, BATCH_SURFACE, BATCH_PREFIX, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

describe("t-154 · 一条事实的一句话，走一遍接口", () => {
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) =>
    (await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const board = async (full: boolean) =>
    await (await fetch(`${base}/board${full ? "?full=1" : ""}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", "x-ateam-client": "2" } })).json() as Board;

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] });
    // 生产上真实存在的那一条：83 个任务 id 的那种
    await post("release", { kind: "reading", surface: "production", key: DEPLOYED_TASKS_KEY, value: { sha: "b3e3c53fbe19fac3c20dd0248751b517f1be93b5", contained: ["t-005", "t-004", "t-007"], not_contained: ["t-130", "t-131"], method: "git-ancestor（ateam release 用 git merge-base --is-ancestor 逐件测）" } });
    await post("release", { kind: "reading", surface: BATCH_SURFACE, key: `${BATCH_PREFIX}12`, value: { sha: "b23b325", base: "b3e3c53", contains: ["t-130", "t-131", "t-133"] } });
    await post("qa", { kind: "reading", surface: "production", key: "wait.cli", value: { n: 40, window: "03:02-03:44 UTC", seconds: { p50: 34.94 } } });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("声明过的说那一句，没声明的退化；值一个字都不在那一句里", async () => {
    const b = await board(true);
    const say = (key: string) => b.readings.find((r) => r.key === key)!.said!;
    expect(say(DEPLOYED_TASKS_KEY)).toMatchObject({ line: "这一版带上了 3 件", declared: true, said_elsewhere: true });
    expect(say(`${BATCH_PREFIX}12`)).toMatchObject({ line: "这一批装了 3 件", declared: true, said_elsewhere: true });
    expect(say("wait.cli")).toMatchObject({ declared: false, said_elsewhere: false });
    // t-180 · pd 09:17：时间在句首。夹具是刚落下的读数，所以这里说的是「刚刚」——改前它靠 core 那个
    // Math.max(m,1) 才说得出「1 分钟前」，梯子统一之后不到一分钟就是「刚刚」。
    expect(say("wait.cli").line).toMatch(/^production:wait\.cli，(刚刚|\d+ 分钟前)由 qa 记下$/);
    for (const s of ["b3e3c53fbe19fac3c20dd0248751b517f1be93b5", "t-005", "git-ancestor", "34.94", "03:02-03:44"]) {
      expect(JSON.stringify(b.readings.map((r) => r.said?.line ?? "")), `值「${s}」漏进了那一句`).not.toContain(s);
    }
  });

  it("值仍在字段里：要挖的人挖得到，只是不进那一行", async () => {
    const b = await board(true);
    expect((b.readings.find((r) => r.key === DEPLOYED_TASKS_KEY)!.value as { contained: string[] }).contained).toEqual(["t-005", "t-004", "t-007"]);
  });

  it("瘦身板也带这一句——首屏要说的正是它", async () => {
    const slim = await board(false);
    expect(slim.readings.find((r) => r.key === DEPLOYED_TASKS_KEY)!.said!.line).toBe("这一版带上了 3 件");
  });
});
