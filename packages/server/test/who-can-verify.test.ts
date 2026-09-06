/**
 * t-101: a verify refused over the API carries its way out — who, in this project, could do it instead.
 * The list is computed from the same separation rules that just refused; nobody maintains a second copy.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as { error?: string; rule?: string; message?: string } };
};

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

const done = async (id: string) => {
  await post("pm", { kind: "task", op: "create", task: id, title: "题", criteria: ["能用"] });
  await post("dev", { kind: "task", op: "claim", task: id, touches: [id] });
  await post("dev", { kind: "task", op: "done", task: id, evidence: "abc1234: 做完了" });
};

describe("t-101 · 409 on verify says who can do it instead", () => {
  it("names the qualifying roles, keeps the rule name, and follows project:roles as it changes", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pd", "pm", "dev", "frontend", "qa"] });
    await done("t-a");
    const r = await post("dev", { kind: "task", op: "verify", task: "t-a", surface: "repo", pass: true });
    expect(r.status).toBe(409);
    expect(r.body.rule).toBe("verify");                              // 判据 4
    expect(r.body.message).toContain("可以由谁来落：pd、frontend、qa");
    // 只剩一个：qa 判过 pass 之后自己来推翻，被拒时直接被告知谁能落
    await post("pd", { kind: "task", op: "criteria", task: "t-a", add: ["文案按定稿"] });
    await post("qa", { kind: "task", op: "verify", task: "t-a", surface: "repo", pass: true, evidence: "看过了" });
    const one = await post("qa", { kind: "task", op: "verify", task: "t-a", surface: "repo", pass: false, evidence: "漏了一条" });
    expect(one.status).toBe(409);
    expect(one.body.message).toContain("可以由谁来落：frontend");
  });

  it("a project with no qualifying third party is told so, and why, instead of an empty list", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev"] });
    await done("t-b");
    const r = await post("dev", { kind: "task", op: "verify", task: "t-b", surface: "repo", pass: true });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("本项目没有合格的第三方：pm 写了判据；dev 是 owner");
    expect(r.body.message).toContain(`让 ${HUMAN} 亲自判`);
    expect(r.body.message).not.toMatch(/可以由谁来落/);
  });
});
