/**
 * t-231 判据 1、2、4 在人那一页上：**「等谁」按状态算**，而一个人都没有时照实说，不拿 owner 充数。
 * qa 16:33 走的就是这一页。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, NOBODY_WAITING } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const page = async (path = "/release") => (await fetch(`${base}${path}`, { headers: { accept: "text/html" } })).text();

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  await post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
  // t-227 那一行：dev 做的、pm 写的判据 ⇒ 在等 qa
  await post("pm", { kind: "task", op: "create", task: "t-227", title: "dev 做的", criteria: ["能用"], no_human_impact: true });
  await post("dev", { kind: "task", op: "claim", task: "t-227", touches: ["src/a.ts"] });
  await post("dev", { kind: "task", op: "done", task: "t-227", evidence: "ccccccc3333：做完了", no_human_impact: true });
  // t-094 那一行：qa 做的、qa 写的判据 ⇒ 规矩不许它验自己，在等的是 human
  await post("qa", { kind: "task", op: "create", task: "t-094", title: "qa 做的", criteria: ["走一遍"], no_human_impact: true });
  await post("qa", { kind: "task", op: "claim", task: "t-094", touches: ["src/b.ts"] });
  await post("qa", { kind: "task", op: "done", task: "t-094", evidence: "ccccccc3333：走完了", no_human_impact: true });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-231 · 人那一页上的「等谁」", () => {
  it("判据 2：t-094 那一行指向 human，不指向 qa——**人照这一页去问，不会问到一个被禁止动它的人**", async () => {
    const html = await page();
    const row = html.slice(html.indexOf("t-094"));
    expect(row.slice(0, 120)).toContain("等 human");
    expect(html).not.toMatch(/t-094[^、<]*等 qa/);
  });

  it("判据 3：t-227 那一行指向 qa，不指向它的 owner dev", async () => {
    const html = await page();
    expect(html).toMatch(/t-227[^、<]*等 qa/);
    expect(html).not.toMatch(/t-227[^、<]*等 dev/);
  });

  it("判据 4：没有人在等的那一件照实说——那一句里不许出现一个「等 <谁>」的形状", async () => {
    expect(NOBODY_WAITING).not.toMatch(/等 \S/);
  });
});
