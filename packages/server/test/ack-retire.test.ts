/**
 * t-147 判据 6（pm 06:37）：拉取时随手给出「此刻这个角色欠什么」。
 *
 * 要点不只是「有这个字段」，而是它的代价：由服务端从 t-128 之后一直在往前推的那份增量状态算出来，
 * 调用方既不必全量读日志、也不必再多打一个请求。所以这里数的是**这一次拉取让 store 交出了什么**。
 * 另外一半是口径：欠的是「带选项待答的」和「读过还没动的」，不是「没 ack 的」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, DECLINE_PREFIX, type EventStore, type LogMark, type OwedNow } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

function counting(store: MemoryStore) {
  let reads = 0, calls = 0;
  const realRead = store.read.bind(store);
  const realSince = store.readSince.bind(store);
  (store as EventStore).read = async () => { reads++; return realRead(); };
  (store as EventStore).readSince = async (mark: LogMark | null) => { calls++; return realSince(mark); };
  return { reads: () => reads, calls: () => calls, reset: () => { reads = calls = 0; } };
}

describe("t-147 判据 6 · 拉取时把「你欠什么」一起给出来", () => {
  const store = new MemoryStore();
  const counter = counting(store);
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { id: string } };
  };
  const sync = async (actor: string, after: string | null) => {
    const q = after ? `?after=${encodeURIComponent(after)}` : "";
    const r = await fetch(`${base}/events${q}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } });
    return await r.json() as { events: unknown[]; cursor: string | null; owed: OwedNow };
  };
  const soon = () => new Date(Date.now() + 15 * 60_000).toISOString();

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("一次拉取就够：没有第二个请求，也没有一次全量读日志", async () => {
    const a = await post("pm", { kind: "instruction", to: "dev", body: "认领 t-9 再动手", ack_by: soon() });
    await post("pm", { kind: "instruction", to: "dev", body: "顺手看一眼 CI", ack_by: soon() });
    await post("pm", { kind: "instruction", to: "qa", body: "验 t-9", ack_by: soon() });

    counter.reset();
    const first = await sync("dev", null);
    expect(counter.reads()).toBe(0);          // 全量读日志：一次都没有
    expect(first.owed).toBeTruthy();          // 字段就在这一次的回包里，不必再打一个请求
    expect(first.owed.untouched.map((x) => x.instruction)).toContain(a.body.id);
    expect(first.owed.untouched.every((x) => x.instruction !== undefined)).toBe(true);
    expect(first.owed.untouched).toHaveLength(2);
    expect(JSON.stringify(first.owed)).not.toContain("验 t-9");   // 别人的不欠
  });

  it("动过就不欠了：口径是「有没有人办」，不是「有没有 ack」", async () => {
    const before = await sync("dev", null);
    const [one, two] = before.owed.untouched.map((x) => x.instruction);
    // t-193 (pd 11:15)：**这条用例名说的口径原来不成立。**它拿一条光秃秃的 ack 当「办了」，也就是把
    // 「看见」读成「做了」——按 CLAUDE.md，ack 是「看见」，不是「同意」，更不是「做了」。现在两条都要
    // 真动过：一条写引用它的 note，一条写「不办：原因」。两种都是行动，都算办了；只签收的仍然欠着。
    await post("dev", { kind: "ack", of: one });
    expect((await sync("dev", null)).owed.untouched.map((x) => x.instruction), "只 ack 没动作，仍然欠着").toContain(one);
    await post("dev", { kind: "note", body: "看了，CI 那条我接了", refs: [one] });
    await post("dev", { kind: "note", body: `${DECLINE_PREFIX}CI 那条归 release，我不接`, refs: [two] });
    const after = await sync("dev", null);
    expect(after.owed.untouched).toEqual([]);
    expect(after.owed.unanswered).toEqual([]);
  });

  it("角色手里不会有带选项的卡（规则只允许发给人），所以那一类对它必然是空的", async () => {
    const bad = await post("pm", { kind: "instruction", to: "dev", body: "你选一个", options: ["A", "B"], ack_by: soon() });
    expect(bad.status).toBe(409);
    const card = await post("pm", { kind: "instruction", to: HUMAN, body: "先发哪个？", options: ["A", "B"], default: "B", ack_by: soon() });
    expect(card.status).toBe(201);
    expect((await sync("dev", null)).owed.unanswered).toEqual([]);
    // 人自己拉的时候，同一个字段装的是那张还没答的卡
    const mine = await sync(HUMAN, null);
    expect(mine.owed.unanswered.map((x) => x.instruction)).toEqual([card.body.id]);
    expect(mine.owed.unanswered[0]).toMatchObject({ from: "pm", options: ["A", "B"], default: "B", overdue: false });
  });
});

/**
 * pd 05:40 的升级口径：到 ack_by 时仍停在①「没读到」，才升级成给人的「起一个 X」；停在②「读到了，还没动」的，
 * 升级成一句给它自己的提醒，不进人的牌桌。所以一个刚离开四分钟、手里那条还没到期的角色，不该惊动人。
 */
describe("t-147 · 升级只发生在期限之后，而且只对「没读到」的那种", () => {
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) =>
    (await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ id: string }>;
  const cards = async () => {
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": HUMAN } })).json() as { needs_human: { from: string; body: string }[] };
    return b.needs_human.filter((n) => n.from === "ateam").map((n) => n.body);
  };

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("还没到期：没读到也不惊动人", async () => {
    await post("pm", { kind: "instruction", to: "qa", body: "验 t-9", ack_by: new Date(Date.now() + 15 * 60_000).toISOString() });
    expect(await cards()).toEqual([]);
  });

  it("过了期限还没读到：这才是「起一个 qa」", async () => {
    await post("pm", { kind: "instruction", to: "qa", body: "再验一次", ack_by: new Date(Date.now() - 1000).toISOString() });
    expect(await cards()).toEqual(["qa 从没读过日志，2 条没送到。起一个 qa？"]);
  });

  it("读到了、还没动的那种，永远不进人的牌桌——它是本人 sync 时自己那一行", async () => {
    const i = await post("pm", { kind: "instruction", to: "dev", body: "去看一眼 CI", ack_by: new Date(Date.now() - 1000).toISOString() });
    await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "dev" } });   // dev 拉了：读到了
    expect((await cards()).some((b) => b.includes("dev"))).toBe(false);
    const mine = await (await fetch(`${base}/events?after=${encodeURIComponent(i.id)}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "dev" } })).json() as { owed: OwedNow };
    expect(mine.owed.untouched.map((x) => x.instruction)).toContain(i.id);
  });
});
