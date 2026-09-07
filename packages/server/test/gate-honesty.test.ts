/**
 * t-149 过一遍真接口：判决是 POST 上去的字段（不是散文），那句实话只在完整板上，首屏与卡里都没有它。
 * 时间一律相对 now。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, gateFixKey, PROJECT_SURFACE, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

describe("t-149 · 闸的实话走一遍接口", () => {
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { message?: string } };
  };
  // x-ateam-client: 2 是「我读得懂瘦身板」；不带这个头的旧客户端拿到的仍是完整板（t-070/t-080）
  const board = async (full: boolean) =>
    await (await fetch(`${base}/board${full ? "?full=1" : ""}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", "x-ateam-client": "2" } })).json() as Board;

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: PROJECT_SURFACE, key: "roles", value: ["pm", "dev", "frontend", "qa"] });
    for (const [id, who] of [["t-a", "dev"], ["t-b", "frontend"]] as const) {
      await post("pm", { kind: "task", op: "create", task: id, title: `题 ${id}`, criteria: ["能用"] , no_human_impact: true});
      await post(who, { kind: "task", op: "claim", task: id, touches: ["packages/core/src/board.ts"] });
    }
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("没判过：完整板上也没有那句话", async () => {
    expect((await board(true)).gate_honesty).toEqual([]);
  });

  it("判决只收声明过的值，服务当场拒绝并说出出路", async () => {
    const bad = await post("pm", { kind: "task", op: "seam", tasks: ["t-a", "t-b"], resolution: "误报", verdict: "假" });
    expect(bad.status).toBe(409);
    expect(bad.body.message).toContain("real | false");
  });

  it("判为误报 + 修法还没上生产：完整板上出现那句话，首屏没有，也不是给人的卡", async () => {
    expect((await post("pm", { kind: "task", op: "seam", tasks: ["t-a", "t-b"], resolution: "两侧其实没碰同一处：闸按合并后的累计 diff 算触点", verdict: "false", missed: true })).status).toBe(201);
    await post("pm", { kind: "task", op: "create", task: "t-fix", title: "按共同祖先算触点", criteria: ["每一侧只算自己改的"] , no_human_impact: true});
    await post("pm", { kind: "reading", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" });

    const full = await board(true);
    expect(full.gate_honesty).toHaveLength(1);
    const [g] = full.gate_honesty;
    expect(g).toMatchObject({ gate: "seam", reported: 1, judged: 1, false_positives: 1, missed: 1, unjudged: 0 });
    expect(g.line).toContain("修法在 t-fix");
    expect(JSON.stringify(full.needs_human)).not.toContain("这道闸");

    const slim = await board(false);
    expect(slim.gate_honesty).toEqual([]);
    expect(slim.omitted.some((x) => x.startsWith("gate_honesty"))).toBe(true);
  });
});
