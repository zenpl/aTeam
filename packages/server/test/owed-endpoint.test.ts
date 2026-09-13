/**
 * t-239 判据 1、4：**每次拉取不再背那份不会变的历史；要它的人有一条单独的路。**
 * qa 19:41 实测：一次真增量拉取 182,477 字节，其中 121,817 是那 315 条历史，而没有一个读它内容的人。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, ACTED_RULE_TASK } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
let app: ReturnType<typeof createApp>;
let base = "";
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string, actor = "dev") => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } });

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  for (let i = 0; i < 30; i++) await post("pm", { kind: "instruction", to: "dev", body: `旧的第 ${i} 条：${"很长的正文".repeat(20)}`, ack_by: new Date(Date.now() + 6e5).toISOString() });
  // 这一批到生产，「引用才算办了」从此生效：它之前那些进旁桶（t-193 判据 7）
  await post("release", { kind: "reading", surface: "repo", key: "batch.14", value: { sha: "736967c", base: "b23b325", contains: [ACTED_RULE_TASK] } });
  await post("pm", { kind: "instruction", to: "dev", body: "新的一条：这条是活欠账", ack_by: new Date(Date.now() + 6e5).toISOString() });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-239 · 拉取回包里只剩一个数，全量在 GET /owed", () => {
  it("拉取回包：历史那一桶是一个数，逐条不在里面", async () => {
    const r = await (await get("/events")).json();
    expect(r.owed.legacy_before_acted_rule_count).toBe(30);
    expect(r.owed.legacy_before_acted_rule).toBeUndefined();
    expect(JSON.stringify(r.owed)).not.toContain("旧的第 0 条");
  });

  it("**省了多少，两个数并排**：同一时刻的回包，带全量比只带一个数大一个量级", async () => {
    const now = (await (await get("/events?after=01M99999999999999999999999")).text()).length;
    const full = (await (await get("/owed")).text()).length;
    expect(now).toBeLessThan(full / 5);
    expect(full - now, "这份夹具 30 条就差了几千字节；生产那一档 315 条差 121,817").toBeGreaterThan(5_000);
  });

  it("要那几条的人有路可走：GET /owed 给全量，而且只给问它的那个人自己的", async () => {
    const mine = await (await get("/owed")).json();
    expect(mine.legacy_before_acted_rule).toHaveLength(30);
    expect(mine.legacy_before_acted_rule[0].body).toContain("旧的第 0 条");
    expect(mine.untouched).toHaveLength(1);
    const qa = await (await get("/owed", "qa")).json();
    expect(qa.legacy_before_acted_rule, "别人的账不摊给你看").toHaveLength(0);
  });

  it("没钥匙的拿不到", async () => {
    expect((await fetch(`${base}/owed`)).status).toBe(401);
  });
});
