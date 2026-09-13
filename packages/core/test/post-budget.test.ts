/**
 * t-244：**POST 回包的预算被 `for_me` 吃掉 99.3%，于是 t-227 要送的那样东西一条也没送出去。**
 *
 * qa 21:52 在生产真状态下量到：65,058／65,536 归了 `for_me`（176 条未读），**活欠账改前改后都送出 0 条**。
 * 而 t-227 做这件事的全部理由，正是让一个**只写不拉**的节点看见自己欠什么——它此刻一条也看不见。
 *
 * 同一家账的三件（判据 3）：t-226 管首次拉取的上限、t-239 管每次拉取背着的永不变历史、**本件管一次写入的
 * 回包里两样东西抢同一个预算**。共同形状：**一个装不下的包，而谁被挤掉是偶然决定的。**
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, postReply, owedNow, POST_REPLY_BYTES, OWED_SHARE, ACTED_RULE_TASK, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");

/** 一个只写不拉的节点：`unread` 条没读过的指令点名找它，其中 `owed` 条它读过了却没动。 */
async function world(unread: number, touchedButOwed: number) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  // 它读过的那一段（游标越过了）：这些进活欠账
  const ids: string[] = [];
  for (let i = 0; i < touchedButOwed; i++) {
    const e = await put({ kind: "instruction", actor: "pm", to: "dev", body: `读过没动的第 ${i} 条：${"正文".repeat(40)}`, ack_by: at(-100).toISOString() }, -500 + i);
    ids.push(e.id);
  }
  await s.setCursor({ actor: "dev", last_event_id: ids[ids.length - 1] ?? null, at: at(-400).toISOString() });
  for (let i = 0; i < unread; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `没读过的第 ${i} 条：${"正文".repeat(40)}`, ack_by: at(100).toISOString() }, -300 + i);
  return reduce(await s.read(), at(0), HUMAN);
}

describe("t-244 · 两样东西各有份额，不是谁先填谁占满", () => {
  it("qa 那一幕（176 条未读、几十条活欠账）：**活欠账送得出去了**，而整包仍在上限内", async () => {
    const s = await world(176, 40);
    const reply = postReply(s, "dev", { id: "01X", kind: "note", at: at(0).toISOString() });
    expect(bytes({ id: "01X", kind: "note", at: at(0).toISOString(), ...reply })).toBeLessThanOrEqual(POST_REPLY_BYTES);
    expect(reply.for_me.length, "点名找它的仍然优先，送得出去一批").toBeGreaterThan(0);
    expect(reply.owed.untouched.length, "**而它欠什么，也送得出去了**").toBeGreaterThan(0);
    expect(reply.more, "两半都被截断了，回包要说出来").toBe(true);
  });

  /**
   * 第一版这里还有第二遍「用不掉的份额还给 for_me」。qa 22:15 注入 U（去掉它）整套全绿，两种局面都造不出
   * 它起作用的样子——**它是可证走不到的**：`owed` 是 `for_me` 的超集，所以 for_me 一旦被那一份挤到截断，
   * owed 至少要装下同样那些条、一定用满了自己那一份；没被挤到截断时，还回去也不多装一条。代码已删。
   */
  it("欠得少的时候两样都全给、一条都不砍（那一份没被用掉，也不需要「还回去」）", async () => {
    const s = await world(3, 2);
    const reply = postReply(s, "dev", { id: "01X", kind: "note" });
    expect(reply.for_me).toHaveLength(3);
    expect(reply.more).toBeUndefined();
  });

  /**
   * 写用例时我才看清的一件事，记在这儿免得下一个人再算一遍：**`owed` 是 `for_me` 的超集**。
   * `for_me` 是「点名找你、而你还没读过的」，`owed.untouched` 是「你还没办的」——没读过的当然也没办。
   * 所以给 `owed` 留一份，在两边都很多的时候**一定**是从 `for_me` 身上出的；第二遍那个「还回去」只在
   * 欠得少的时候才起作用。这不是缺陷，是这两样东西本来的关系，但它决定了那个份额该定多大。
   */
  it("两样是包含关系：没读过的那些同时出现在两边", async () => {
    const s = await world(3, 2);
    const reply = postReply(s, "dev", { id: "01X", kind: "note" });
    const owedIds = new Set(reply.owed.untouched.map((x) => x.instruction));
    expect(reply.for_me.every((i) => owedIds.has((i as unknown as { id: string }).id))).toBe(true);
    expect(reply.owed.untouched).toHaveLength(5);   // 3 条没读过 + 2 条读过没动
  });

  it("份额是写下来的那个数，不是「剩多少给多少」：`for_me` 再多也不许吃掉留给活欠账的那一份", async () => {
    const s = await world(400, 40);
    const reply = postReply(s, "dev", { id: "01X", kind: "note" });
    const owedBytes = bytes(reply.owed);
    expect(owedBytes).toBeGreaterThan(POST_REPLY_BYTES * OWED_SHARE * 0.5);   // 真用上了那一份
    expect(reply.owed.untouched.length).toBeGreaterThan(5);
  });

  it("欠的与未读的都不多时，两样都全给，且不报截断", async () => {
    const s = await world(2, 2);
    const reply = postReply(s, "dev", { id: "01X", kind: "note" });
    expect(reply.for_me).toHaveLength(2);
    expect(reply.owed.untouched, "两条读过没动的 + 两条没读过的（`owed` 含 `for_me`）").toHaveLength(4);
    expect(reply.more).toBeUndefined();
  });

  it("上限是绝对的：给一个小得多的上限，整包仍在里面", async () => {
    const s = await world(176, 40);
    for (const limit of [8_000, 20_000, 65_536]) {
      const base = { id: "01X", kind: "note", at: at(0).toISOString() };
      const reply = postReply(s, "dev", base, limit);
      expect(bytes({ ...base, ...reply }), `上限 ${limit}`).toBeLessThanOrEqual(limit);
    }
  });
});
