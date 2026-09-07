/**
 * t-109 (M4): a malformed event comes back as a refusal, never as a crash. qa 00:26 wrote a `task seam` event with
 * `a`/`b` instead of `tasks` and got a 500 — which tells the caller the service is broken when in fact the service is
 * working and they mistyped a field. Reproduced on four shas, so this was never new.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { rule?: string; message?: string } };
};

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-109 · a wrong shape is a refusal, not a crash", () => {
  it("qa 00:26 的那条事件：seam 写成 a/b 而不是 tasks", async () => {
    const r = await post("pm", { kind: "task", op: "seam", a: "t-A", b: "t-B", resolution: "dev 先落" });
    expect(r.status).toBe(409);                       // 不是 500
    expect(r.body.rule).toBe("shape");
    expect(r.body.message).toContain("task:seam 要带 tasks");
    expect(r.body.message).toContain("这条没带它");
    expect(r.body.message).toContain("tasks、resolution");   // 该有哪些字段，一次说清
  });

  it("每一种事件缺必填字段都是 4xx，并点名那个字段", async () => {
    const cases: [unknown, string][] = [
      [{ kind: "reading", value: 1 }, "reading 要带 key"],
      [{ kind: "reading", key: "x", value: 1 }, "reading 要带 surface"],
      [{ kind: "instruction", body: "做这个" }, "instruction 要带 to"],
      [{ kind: "instruction", to: "dev" }, "instruction 要带 body"],
      [{ kind: "ack" }, "ack 要带 of"],
      [{ kind: "untell", of: "01X" }, "untell 要带 reason"],
      [{ kind: "note" }, "note 要带 body"],
      [{ kind: "task", op: "create", task: "t-1", criteria: ["x"] }, "task:create 要带 title"],
      [{ kind: "task", op: "create", task: "t-1", title: "题" }, "task:create 要带 criteria"],
      [{ kind: "task", op: "label", task: "t-1" }, "task:label 要带 label"],
      [{ kind: "task", op: "claim", task: "t-1" }, "task:claim 要带 touches"],
      [{ kind: "task", op: "done" , no_human_impact: true}, "task:done 要带 task"],
      [{ kind: "task", op: "verify", task: "t-1", pass: true }, "task:verify 要带 surface"],
      [{ kind: "task", op: "verify", task: "t-1", surface: "repo" }, "task:verify 要带 pass"],
      [{ kind: "task", op: "block", task: "t-1" }, "task:block 要带 on"],
      [{ kind: "task", op: "withdraw", task: "t-1" }, "task:withdraw 要带 reason"],
      [{ kind: "task", op: "obsolete", task: "t-1" }, "task:obsolete 要带 decision"],
      [{ kind: "task", op: "reopen", task: "t-1" }, "task:reopen 要带 reason"],
      [{ kind: "task", op: "criteria", task: "t-1" }, "task:criteria 要带 add"],
      [{ kind: "task", op: "seam", tasks: ["t-1", "t-2"] }, "task:seam 要带 resolution"],
    ];
    for (const [body, says] of cases) {
      const r = await post("pm", body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.rule, JSON.stringify(body)).toBe("shape");
      expect(r.body.message, JSON.stringify(body)).toContain(says);
    }
  });

  it("类型不对读起来和缺了一样，也一律 4xx：数组写成字符串、布尔写成字符串、嵌套字段写歪", async () => {
    const cases: [unknown, string][] = [
      [{ kind: "task", op: "claim", task: "t-1", touches: "a.ts" }, "task:claim 要带 touches（一个字符串数组）"],
      [{ kind: "task", op: "verify", task: "t-1", surface: "repo", pass: "true" }, "task:verify 要带 pass（true 或 false）"],
      [{ kind: "task", op: "seam", tasks: ["t-1"], resolution: "x" }, "task:seam 要带 tasks"],
      [{ kind: "task", op: "seam", tasks: "t-1,t-2", resolution: "x" }, "task:seam 要带 tasks"],
      [{ kind: "task", op: "create", task: "t-1", title: "题", criteria: "能用" }, "task:create 要带 criteria（一个字符串数组）"],
      [{ kind: "note", body: "x", decides: { of: "01X" } }, "note 的 decides 要是"],
      [{ kind: "note", body: "x", decides: "01X" }, "note 的 decides 要是"],
      [{ kind: "note", body: "x", refs: "01X" }, "refs 要是一个字符串数组"],
      [{ kind: "note", body: "x", refs: 7 }, "refs 要是一个字符串数组"],   // 关掉形状闸时这条也是 TypeError（number is not iterable）
      [{ kind: "task", op: "done", task: "t-1", touches: "a.ts" , no_human_impact: true}, "task:done 的 touches 可以不带"],
      [{ kind: "instruction", to: "dev", body: "x", options: "A" }, "instruction 的 options 可以不带"],
      [{ kind: "task", task: "t-1" }, "task 事件要带 op"],
      [{ kind: "task", op: "frobnicate", task: "t-1" }, "不是其中之一"],
      [{ kind: "wat", body: "x" }, "不是事件种类之一"],
    ];
    for (const [body, says] of cases) {
      const r = await post("pm", body);
      expect(r.status, JSON.stringify(body)).toBe(409);
      expect(r.body.message, JSON.stringify(body)).toContain(says);
    }
  });

  it("合法事件一字不变地照走（判据 3 的另一半：不是靠把所有东西都拒掉换来的）", async () => {
    expect((await post("pm", { kind: "task", op: "create", task: "t-1", title: "题", criteria: ["能用"] })).status).toBe(201);
    expect((await post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["a.ts"] })).status).toBe(201);
    expect((await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "abc1234" , no_human_impact: true})).status).toBe(201);
    expect((await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: true })).status).toBe(201);
    expect((await post("pm", { kind: "note", body: "记一笔" })).status).toBe(201);
    expect((await post("pm", { kind: "reading", key: "k", surface: "project", value: { any: "shape" } })).status).toBe(201);
  });
});

describe("t-127 · 键里说了两遍表面名，服务当场拒绝", () => {
  it("409、点名规则、印出会落成什么和该怎么写；日志里不留这一条", async () => {
    const r = await post("pm", { kind: "reading", surface: "project", key: "project:roles", value: ["pm", "dev"] });
    expect(r.status).toBe(409);                       // 不是 201，也不是 500
    expect(r.body.rule).toBe("reading");
    expect(r.body.message).toContain("project:project:roles");        // 会落成什么
    expect(r.body.message).toContain("--surface project <键> roles"); // 该怎么写
    const log = await (await fetch(`${base}/log`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json() as { events: { key?: string }[] };
    expect(log.events.some((e) => e.key === "project:roles")).toBe(false);
  });

  it("不带前缀照写；键里本来就有冒号的（node:release:能力）不受影响", async () => {
    expect((await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] })).status).toBe(201);
    expect((await post("release", { kind: "reading", surface: "node", key: "release:能力", value: ["R9"] })).status).toBe(201);
  });
});
