/**
 * t-333（pd ㉕，定稿在 `3a40fe9` 的 `docs/product.md:288`）：
 * **一张卡所说的事实不成立了，这张卡就结束；下一次同类的事实要新的一张卡、新的 id。**
 *
 * 真样本（出处 pd 16:29 的 decision `01M69CPM1HMAFZX6J3AX17Q94D`，量于 production 16:24–16:28）：人那一页上
 * 三张「<角色> 缺人 N 分钟，M 条没送到。起一个 <角色>？」的 id 全铸于 2026-09-07，而 release 那张是
 * `01M1WSJF65…`（02:01:20.837Z）——release 的 `last_pull` 却是 2026-10-30T22:42:33Z，**它回来过**：那次缺人
 * 九月就结束了，卡没有结束，被下一次同类的缺人接着用。
 *
 * 判据③ 里那个「办了没有」对应的是 **T15**（pd 16:30 自己的更正，判据⑦）；M6 是另一件事，那半句作废。
 *
 * 这一份走真接口（`/_test/run`，即服务自己那一轮扫），因为要判的正是服务**落下了什么事件**，不是牌桌此刻
 * 显示什么——今天那个「结束」只发生在显示期，什么都不落，而那正是缺陷本身。
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SERVICE_ACTOR, missingRoleOf, cardEnded, LISTEN_WINDOW_MS, type Board, type Event } from "@ateam/core";
import { createApp } from "../src/app.js";
import { MemoryRegistry } from "../src/projects.js";
import { ownerKeyOf } from "./owner.js";

const TOKEN = "tok";
const HUMAN = "human";
const apps: ReturnType<typeof createApp>[] = [];
afterAll(() => Promise.all(apps.map((a) => new Promise<void>((r) => a.close(() => r())))));

/** 服务器读的是这把钟，于是「缺人 → 回来 → 再缺人」三段可以在一个用例里走完。 */
async function up() {
  const store = new MemoryStore();
  let t = Date.now();
  // t-234：人点的那一下用他自己那把钥匙，不借管理钥匙（队里那条 P0：谁都不许以 x-actor: human 写入）。
  const registry = new MemoryRegistry();
  const app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0, testHooks: true, registry, clock: () => new Date(t) });
  apps.push(app);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const hdr = (actor: string) => ({ authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" });
  const owner = await ownerKeyOf(registry, "ateam", HUMAN);
  return {
    store,
    /** 人自己那一下：他的钥匙，不是管理钥匙。 */
    human: (body: unknown) => fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${owner}`, "x-actor": HUMAN, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
    tick: (ms: number) => { t += ms; },
    now: () => new Date(t),
    post: (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: hdr(actor), body: JSON.stringify(body) }).then((r) => r.json()),
    /** 一次真的拉取：这是「它回来了」唯一的证据（t-047：在场＝来读过日志）。 */
    pull: (actor: string) => fetch(`${base}/events`, { headers: hdr(actor) }).then((r) => r.json()),
    run: () => fetch(`${base}/_test/run`, { method: "POST", headers: hdr("pm"), body: "{}" }).then((r) => r.json()),
    board: () => fetch(`${base}/board?full=1`, { headers: hdr("pm") }).then((r) => r.json()) as Promise<Board>,
    cards: async () => ((await store.read()).events as Event[]).filter((e) => e.kind === "instruction" && e.actor === SERVICE_ACTOR && missingRoleOf((e as { body: string }).body) === "gone"),
    untells: async () => ((await store.read()).events as Event[]).filter((e) => e.kind === "untell"),
  };
}

/** 一个真没人在跑的角色，手上欠着一条已经到期、也从没读到的指令——「要不要起卡」的前提。 */
async function owing(w: Awaited<ReturnType<typeof up>>) {
  await w.post("pm", { kind: "instruction", to: "gone", body: "干一件", ack_by: new Date(w.now().getTime() - 60_000).toISOString() });
}

describe("t-333 · 事实不成立了卡就结束，下一次是新的一张", () => {
  it("**判据①②**：缺人 → 回来 → 再缺人 ⇒ 人那一页先后两张**不同 id** 的卡，不是同一张被续用", async () => {
    const w = await up();
    await w.post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "gone"] });
    await owing(w);

    // 第一段：真的缺人，卡出来了
    await w.run();
    const first = await w.cards();
    expect(first, "第一次缺人：一张卡").toHaveLength(1);
    expect((await w.board()).needs_human.map((n) => n.id)).toContain(first[0].id);

    // 第二段：它回来了（来读过日志）——卡问的那件事不再成立
    w.tick(60_000);
    await w.pull("gone");
    await w.run();
    const ended = await w.untells();
    expect(ended, "**结束要落在日志里**，不是只在显示期跳过它").toHaveLength(1);
    expect(ended[0]).toMatchObject({ kind: "untell", actor: SERVICE_ACTOR, of: first[0].id });
    expect((ended[0] as { reason: string }).reason, "pd 17:20 定稿那一句，槽里填量出来的事实").toBe(cardEnded(`gone.last_pull=${(await w.store.read()).cursors.find((c) => c.actor === "gone")!.at}`));
    expect((await w.board()).needs_human.map((n) => n.id), "结束了：不在他那一页上").not.toContain(first[0].id);

    // 第三段：它又缺人了，而且又欠着一条到期没读的——同一类事实再出现一次
    w.tick(LISTEN_WINDOW_MS + 60_000);
    await owing(w);
    await w.run();
    const all = await w.cards();
    expect(all, "第二次缺人：第二张卡").toHaveLength(2);
    expect(all[1].id, "**判据②：不许一个 id 跨两次事实**").not.toBe(all[0].id);
    const page = (await w.board()).needs_human.map((n) => n.id);
    expect(page, "人那一页上此刻是新那一张").toContain(all[1].id);
    expect(page, "旧那一张结束了，不再出现").not.toContain(all[0].id);
  });

  it("**判据① 的对照**：事实仍然成立（还在缺人）⇒ 卡不动，也不许无端结束它", async () => {
    const w = await up();
    await w.post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "gone"] });
    await owing(w);
    await w.run();
    const first = await w.cards();
    expect(first).toHaveLength(1);

    w.tick(60_000);
    await w.run();
    expect(await w.untells(), "没有人回来，没有什么结束").toHaveLength(0);
    expect(await w.cards(), "也不许再发一张：它还是同一次事实").toHaveLength(1);
    expect((await w.board()).needs_human.map((n) => n.id)).toContain(first[0].id);
  });

  it("**判据③⑦**：卡结束之后，人当时办过的那一次仍能按它自己的 id 查到（T15「办了没有」要有判据）", async () => {
    const w = await up();
    await w.post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "gone"] });
    await owing(w);
    await w.run();
    const first = (await w.cards())[0];

    // 人办了它：ack 落在这张卡自己的 id 上
    w.tick(30_000);
    await w.human({ kind: "ack", of: first.id });
    const ackedAt = (await w.board()).instructions.find((i) => i.id === first.id)!.acked;
    expect(ackedAt, "先确认那次 ack 真的记下了").toBeTruthy();

    // 事实结束，又再出现一次：新卡、新 id
    w.tick(60_000);
    await w.pull("gone");
    await w.run();
    w.tick(LISTEN_WINDOW_MS + 60 * 60_000);          // 过了 ack 之后那段冷却，再缺人
    await owing(w);
    await w.run();
    const all = await w.cards();
    expect(all.length, "第二次是新的一张").toBe(2);
    expect(all[1].id).not.toBe(first.id);

    // **而第一张那次 ack 照旧按第一张的 id 查得到**
    const row = (await w.board()).instructions.find((i) => i.id === first.id)!;
    expect(row.acked, "他九月真办过的那一次，翻得回来").toBe(ackedAt);
    expect(((await w.store.read()).events as Event[]).some((e) => e.kind === "ack" && (e as { of: string }).of === first.id)).toBe(true);
  });
});
