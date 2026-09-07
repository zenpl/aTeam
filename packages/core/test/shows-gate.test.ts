/**
 * t-151：交活的时候说一句这件对人有什么影响，或者明写它没有——二选一，没有第三种。
 *
 * 今晚量到的形状（production:unverified.in.production.split）：83 件在生产上没被走过的活里，只有 5 件说得出人能
 * 看到什么，78 件一句都没有。那 78 件不是「没影响」，是**没人问过这个问题**；两者在记录上长得一模一样，于是谁也
 * 分不出哪些该走查、哪些本来就不必。一个不必回答的问题，答案永远是空的。
 *
 * 时间一律相对 now。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, Rejected, NO_HUMAN_IMPACT, SERVICE_ACTOR, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "题", criteria: ["能用"] }, -200);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["x"] }, -190);
  return { s, put };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-151 · 判据 1：两句话里必须有一句", () => {
  it("两句都没有：拒绝，并且拒绝话里把两条出路都说清楚", async () => {
    const w = await world();
    await expect(w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234" }, -10)).rejects.toThrow(Rejected);
    const err = await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234" }, -10).catch((e) => e as Rejected);
    expect(err.rule).toBe("done");                     // 规则名
    expect(err.message).toContain("--shows");           // 出路一
    expect(err.message).toContain("--no-human-impact"); // 出路二
    expect(err.message).toContain(NO_HUMAN_IMPACT);
    expect(err.message).toContain("空着不算「没影响」");  // 为什么不能空着
  });

  it("说了人能看到什么：过", async () => {
    const w = await world();
    const e = await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", shows: "牌桌第一行现在是版本号" }, -10);
    expect((await st(w.s)).tasks.get("t-1")!.status).toBe("done");
    expect(e.shows).toBe("牌桌第一行现在是版本号");
  });

  it("明写对人没有影响：也过，而且这是一个签了字的判断，不是一个空字段", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true }, -10);
    const t = (await st(w.s)).tasks.get("t-1")!;
    expect(t.status).toBe("done");
    expect(t.shows).toBeUndefined();   // 它不是一句给人的话，所以不冒充一句
  });

  it("空白不算一句话", async () => {
    const w = await world();
    await expect(w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", shows: "   " }, -10)).rejects.toThrow(/--no-human-impact/);
  });

  it("两句都写就是自相矛盾，也拒绝", async () => {
    const w = await world();
    await expect(w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", shows: "人能看到 X", no_human_impact: true }, -10)).rejects.toThrow(/互相矛盾/);
  });

  it("闸排在「是不是你的」「能不能交」之后：交不了的人先被告知交不了", async () => {
    const w = await world();
    await expect(w.put({ kind: "task", actor: "qa", op: "done", task: "t-1", evidence: "abc1234" }, -10)).rejects.toThrow(/owned by dev/);
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", no_human_impact: true }, -9);
    await expect(w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "x" }, -8)).rejects.toThrow(/is done/);
  });
});

describe("t-151 · 判据 2：只管新的，不追溯", () => {
  it("日志里已经有的 done 一个字都不动，状态照旧，也不会变成不合格", async () => {
    const s = new MemoryStore();
    // 直接写进日志：这就是「口径之前」的那 78 件的形状——没有 shows，也没有那句「对人无影响」
    const old = { id: "01OLDDONE0000000000000000", at: at(-100).toISOString(), kind: "task", op: "done", actor: "dev", task: "t-9", evidence: "abc1234" };
    for (const e of [
      { id: "01OLDCREATE00000000000000", at: at(-120).toISOString(), kind: "task", op: "create", actor: "pm", task: "t-9", title: "旧的一件", criteria: ["能用"] },
      { id: "01OLDCLAIM000000000000000", at: at(-110).toISOString(), kind: "task", op: "claim", actor: "dev", task: "t-9", touches: ["x"] },
      old,
    ]) await s.appendRaw(e as never);
    const t = (await reduce(await s.read(), at(0))).tasks.get("t-9")!;
    expect(t.status).toBe("done");
    expect(t.shows).toBeUndefined();
    expect((await s.read()).events.find((e) => e.id === old.id)).toEqual(old);   // 一个字都没动
  });
});

describe("t-151 · 判据 4：存量只减不增，而且没有任何界面催人去清它", () => {
  it("存量是日志里的一条事实，服务不为它生成任何给人的卡", async () => {
    const w = await world();
    await w.put({ kind: "reading", actor: "qa", surface: "production", key: "unverified.in.production.split", value: { total: 83, human_visible_with_shows: 5, marked_no_human_impact: 0, no_shows_at_all: 78 } }, -20);
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true }, -10);
    const b = board(await st(w.s), HUMAN, at(0));
    // 服务一张卡都没为它发；牌桌上任何给人的话里也不出现那个存量数
    expect(b.needs_human.filter((c) => c.from === SERVICE_ACTOR)).toEqual([]);
    expect(JSON.stringify(b.needs_human)).not.toContain("78");
    // 它作为一条事实在，值挖得到，那一句话里不印值（t-154）
    const r = b.readings.find((x) => x.key === "unverified.in.production.split")!;
    expect((r.value as { no_shows_at_all: number }).no_shows_at_all).toBe(78);
    expect(r.said!.line).not.toContain("78");
  });
});
