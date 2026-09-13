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
import { ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

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
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  // t-234：按钮是人点的，所以这里拿的是**主人自己那把钥匙**的 cookie，不再借管理钥匙
  cookie = await ownerCookie(base, TOKEN);
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
    // qa 16:43：**期望值写等号，不写「至少」**——这一轮的虚高正是被等号抓出来的；写成「至少」的话，
    // 同一次拒绝记两遍今天就漏过去了。
    expect(c.by_rule.find((x) => x.rule === "decide")!.n).toBe(2);
  });
});

/**
 * qa 16:33：**两处出口各自被测到了，两处叠在一起的那道缝没有。** core 的用例直接调 appendFrom（只见第一处
 * 出口），按钮那条路只有一处出口（所以永远对），而**没有一条用例走「HTTP → validate 拒绝」这条最常见的路**
 * ——重复恰好只在这条路上发生。今天第五次同一形状：每一块都对，合起来的那一处没人看。
 */
describe("t-212 · 两处出口叠在一起的那道缝：同一次拒绝只记一条", () => {
  const api = (body: unknown, actor = "qa") =>
    fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("走 API 被 validate 拒：账上只多一条，不是两条", async () => {
    const before = (await store.refusals!()).length;
    const r = await api({ kind: "ack", of: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" });
    expect(r.status).toBe(409);
    const rs = await store.refusals!();
    expect(rs.length, "同一次拒绝被记了两次").toBe(before + 1);
    expect(rs[rs.length - 1]).toMatchObject({ rule: "ack", who: "qa" });
  });

  it("虚高若回来，按规则名与按人分组的比例也会歪——这两个数正是判据 5 要的", async () => {
    const { countRefusals } = await import("@ateam/core");
    const before = countRefusals(await store.refusals!());
    await api({ kind: "note" });                        // 形状闸：缺 body
    await api({ kind: "note" });                        // 再来一次
    const after = countRefusals(await store.refusals!());
    expect(after.total).toBe(before.total + 2);         // 两次拒绝，两条记录，不是四条
    const shape = (c: typeof after) => c.by_rule.find((x) => x.rule === "shape")?.n ?? 0;
    expect(shape(after)).toBe(shape(before) + 2);
    expect(after.by_who.find((x) => x.who === "qa")!.n).toBe((before.by_who.find((x) => x.who === "qa")?.n ?? 0) + 2);
  });

  it("处理器自己抛的那条仍然记得上——去重不许把它一起去掉", async () => {
    const before = (await store.refusals!()).length;
    expect((await form("/decide", { id: card, option: "ZZZ" })).status).toBe(409);
    expect((await store.refusals!()).length).toBe(before + 1);
  });
});
