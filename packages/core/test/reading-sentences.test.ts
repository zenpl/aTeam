/**
 * t-154 (pd 07:14)：牌桌只说一条事实的**一句话**，不印它的值。
 *
 * 今天的洞：读数那一节把 `surface:key = <值>` 直接印出来，于是 production:deployed.tasks 在人眼前是一段 83 个
 * 任务 id 的 JSON。人从那段里得不到任何东西，它占掉的正是他本该用来读别的话的注意力。
 *
 * 时间一律相对 now。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, sampleLog, sayReading, sayingFor, READING_SAYINGS, DEPLOYED_TASKS_KEY, BATCH_PREFIX, BATCH_SURFACE, PROJECT_SURFACE, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: "roles", value: ["pm", "dev", "qa", "release"] }, -300);
  return { s, put };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-154 · 判据 1 与 2：声明了就说那一句，没声明就退化；标量不受影响", () => {
  it("deployed.tasks 说的是「这一版带上了 N 件」，那段 id 一个都不进这句话", async () => {
    const v = { sha: "b3e3c53", contained: ["t-1", "t-2", "t-3"], not_contained: ["t-4"], method: "git-ancestor（逐件测）" };
    const said = sayReading({ surface: "production", key: DEPLOYED_TASKS_KEY, value: v, by: "release", at: at(-5).toISOString() }, at(0))!;
    expect(said).toMatchObject({ line: "这一版带上了 3 件", declared: true, said_elsewhere: true });
    for (const id of [...v.contained, ...v.not_contained, v.sha, v.method]) expect(said.line).not.toContain(id);
  });

  it("没有声明的结构化事实退化成「<名字> 由 X 在 N 分钟前记下」，值不在里面", async () => {
    const v = { n: 40, window: "03:02-03:44 UTC", seconds: { p50: 34.94, max: 80.77 } };
    const said = sayReading({ surface: "production", key: "wait.cli", value: v, by: "qa", at: at(-12).toISOString() }, at(0))!;
    expect(said).toEqual({ line: "production:wait.cli 由 qa 在 12 分钟前记下", declared: false, said_elsewhere: false });
    expect(said.line).not.toContain("34.94");
  });

  it("形状不对就退化，不猜一个数——猜错的数比不说更坏", async () => {
    const said = sayReading({ surface: "production", key: DEPLOYED_TASKS_KEY, value: { sha: "abc1234" }, by: "release", at: at(-3).toISOString() }, at(0))!;
    expect(said.declared).toBe(false);
    expect(said.line).toBe("这一版带上的活 由 release 在 3 分钟前记下");
  });

  it("判据 2：标量照旧，没有这个字段", async () => {
    for (const v of ["b3e3c53", 128, true, null]) {
      expect(sayReading({ surface: "production", key: "deployed.sha", value: v, by: "release", at: at(-1).toISOString() }, at(0))).toBeNull();
    }
  });

  it("一族一个说法：repo:batch.<名> 都走同一条声明", async () => {
    for (const name of ["batch.11", "batch.12", "batch.8b"]) {
      expect(sayingFor(BATCH_SURFACE, name)?.name).toBe("装好的一批");
      expect(sayReading({ surface: BATCH_SURFACE, key: name, value: { sha: "a", base: "b", contains: ["t-1", "t-2"] }, by: "release", at: at(-2).toISOString() }, at(0))!.line).toBe("这一批装了 2 件");
    }
    expect(sayingFor(BATCH_SURFACE, "url")).toBeUndefined();
  });
});

describe("t-154 · 判据 3：任何对象值都不出现在那一行", () => {
  it("牌桌上每一条结构化事实的那句话里，都找不到它的值", async () => {
    const w = await world();
    // 生产上真实存在的形状，取自 2026-09-07 的日志
    const real: [string, string, unknown][] = [
      ["production", DEPLOYED_TASKS_KEY, { sha: "b3e3c53", contained: ["t-005", "t-004"], not_contained: ["t-130"], method: "git-ancestor（ateam release 逐件测）" }],
      [BATCH_SURFACE, `${BATCH_PREFIX}12`, { sha: "b23b325", base: "b3e3c53", contains: ["t-130", "t-131", "t-133"] }],
      ["production", "wait.cli", { n: 40, window: "03:02-03:44 UTC", seconds: { p50: 34.94 }, over_3s: 35 }],
      ["production", "s2.walk", { 口径: "只能观察（pd 05:03）：最近一次真实发生、当时走通没有", occurrences: 3, walked: 2 }],
      [PROJECT_SURFACE, "deploy.enabled", { branch: "production", by: ["release"] }],
    ];
    for (const [surface, key, value] of real) await w.put({ kind: "reading", actor: "release", surface, key, value }, -6);
    const b = board(await st(w.s), HUMAN, at(0));
    const structured = b.readings.filter((r) => r.value && typeof r.value === "object");
    // 五条真实形状，加上 world() 里那条 project:roles（数组也是结构化的）
    expect(structured.map((r) => `${r.surface}:${r.key}`).sort()).toEqual([...real.map(([s2, k]) => `${s2}:${k}`), `${PROJECT_SURFACE}:roles`].sort());
    for (const r of structured) {
      expect(r.said, `${r.surface}:${r.key} 没有那一句话`).toBeTruthy();
      // 值里每一个字符串与数字，都不出现在那句话里（任务 id、sha、窗口、口径那句长中文……）
      const bits: string[] = [];
      const walk = (v: unknown) => {
        if (typeof v === "string" || typeof v === "number") bits.push(String(v));
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(r.value);
      for (const bit of bits) {
        if (bit.length < 3) continue;   // "3"、"40" 这种短数字会与句子里的计数撞车，本来就不是「值泄漏」
        if (bit === r.by) continue;     // 退化那句里的「由 <谁> 记下」是 pd 定的形式；记录者恰好也出现在值里不算泄漏
        expect(r.said!.line, `${r.surface}:${r.key} 的那句话里出现了值「${bit}」`).not.toContain(bit);
      }
    }
  });

  it("标量事实照旧没有这个字段，渲染方仍然直接印值", async () => {
    const w = await world();
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "b3e3c53" }, -4);
    const b = board(await st(w.s), HUMAN, at(0));
    expect(b.readings.find((r) => r.key === "deployed.sha")!.said).toBeUndefined();
  });
});

describe("t-154 · 判据 4 与 5", () => {
  it("「这条是否已在别处说过」由 core 给信号，渲染方不自己判断", async () => {
    expect(sayingFor("production", DEPLOYED_TASKS_KEY)!.said_elsewhere).toBe(true);
    const un = sayReading({ surface: "production", key: "wait.page", value: { n: 40 }, by: "qa", at: at(-1).toISOString() }, at(0))!;
    expect(un.said_elsewhere).toBe(false);
  });

  it("判据 5：样本日志里每一条被声明过的形状都真的有，且是从声明处取的，不手写", async () => {
    const log = await sampleLog();
    const readings = log.events.filter((e) => e.kind === "reading");
    for (const x of READING_SAYINGS) {
      if (x.saying.service_writes) continue;   // 服务自己写的那条，样本不造，否则与真日志对不上（t-062 那道闸）
      const hit = readings.find((e) => e.surface === x.surface && (x.prefix ? e.key.startsWith(x.key) : e.key === x.key));
      expect(hit, `样本日志里没有 ${x.surface}:${x.key} 这个形状`).toBeTruthy();
      expect(hit!.value).toEqual(x.saying.sample);   // 值就是声明旁边那一个，没有第二份手写的副本
    }
  });

  it("样本里那些形状真的是结构化的，且每一条都算得出一句话——这正是今天漏掉的那种覆盖", async () => {
    const log = await sampleLog();
    const structured = log.events.filter((e) => e.kind === "reading" && e.value && typeof e.value === "object");
    expect(structured.length).toBeGreaterThanOrEqual(READING_SAYINGS.filter((x) => !x.saying.service_writes).length);
    for (const e of structured) {
      const said = sayReading({ surface: e.surface!, key: e.key, value: e.value, by: e.actor, at: e.at }, new Date(Date.parse(e.at) + 60_000))!;
      expect(said.line.length).toBeGreaterThan(0);
    }
  });
});
