/**
 * t-279：**牌桌看不出「有人在听、却很久没动，而别人全卡在他身上」——今天为此付了两小时。**
 *
 * 真实的那一次：`qa` `14:27:02` 之后再没写过任何事件，到 `17:30` 是三小时；同一刻它十几秒前还在拉。
 * 五件交付、七条逾期指令压在它名下，而牌桌 `COVERAGE` 一格没报、`TEAM` 只报了一条「低效」。
 * 成因：`listening` 只说明「五分钟内拉过一次」，而拉取由后台 `watch` 推——**watch 活着不等于人在干活**。
 *
 * 所以这一格看的是 **t-262 分出来的写入那一侧**，不是 `status`。判据 3 要求「把写入那一侧拿掉就算不出来」，
 * 下面最后一条就钉这个。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, stalledRoles, STALLED_AFTER_MS, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-15T17:30:00.000Z");
const NOW = new Date(T0);
const ago = (ms: number) => new Date(T0 - ms);

/** qa 很久没写入、但一直在拉；dev 刚交了几件等它判。`wrote` 是 qa 最后一次写事件距今多久。 */
async function world(wroteAgoMs: number, opts: { waiting?: boolean; pulling?: boolean } = {}) {
  const { waiting = true, pulling = true } = opts;
  const s = new MemoryStore();
  const put = (e: NewEvent, at: Date) => append(s, e, { human: HUMAN, now: at });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles",
    value: { pm: { responsibilities: ["R4"] }, dev: { responsibilities: ["R5"] }, qa: { responsibilities: ["R6"] } } }, ago(9 * 3600_000));
  await put({ kind: "note", actor: "qa", body: "我判完上一批了" }, ago(wroteAgoMs));
  if (waiting) {
    for (const id of ["t-901", "t-902"]) {
      await put({ kind: "task", op: "create", actor: "pm", task: id, title: "一件", criteria: ["x"], no_human_impact: true }, ago(8 * 3600_000));
      await put({ kind: "task", op: "claim", actor: "dev", task: id, touches: [`src/${id}.ts`] }, ago(7 * 3600_000));
      await put({ kind: "task", op: "done", actor: "dev", task: id, evidence: "abc1234: 做完了", no_human_impact: true }, ago(6 * 3600_000));
    }
  }
  if (pulling) await s.setCursor({ actor: "qa", last_event_id: null, at: ago(20_000).toISOString() });
  await s.setCursor({ actor: "dev", last_event_id: null, at: ago(20_000).toISOString() });
  return board(reduce(await s.read(), NOW), HUMAN, NOW);
}
const qaRow = (b: Awaited<ReturnType<typeof world>>) => b.stalled.find((x) => x.role === "qa");

describe("t-279 · 在听、没在动、而有人等着", () => {
  it("正：三小时没写入、十几秒前还在拉、两件等它判 ⇒ 说出来，两个时刻并排，数是实的", async () => {
    const b = await world(3 * 3600_000);
    const x = qaRow(b)!;
    expect(x, "改前这一格根本不存在").toBeTruthy();
    expect(x.awaiting_verdict).toBe(2);
    expect(Math.round(x.idle_event_s / 3600)).toBe(3);
    expect(x.idle_pull_s).toBeLessThan(60);
    expect(x.line).toContain("在听");
    expect(x.line).toContain("没写过任何事件");
    expect(x.line).toContain("2 件等它判");
  });

  it("门槛以下什么都不说：还没到 90 分钟就一个字没有", async () => {
    expect(qaRow(await world(STALLED_AFTER_MS - 60_000)), "差一分钟").toBeUndefined();
    expect(qaRow(await world(STALLED_AFTER_MS + 60_000)), "过一分钟").toBeTruthy();
  });

  it("没人等它就不说——那是休息，不是事故（判据 4）", async () => {
    expect(qaRow(await world(3 * 3600_000, { waiting: false }))).toBeUndefined();
  });

  it("不在听的不说：那是「缺人」，另有一行在说它，这一格只管「在听却没在动」", async () => {
    const b = await world(3 * 3600_000, { pulling: false });
    expect(qaRow(b)).toBeUndefined();
    expect(b.presence.find((p) => p.actor === "qa")?.status).not.toBe("listening");
  });

  it("判据 3：把写入那一侧拿掉，这条就算不出来——它靠的正是 t-262 分出来的那个时刻", async () => {
    const s = new MemoryStore();
    const put = (e: NewEvent, at: Date) => append(s, e, { human: HUMAN, now: at });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles",
      value: { pm: { responsibilities: ["R4"] }, dev: { responsibilities: ["R5"] }, qa: { responsibilities: ["R6"] } } }, ago(9 * 3600_000));
    await put({ kind: "note", actor: "qa", body: "我判完上一批了" }, ago(3 * 3600_000));
    await put({ kind: "task", op: "create", actor: "pm", task: "t-901", title: "一件", criteria: ["x"], no_human_impact: true }, ago(8 * 3600_000));
    await put({ kind: "task", op: "claim", actor: "dev", task: "t-901", touches: ["src/a.ts"] }, ago(7 * 3600_000));
    await put({ kind: "task", op: "done", actor: "dev", task: "t-901", evidence: "abc1234: 做完了", no_human_impact: true }, ago(6 * 3600_000));
    await s.setCursor({ actor: "qa", last_event_id: null, at: ago(20_000).toISOString() });
    const st = reduce(await s.read(), NOW);
    const b = board(st, HUMAN, NOW);
    expect(b.stalled.map((x) => x.role), "照常算得出来").toEqual(["qa"]);

    // 只把写入那一侧抹掉（status 与拉取那一侧原样留着），再用同一份 state 重算
    const blind = { ...b, presence: b.presence.map((p) => ({ ...p, last_event: null, idle_event_s: null })) };
    expect(stalledRoles(st, blind, NOW), "没有写入那一侧 ⇒ 一行都算不出来；这一格不是从 status 来的").toEqual([]);
  });

  it("不持验收职责的角色：不算「几件等它判」，只算逾期没 ack 的", async () => {
    const b = await world(3 * 3600_000);
    expect(b.stalled.find((x) => x.role === "dev"), "dev 刚写过，本来就不该在这一格").toBeUndefined();
  });
});
