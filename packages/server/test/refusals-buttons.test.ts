/**
 * t-212（qa 16:19 找到的洞）：**牌桌按钮那条路不走 validate**，于是它被挡住的那几次一条都没进拒绝账——
 * 而那正是最该数的一条路：全队只有它是**人**被挡住。
 *
 * 这是今天第四次同一形状（pm 16:20 立成常设问法）：一道机制恰好对最该被它照顾的那一方沉默。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, countRefusals } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";
let card = "";

let cookie = "";
const form = (path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams(fields).toString() });

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  cookie = ((await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "qa"] }, { human: HUMAN });
  const e = await append(store, { kind: "instruction", actor: "pm", to: HUMAN, body: "选一个", options: ["A", "B"], ack_by: new Date(Date.now() + 3_600_000).toISOString() }, { human: HUMAN });
  card = e.id;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-212 · 人点按钮被挡住，也要被数进去", () => {
  it("点了一个不存在的选项：账上多一条，规则名说得出来，op 说得出是哪条路", async () => {
    const before = (await store.refusals!()).length;
    const r = await form("/decide", { id: card, option: "C" });
    expect(r.status).toBe(409);
    const rs = await store.refusals!();
    expect(rs.length).toBe(before + 1);
    expect(rs[rs.length - 1]).toMatchObject({ rule: "decide", op: "POST /decide", who: HUMAN });
  });

  it("指着一条不存在的卡：404 也是被挡住，一样数", async () => {
    const before = (await store.refusals!()).length;
    expect((await form("/decide", { id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ", option: "A" })).status).toBe(404);
    expect((await store.refusals!()).length).toBe(before + 1);
  });

  it("说一句空话：400 也数——闸挡住人的每一次都该能被数出来", async () => {
    const before = (await store.refusals!()).length;
    expect((await form("/say", { text: "" })).status).toBe(400);
    expect((await store.refusals!()).length).toBe(before + 1);
  });

  it("成功那次不数：点一个真选项，账上不多", async () => {
    const before = (await store.refusals!()).length;
    expect((await form("/decide", { id: card, option: "A" })).status).toBeLessThan(300);
    expect((await store.refusals!()).length).toBe(before);
  });

  it("已经决过再决：这一条正是 qa 16:19 实测的第三种，照样数", async () => {
    const before = (await store.refusals!()).length;
    expect((await form("/decide", { id: card, option: "B" })).status).toBe(409);
    const c = countRefusals(await store.refusals!());
    expect(c.total).toBe(before + 1);
    expect(c.by_rule.find((x) => x.rule === "decide")!.n).toBeGreaterThanOrEqual(2);
  });
});
