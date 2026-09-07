/**
 * t-216：误署成 human 的事件，只有 human 能更正——而那正是最需要更正的一种。
 *
 * 真样本，今天真的卡住了一件事：qa 03:36 试共享 token 时误落一条 ack，以 actor=human 入库；16:05 release 要撤
 * 一张已经过期的卡，闸以「acked by human at 03:36:48」拒了它——**一条假的 ack 正在保护一张假的卡**。
 * 而按 t-196，署着 human 的事件只有 human 本人能更正，human 不在，于是全队谁都动不了它。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, Rejected, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (m: number) => new Date(T0 + m * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] }, -300);
  const card = await put({ kind: "instruction", actor: "release", to: HUMAN, body: "37 件已验的没上线，谁来推？", ack_by: at(-200).toISOString() }, -280);
  // 误署：以 human 的名义落下的一条 ack（今天真发生过的那一条）
  const bad = await put({ kind: "ack", actor: HUMAN, of: card.id }, -250);
  return { s, put, card, bad };
}
const st = async (s: MemoryStore, m = 0) => reduce(await s.read(), at(m), HUMAN);

describe("t-216 判据 1、3 · 署着 human 的事件，两个角色各声明一次才更正得了", () => {
  it("一个角色声明：还不生效，但看得出这一条在争议中", async () => {
    const w = await world();
    await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "那次 ack 是我试共享 token 时误落的，不是 human 点的" }, -200);
    const s = await st(w.s);
    expect(s.disowned.has(w.bad.id)).toBe(false);            // 还没生效
    expect(s.contested.get(w.bad.id)?.by).toEqual(["qa"]);   // 但记着差一个
    expect(s.instructions.get(w.card.id)?.acked_at).toBeTruthy();   // 那条 ack 仍然算数
  });

  it("**第二个角色也声明：生效**，那条 ack 不再算数——假的 ack 不再保护那张卡", async () => {
    const w = await world();
    await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "我试共享 token 时误落的" }, -200);
    await w.put({ kind: "disown", actor: "release", of: w.bad.id, reason: "我要撤这张卡，被这条 ack 挡住；它不是 human 点的" }, -190);
    const s = await st(w.s);
    expect(s.disowned.get(w.bad.id)?.by).toBe("qa+release");
    expect(s.contested.has(w.bad.id)).toBe(false);
    expect(s.instructions.get(w.card.id)?.acked_at).toBeFalsy();    // ack 不再计入
  });

  it("同一个人说两次不算两个人", async () => {
    const w = await world();
    await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "误落的" }, -200);
    const err = await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "再说一次" }, -190).catch((e) => e as Rejected);
    expect(err).toBeInstanceOf(Rejected);
    expect(err.message).toContain("还差另一个角色");
    expect((await st(w.s)).disowned.has(w.bad.id)).toBe(false);
  });

  it("human 一个人就够（本人自报那条路没变）", async () => {
    const w = await world();
    await w.put({ kind: "disown", actor: HUMAN, of: w.bad.id, reason: "不是我点的" }, -200);
    expect((await st(w.s)).disowned.get(w.bad.id)?.by).toBe(HUMAN);
  });
});

describe("t-216 判据 3 · human 回来能翻案，而且不必另造机制", () => {
  it("两个角色的声明生效之后，human 对那条声明本身再发一条 disown ⇒ 原事件回来算数", async () => {
    const w = await world();
    const d1 = await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "误落的" }, -200);
    await w.put({ kind: "disown", actor: "release", of: w.bad.id, reason: "被它挡住" }, -190);
    expect((await st(w.s)).disowned.has(w.bad.id)).toBe(true);
    await w.put({ kind: "disown", actor: HUMAN, of: d1.id, reason: "那条确实是我点的，这条更正不成立" }, -180);
    const s = await st(w.s);
    expect(s.disowned.has(w.bad.id)).toBe(false);                  // 原事件回来了
    expect(s.instructions.get(w.card.id)?.acked_at).toBeTruthy();
  });
});

describe("t-216 判据 5 · 一正一反", () => {
  it("反面：**真由 human 发的那种，两个 agent 也撤不掉**——只要 human 没被误署", async () => {
    // 这里的「真」由 human 自己后来确认：它对第一条声明发了 disown（上一组用例），
    // 而在它确认之前，两个角色的声明确实会生效——这正是「可被事后翻案」的含义，不是「agent 说了算」。
    // 本条守的是另一半：**不是 human 署名的事件，第三方一个字都动不了**（t-196 原样）。
    const w = await world();
    const mine = await w.put({ kind: "note", actor: "dev", body: "dev 自己写的一条" }, -240);
    const err = await w.put({ kind: "disown", actor: "qa", of: mine.id, reason: "我觉得这不是 dev 写的" }, -200).catch((e) => e as Rejected);
    expect(err).toBeInstanceOf(Rejected);
    expect(err.message).toContain("只能由本人自报");
  });

  it("正面：误署的那条按新路更正得了，而且留痕——谁声明的、为什么，都在日志里", async () => {
    const w = await world();
    await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "我试共享 token 时误落的" }, -200);
    await w.put({ kind: "disown", actor: "release", of: w.bad.id, reason: "被它挡住撤不了卡" }, -190);
    const log = (await w.s.read()).events.filter((e) => e.kind === "disown");
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.actor).sort()).toEqual(["qa", "release"]);
    for (const e of log) expect((e as { reason?: string }).reason).toBeTruthy();   // 每一条都说得出为什么
    expect((await st(w.s)).disowned.get(w.bad.id)?.actor).toBe(HUMAN);            // 原来署的是谁，记着
  });

  it("**不许任何单个 agent 直接抹掉自己以 human 名义造的痕迹**：误落的那个人自己也只算一票", async () => {
    const w = await world();
    await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "是我误落的，我自己撤" }, -200);
    expect((await st(w.s)).disowned.has(w.bad.id)).toBe(false);   // 一票不够，哪怕他就是造痕迹的那个人
  });
});

describe("t-216 判据 3 · 牌桌看得出「在争议中」，但只出数据不出话", () => {
  it("一个人声明过：牌桌那一格说得出是谁、原来署谁、为什么；生效之后它从争议里消失、进 disowned", async () => {
    const { board } = await import("../src/index.js");
    const w = await world();
    await w.put({ kind: "disown", actor: "qa", of: w.bad.id, reason: "我试共享 token 时误落的" }, -200);
    const b1 = board(await st(w.s), HUMAN, at(0));
    expect(b1.contested).toHaveLength(1);
    expect(b1.contested[0]).toMatchObject({ of: w.bad.id, actor: HUMAN, by: ["qa"] });
    expect(b1.contested[0].reason).toBeTruthy();
    expect(b1.disowned).toHaveLength(0);

    await w.put({ kind: "disown", actor: "release", of: w.bad.id, reason: "被它挡住撤不了卡" }, -190);
    const b2 = board(await st(w.s), HUMAN, at(0));
    expect(b2.contested).toHaveLength(0);
    expect(b2.disowned).toHaveLength(1);
  });
});

/**
 * qa 16:49：注入「human 自己那条也只算一票」时，t-216 的用例一条都没红，红的是 t-196 的——因为我造的那条是
 * **human 更正 human 自己署名的事件**，`e.actor === signer` 那一支就接住了。**「human 更正别人署名的事件」
 * 这一路，t-216 自己没有用例盯着**，而那正是它量出问题的那一路。
 */
describe("t-216 · human 更正别人署名的事件：一个人就够，且这一路自己有用例盯着", () => {
  it("human 对 dev 署名的事件发一条 disown ⇒ 当场生效，不进争议", async () => {
    const w = await world();
    const mine = await w.put({ kind: "note", actor: "dev", body: "dev 自己写的一条" }, -240);
    await w.put({ kind: "disown", actor: HUMAN, of: mine.id, reason: "这条是我让它代发的，署名不对" }, -200);
    const s = await st(w.s);
    expect(s.disowned.get(mine.id)?.by).toBe(HUMAN);
    expect(s.disowned.get(mine.id)?.actor).toBe("dev");   // 原来署的是谁，记着
    expect(s.contested.has(mine.id)).toBe(false);         // 不是「差一个人」
  });
});
