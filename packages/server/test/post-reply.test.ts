/**
 * t-227：**POST 的回包要带 for_me 与 owed**，让「只发不拉」的节点也看得见谁在点名找它。
 *
 * 这条的样本来自外部实战报告 F1 的第二段：那一晚 mini **00:42 连发 5 条事件**，而 be 00:37 发给它的
 * 「停掉生产探针」一直是 unread——**一个正在活跃发帖的节点，对发给自己的 P0 指令一无所知**，因为 POST 的
 * 回包里什么都没有。本队五天里 pd 与 release 也各出现过一次「写了但从不拉取」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, POST_REPLY_BYTES, type Event } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

/** 一个**从不发 GET** 的最小客户端：它只会写事件，然后读回包。 */
const post = async (actor: string, body: unknown) =>
  (await fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-actor": actor, authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  })).json() as Promise<Event & { for_me?: Event[]; owed?: { untouched: unknown[]; unanswered: unknown[] }; more?: boolean }>;

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, { human: HUMAN });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-227 判据 1、2 · 只发不拉的节点，从回包里就看得见点名找它的那条", () => {
  it("**这就是 mini 那一晚**：pm 发给 dev 一条，dev 一次 GET 都不发、只写事件，仍然看得见它", async () => {
    await append(store, { kind: "instruction", actor: "pm", to: "dev", body: "停掉生产探针", ack_by: soon() }, { human: HUMAN });
    const reply = await post("dev", { kind: "note", body: "我在忙别的" });
    expect(reply.for_me?.length, "回包里带着点名给它的").toBeGreaterThan(0);
    expect(JSON.stringify(reply.for_me)).toContain("停掉生产探针");
    expect(reply.owed, "欠什么也一起给").toBeTruthy();
  });

  it("**看一眼不算送到**：同一条在它下一次 POST 时还在——投递只记在拉取那条路上", async () => {
    const again = await post("dev", { kind: "note", body: "还在忙" });
    expect(JSON.stringify(again.for_me), "没读过，就还在").toContain("停掉生产探针");
  });

  it("判据 4：for_me 按发事件的人算——同一时刻 qa 发一条，看到的是给 qa 的那条，不是 dev 的", async () => {
    await append(store, { kind: "instruction", actor: "pm", to: "qa", body: "去验 t-1", ack_by: soon() }, { human: HUMAN });
    const mine = await post("qa", { kind: "note", body: "收到" });
    const text = JSON.stringify(mine.for_me);
    expect(text).toContain("去验 t-1");
    expect(text, "别人的不给它看").not.toContain("停掉生产探针");
  });

  it("没人找它时，两样都在、都是空的——**空与缺失要分得开**（缺字段读起来像「服务没这功能」）", async () => {
    const reply = await post("pm", { kind: "note", body: "我没被点名" });
    expect(Array.isArray(reply.for_me)).toBe(true);
    expect(reply.for_me).toEqual([]);
    expect(reply.owed).toEqual({ unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 });
  });
});

describe("t-227 判据 3 · 回包体积有绝对上限，不许把 6 MB 搬到每一次 POST 上", () => {
  it("上限是写死的数，比拉取那个小——每一次 POST 都要付这笔钱", () => {
    expect(POST_REPLY_BYTES).toBe(65_536);
  });

  it("**量的是整个回包，不是我看得见的那两半**（qa 16:39 判 fail 的那一条）", async () => {
    // 第一版把 for_me 与 owed 各自限到 65,536，于是**两份各自合规、整体两倍**：qa 在生产真状态下量到
    // 131,135 字节。我量了我看得见的那两半，把它报成了整体——这几天数了二十多次的那一族，这次轮到我。
    for (let i = 0; i < 400; i++) {
      await append(store, { kind: "instruction", actor: "pm", to: "release", body: `第 ${i} 条 ${"字".repeat(80)}`, ack_by: soon() }, { human: HUMAN });
    }
    const r = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor": "release", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ kind: "note", body: "我只写不读" }),
    });
    const text = await r.text();
    const whole = Buffer.byteLength(text, "utf8");
    const reply = JSON.parse(text) as { for_me: Event[]; owed: Record<string, unknown[]>; more?: boolean };
    // 两半各自合规，正是第一版也满足的那句——留在这里，是为了说明它满足了却仍然超标
    expect(Buffer.byteLength(JSON.stringify(reply.for_me), "utf8")).toBeLessThanOrEqual(POST_REPLY_BYTES);
    expect(Buffer.byteLength(JSON.stringify(reply.owed), "utf8")).toBeLessThanOrEqual(POST_REPLY_BYTES);
    // 而这一句才是判据 3 说的那件事
    expect(whole, `整个回包 ${whole} 字节`).toBeLessThanOrEqual(POST_REPLY_BYTES);
    expect(reply.more, "截断必须看得见").toBe(true);
  });

  it("事件本身先从预算里扣掉——一条长事件挤掉的是 for_me 的份额，不是上限", async () => {
    const long = "记" .repeat(3_000);
    const r = await fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor": "release", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ kind: "note", body: long }),
    });
    const text = await r.text();
    expect(Buffer.byteLength(text, "utf8"), "连同事件正文一起算").toBeLessThanOrEqual(POST_REPLY_BYTES);
    expect(JSON.parse(text).body, "事件本身一个字不少").toBe(long);
  });

  it("点名给它的指令堆到超限时：截断、说 more，回包不随欠账无限长大", async () => {
    for (let i = 0; i < 400; i++) {
      await append(store, { kind: "instruction", actor: "pm", to: "frontend", body: `第 ${i} 条 ${"字".repeat(80)}`, ack_by: soon() }, { human: HUMAN });
    }
    const reply = await post("frontend", { kind: "note", body: "我只写不读" });
    const size = Buffer.byteLength(JSON.stringify(reply.for_me), "utf8");
    expect(size, "不超上限").toBeLessThanOrEqual(POST_REPLY_BYTES);
    expect(reply.for_me!.length, "给了一部分").toBeGreaterThan(0);
    expect(reply.for_me!.length, "不是全部 400 条").toBeLessThan(400);
    expect(reply.more, "截断必须看得见").toBe(true);
  });
});
