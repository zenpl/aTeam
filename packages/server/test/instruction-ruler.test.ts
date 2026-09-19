/**
 * t-287：**把长度收成一把尺（码点），而边界会动——这里在真路上量它动了多少。**
 *
 * 前面那份 `core/test/instruction-length.test.ts` 问的是规则函数；这一份问的是**真服务**：
 * 真 HTTP、真 `createApp`、真 409/201。按 t-285 那一课，函数层与真路是两格，不可互相顶替。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, INSTRUCTION_MAX_CHARS, followUps, reduce, validate } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
let app: ReturnType<typeof createApp>;
let base = "";
const tell = (body: string) =>
  fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "dev", "content-type": "application/json" },
    body: JSON.stringify({ kind: "instruction", to: "pm", body, ack_by: new Date(Date.now() + 600_000).toISOString() }),
  });
const rep = (unit: string, n: number) => [...unit.repeat(Math.ceil(n / [...unit].length))].slice(0, n).join("");
const points = (s: string) => [...s].length;

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-287 判据 3、4 · 真路：边界动的恰好是含代理对的那些", () => {
  it("280 码点、281 UTF-16 单元（含代理对）⇒ **真服务收下它**（t-286 那版会回 409 说 281）", async () => {
    const body = "a".repeat(INSTRUCTION_MAX_CHARS - 1) + "👍";
    expect(points(body)).toBe(INSTRUCTION_MAX_CHARS);
    expect(body.length, "按旧尺是 281").toBe(INSTRUCTION_MAX_CHARS + 1);
    const r = await tell(body);
    expect(r.status, "改后：201").toBe(201);
  });

  it("281 码点（含代理对）⇒ 照旧拒，而且报的是码点数", async () => {
    const body = "a".repeat(INSTRUCTION_MAX_CHARS) + "👍";
    const r = await tell(body);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toContain(`body is ${INSTRUCTION_MAX_CHARS + 1} chars`);
  });

  it("纯 BMP 一条也不受影响：280 过、281 拒，两把尺本来就同一个数", async () => {
    for (const unit of ["a", "中"]) {
      const at = rep(unit, INSTRUCTION_MAX_CHARS);
      expect(points(at)).toBe(at.length);
      expect((await tell(at)).status, `${unit}×280`).toBe(201);
      const over = rep(unit, INSTRUCTION_MAX_CHARS + 1);
      expect((await tell(over)).status, `${unit}×281`).toBe(409);
    }
  });
});

/**
 * 判据 5：`verifyflow.ts` 拼自动卡时，`room` 与 `head()` 的截断**本来就按码点算**。
 * 收成码点之后它与闸自动一致——这条用例就是那句话的证据：让它拼一张带代理对的、长到贴着上限的卡，
 * 然后把拼出来的正文**交给闸自己判**。
 */
describe("t-287 判据 5 · verifyflow 拼出来的卡，自己过得了闸", () => {
  it("标题与证据都塞满 emoji，拼出来的那条 instruction 仍在上限之内", () => {
    const at = (n: number) => new Date(Date.parse("2026-09-19T00:00:00Z") + n * 1000).toISOString();
    const events = [
      // 没有验收角色的项目：那条 ask 只在这种项目里生成（`projectRoles` 缺省是含 qa 的，所以要显式声明一次）
      { id: "01M2X0000000000000000000A0", kind: "reading", actor: "pm", at: at(0), key: "roles", value: ["pm", "dev"], surface: "project" },
      { id: "01M2X0000000000000000000A1", kind: "task", op: "create", actor: "pm", at: at(1), task: "t-999", title: rep("好👍", 90), criteria: ["一条"], no_human_impact: true },
      { id: "01M2X0000000000000000000A2", kind: "task", op: "claim", actor: "dev", at: at(2), task: "t-999", touches: ["a.ts"] },
      { id: "01M2X0000000000000000000A3", kind: "task", op: "done", actor: "dev", at: at(3), task: "t-999", evidence: rep("证👍", 400), shows: "一句话" },
    ] as never[];
    const s = reduce({ events, cursors: [], deliveries: [] }, new Date(Date.parse("2026-09-19T01:00:00Z")), "human");
    const out = followUps(s, events[3], "human", new Date(Date.parse("2026-09-19T01:00:00Z")));
    const ask = out.find((e) => (e as { kind: string }).kind === "instruction") as { body: string } | undefined;
    expect(ask, "没有验收角色的项目里，done 之后该问人一句").toBeTruthy();
    expect(points(ask!.body), "**拼出来的正文得在上限之内**").toBeLessThanOrEqual(INSTRUCTION_MAX_CHARS);
    expect(ask!.body, "样本确实带代理对").toContain("👍");
    // 最硬的一条：把它交给闸自己判，而不是我再数一遍
    expect(() => validate(s, ask as never, "human"), "把它交给闸自己判，而不是我再数一遍").not.toThrow();
  });
});
