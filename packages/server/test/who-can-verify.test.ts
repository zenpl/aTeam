/**
 * t-101 + t-104: a verify refused over the API carries its way out. Since t-104 that way out is about **pass** only:
 * pass needs R6 and independence, so a refusal names who has both; fail is open to everyone and never needs a list.
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

const done = async (id: string, owner = "dev") => {
  await post("pm", { kind: "task", op: "create", task: id, title: "题", criteria: ["能用", "有测试"] });
  await post(owner, { kind: "task", op: "claim", task: id, touches: [id] });
  await post(owner, { kind: "task", op: "done", task: id, evidence: "abc1234: 做完了" });
};

describe("t-101/t-104 · 409 on a pass says who could pass instead", () => {
  it("names the R6 holders, keeps the rule name, and follows project:roles as it changes", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: { pd: ["R2"], pm: ["R1"], dev: ["R5"], frontend: ["R5", "R6"], qa: ["R6"] } });
    await done("t-a");
    const r = await post("dev", { kind: "task", op: "verify", task: "t-a", surface: "repo", pass: true });
    expect(r.status).toBe(409);
    expect(r.body.rule).toBe("verify");
    expect(r.body.message).toContain("可以由谁来落 pass：frontend、qa");
    // 不持 R6 的角色也被挡下，并被告知 fail 不受此限
    const noR6 = await post("pd", { kind: "task", op: "verify", task: "t-a", surface: "repo", pass: true });
    expect(noR6.body.message).toContain("pd 不持 R6 验收职责，落不了 pass");
    expect(noR6.body.message).toContain("fail 不受此限，谁都能落");
    // 名单跟着 project:roles 走：frontend 交出 R6 后就只剩 qa
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: { pd: ["R2"], pm: ["R1"], dev: ["R5"], frontend: ["R5"], qa: ["R6"] } });
    const one = await post("dev", { kind: "task", op: "verify", task: "t-a", surface: "repo", pass: true });
    expect(one.body.message).toContain("可以由谁来落 pass：qa");
  });

  it("t-088 的活样本：判过 pass 的人自己就能落 fail，只是证据要指名哪一条判据", async () => {
    await done("t-b");
    await post("qa", { kind: "task", op: "verify", task: "t-b", surface: "repo", pass: true, evidence: "看过了" });
    const vague = await post("qa", { kind: "task", op: "verify", task: "t-b", surface: "repo", pass: false, evidence: "我漏验了" });
    expect(vague.status).toBe(409);
    expect(vague.body.message).toContain("证据要指名推翻的是哪一条判据");
    const ok = await post("qa", { kind: "task", op: "verify", task: "t-b", surface: "repo", pass: false, evidence: "判据 2 没验：没有测试覆盖空输入" });
    expect(ok.status).toBe(201);
    // ②：翻完自己不能再自己翻回来
    const back = await post("qa", { kind: "task", op: "verify", task: "t-b", surface: "repo", pass: true });
    expect(back.status).toBe(409);
    expect(back.body.message).toContain("要么换人，要么等 owner 重新 done");
  });

  it("a project where nobody can pass is told so, and why, instead of an empty list", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: { pm: ["R1"], dev: ["R5"] } });
    await done("t-c");
    const r = await post("dev", { kind: "task", op: "verify", task: "t-c", surface: "repo", pass: true });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("本项目没人能给这一件落 pass：pm 不持 R6、写了判据；dev 不持 R6、是 owner");
    expect(r.body.message).toContain(`这件的验收会进 ${HUMAN} 的「需要你」由他来判`);
    expect(r.body.message).not.toMatch(/可以由谁来落 pass：/);
    // 出路是真的：同一个 dev 落得了 fail
    const f = await post("dev", { kind: "task", op: "verify", task: "t-c", surface: "repo", pass: false, evidence: "判据 1 不成立" });
    expect(f.status).toBe(201);
  });
});
