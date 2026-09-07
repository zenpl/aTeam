/**
 * t-151 走一遍真接口：交活说不出对人的影响，服务当场 409 并说出规则名与两条出路。
 * 时间一律相对 now。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, NO_HUMAN_IMPACT } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

describe("t-151 · 交活要说一句对人的影响", () => {
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { rule?: string; message?: string } };
  };
  const task = async (id: string) => {
    await post("pm", { kind: "task", op: "create", task: id, title: `题 ${id}`, criteria: ["能用"] });
    await post("dev", { kind: "task", op: "claim", task: id, touches: [id] });
  };

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("两句都没有：409，规则名 done，两条出路都在话里", async () => {
    await task("t-1");
    const r = await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "abc1234" });
    expect(r.status).toBe(409);
    expect(r.body.rule).toBe("done");
    expect(r.body.message).toContain("--shows");
    expect(r.body.message).toContain("--no-human-impact");
    expect(r.body.message).toContain(NO_HUMAN_IMPACT);
  });

  it("补上任一句就过，任务真的走到 done", async () => {
    expect((await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true })).status).toBe(201);
    await task("t-2");
    expect((await post("dev", { kind: "task", op: "done", task: "t-2", evidence: "def5678", shows: "牌桌第一行现在是版本号" })).status).toBe(201);
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json() as { tasks: Record<string, { id: string; shows?: string }[]> };
    const done = Object.values(b.tasks).flat();
    expect(done.find((t) => t.id === "t-2")!.shows).toBe("牌桌第一行现在是版本号");
    expect(done.find((t) => t.id === "t-1")!.shows).toBeUndefined();
  });

  it("no_human_impact 带错类型也被挡下，说清它该是什么", async () => {
    await task("t-3");
    const r = await post("dev", { kind: "task", op: "done", task: "t-3", evidence: "abc1234", no_human_impact: "是" });
    expect(r.status).toBe(409);
    expect(r.body.rule).toBe("shape");
    expect(r.body.message).toContain("no_human_impact");
  });
});

describe("t-151 · pd 07:49：碰了人看得到的东西却说没变，接口上也拦得住", () => {
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { rule?: string; message?: string } };
  };

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
    await post("pm", { kind: "task", op: "create", task: "t-9", title: "改一个词", criteria: ["能用"] });
    await post("dev", { kind: "task", op: "claim", task: "t-9", touches: ["packages/server/src/i18n.ts"] });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("409，列出它认定的那一处，并给出出路与反驳的办法", async () => {
    const r = await post("dev", { kind: "task", op: "done", task: "t-9", evidence: "abc1234", no_human_impact: true });
    expect(r.status).toBe(409);
    expect(r.body.rule).toBe("done");
    expect(r.body.message).toContain("packages/server/src/i18n.ts");
    expect(r.body.message).toContain(NO_HUMAN_IMPACT);
    expect(r.body.message).toContain("--shows");
    expect(r.body.message).toContain("不对就改触点");   // t-170 判据 2：人要能反驳一个看得见的判断
  });

  it("t-170：人可见文件里的内部符号不再被拦（t-165 那次的形状），接口上也过", async () => {
    await post("pm", { kind: "task", op: "create", task: "t-10", title: "删一段死代码", criteria: ["能用"] });
    await post("dev", { kind: "task", op: "claim", task: "t-10", touches: ["packages/server/src/html.ts#justDeferred"] });
    expect((await post("dev", { kind: "task", op: "done", task: "t-10", evidence: "abc1234", no_human_impact: true })).status).toBe(201);
  });

  it("补一句人能看到什么就过", async () => {
    expect((await post("dev", { kind: "task", op: "done", task: "t-9", evidence: "abc1234", shows: "「逾期」这一节现在叫「到期没人选」" })).status).toBe(201);
  });
});
