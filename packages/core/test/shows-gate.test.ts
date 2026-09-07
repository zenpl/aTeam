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
import { readFileSync } from "node:fs";
import { MemoryStore, append, reduce, board, Rejected, NO_HUMAN_IMPACT, touchesHumanVisible, SERVICE_ACTOR, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "题", criteria: ["能用"] , no_human_impact: true}, -200);
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
      { id: "01OLDCREATE00000000000000", at: at(-120).toISOString(), kind: "task", op: "create", actor: "pm", task: "t-9", title: "旧的一件", criteria: ["能用"] , no_human_impact: true},
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

/**
 * pd 07:49 定稿并加的三条：那句话写成「不改变人看到的东西」——主语是这件活不是人，断言的是人可见那一面没变，
 * 不是「这件事不重要」；它永远由人写，不许默认或自动填；碰了人看得到的东西却写它的，闸当场拒绝并列出碰到的。
 */
describe("t-151 · pd 07:49 的三条", () => {
  it("措辞是 pd 定的那一句，core 一处，拒绝话与说明书都引它、不各写一份", () => {
    expect(NO_HUMAN_IMPACT).toBe("不改变人看到的东西");
    const manual = readFileSync(new URL("../manual/common.md", import.meta.url), "utf8");
    const rules = readFileSync(new URL("../src/rules.ts", import.meta.url), "utf8");
    expect(manual).not.toContain(NO_HUMAN_IMPACT);          // 说明书不抄那句话，它教的是那个开关
    expect(manual).toContain("--no-human-impact");
    expect(rules).not.toContain(`"${NO_HUMAN_IMPACT}"`);     // 规则里也不抄，引的是常量
    expect(rules).toContain("NO_HUMAN_IMPACT");
  });

  it("碰了人看得到的东西却写这句：拒绝，并把碰到的逐个列出来", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true, touches: ["packages/server/src/i18n.ts", "packages/core/src/reduce.ts"] }, -10).catch((e) => e as Rejected);
    expect(err.rule).toBe("done");
    expect(err.message).toContain("packages/server/src/i18n.ts");
    expect(err.message).not.toContain("packages/core/src/reduce.ts");   // 只列人看得到的那几处
    expect(err.message).toContain(NO_HUMAN_IMPACT);
    expect(err.message).toContain("--shows");                            // 出路
  });

  it("t-170 第二轮：人可见的文件一律算碰了；出路是一句具体到符号的话，不是一个开关", async () => {
    const w = await world();
    // ① 只装文本的地方：改它就是改人看到的字
    for (const t of ["packages/server/src/i18n.ts", "packages/server/src/i18n.ts#releaseCanGo", "packages/core/manual/common.md"]) {
      expect(touchesHumanVisible(t), t).toBe("human_visible");
    }
    // ② core 里那些 key 本身
    for (const t of ["packages/core/src/events.ts#BATCH_LINES", "packages/core/src/board.ts#missingCard", "packages/core/src/events.ts#REACH_WORDS"]) {
      expect(touchesHumanVisible(t), t).toBe("human_visible");
    }
    // ③ 人可见的文件：带不带符号都算碰了——qa 08:32 判不过我第一版按符号自动放过的做法，理由成立：
    // t-163 今晚改了在途四行字，而它的真实触点在那一版下可以合法说「不改变人看到的东西」。
    for (const t of ["packages/server/src/html.ts#justDeferred", "packages/server/src/html.ts", "packages/cli/src/format.ts"]) {
      expect(touchesHumanVisible(t), t).toBe("human_visible");
    }
    for (const t of ["packages/server/test/html.test.ts", "packages/core/src/reduce.ts", "packages/cli/src/loop.ts", "packages/core/test/replay.test.ts"]) {
      expect(touchesHumanVisible(t), t).toBe("internal");
    }
    // 改一个用例不改变任何人看到的东西：可以说这句
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true, touches: ["packages/server/test/html.test.ts"] }, -10);
    expect((await st(w.s)).tasks.get("t-1")!.status).toBe("done");
  });

  it("done 带了触点就按触点判，不拿 claim 时那份被本人更正过的声明去拦他（t-105 的口径）", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["packages/server/src/html.ts"] }, -20);
    // 实际量下来只碰了内部文件：那份声明已经被更正，就不该再拿它拦人
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true, touches: ["packages/core/src/reduce.ts"] }, -10);
    expect((await st(w.s)).tasks.get("t-1")!.status).toBe("done");
  });

  it("这句永远由人写：代码里没有任何地方替他填上它", () => {
    // core 与 cli 的源码里，no_human_impact 只有三种出现：类型声明、规则读它、CLI 从一个显式开关取它。
    // 没有任何一处把它默认成 true——默认一次，这个问题就再也不会被问第二次。
    // 唯一可以写出 `no_human_impact: true` 的地方，是那一行同时读着显式开关；core 里一次都不许出现。
    const cli = readFileSync(new URL("../../cli/src/main.ts", import.meta.url), "utf8");
    expect(cli).toContain('bool(a, "no-human-impact")');
    for (const line of cli.split("\n")) {
      if (/no_human_impact\s*:\s*true/.test(line)) expect(line, `main.ts 里这一行没读开关就填了它：${line.trim()}`).toContain('bool(a, "no-human-impact")');
    }
    for (const p of ["../src/rules.ts", "../src/events.ts", "../src/build.ts", "../src/reduce.ts", "../src/board.ts"]) {
      const src = readFileSync(new URL(p, import.meta.url), "utf8");
      expect(src, `${p} 里替人填了这句`).not.toMatch(/no_human_impact\s*[:=]\s*true/);
    }
  });
});

/**
 * t-170 判据 5（我提的，pd 08:23 记了一笔）：**修误报的这一版，要把原来真被拦下的那几种形状逐条重跑**，
 * 每条的出路仍然成立——不许为了修误报而把真该拦的放过去。qa 08:20 在仓库表面跑过九种形状（探针 p151fp.mjs），
 * 下面照它那份清单重跑：四种纯内部的仍然过，真改字的仍然被拦，而它指出的那一种真误报（t-165 的形状）现在过。
 */
describe("t-170 · 逐条重跑 qa 08:20 那份清单", () => {
  const donex = async (w: Awaited<ReturnType<typeof world>>, touches: string[], internal_only?: string[]) =>
    w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true, touches, ...(internal_only ? { internal_only } : {}) }, -10)
      .then(() => "过" as const)
      .catch((e) => (e as Rejected).message);
  const done = (w: Awaited<ReturnType<typeof world>>, touches: string[]) => donex(w, touches);

  it("四种纯内部形状：修前修后都过", async () => {
    for (const touches of [
      ["packages/core/src/rules.ts"],
      ["packages/server/src/app.ts", "packages/core/src/reduce.ts"],
      ["packages/server/test/html.test.ts"],
      ["packages/core/test/replay.test.ts"],
    ]) {
      expect(await done(await world(), touches), touches.join("、")).toBe("过");
    }
  });

  it("真改了人看到的字：仍然被拦，而且指得出是哪一处", async () => {
    for (const [touches, hit] of [
      [["packages/server/src/i18n.ts#releaseCanGo"], "packages/server/src/i18n.ts#releaseCanGo"],
      [["packages/core/manual/common.md"], "packages/core/manual/common.md"],
      [["packages/core/src/events.ts#BATCH_LINES"], "packages/core/src/events.ts#BATCH_LINES"],
      [["packages/core/src/reduce.ts", "packages/server/src/i18n.ts"], "packages/server/src/i18n.ts"],
    ] as const) {
      const r = await done(await world(), [...touches]);
      expect(r, touches.join("、")).not.toBe("过");
      expect(r).toContain(hit);                    // 判据 2：列出它认定的那一处，人才能反驳
      expect(r).toContain("--shows");              // 出路仍然成立
      expect(r).toContain("不对就改触点");           // 反驳的办法也说了
    }
  });

  it("t-165 那种形状：光说「不改变人看到的东西」仍然被拒，但拒绝话里给出那条具名出路", async () => {
    const r = await done(await world(), ["packages/server/src/html.ts#justDeferred"]);
    expect(r).not.toBe("过");
    expect(r).toContain("--internal-only");
    expect(r).toContain("写不出符号名，就说明还没看清自己改了什么");
  });

  it("具体到符号就放行——它要的不是一个开关，是一次注意", async () => {
    // 判据 8：名出来的符号要在触点里，所以触点本身就得带着它
    expect(await donex(await world(), ["packages/server/src/html.ts", "packages/server/src/html.ts#justDeferred"], ["packages/server/src/html.ts#justDeferred"])).toBe("过");
  });

  it("判据 8 (pm 08:46)：编一个符号名过不去——qa 实测能用 `i18n.ts#随便编` 蒙混的那条路堵上了", async () => {
    const r = await donex(await world(), ["packages/server/src/html.ts"], ["packages/server/src/html.ts#编的"]);
    expect(r).not.toBe("过");
    expect(r).toContain("不在这件的触点里");
  });

  it("qa 08:46 ②：具名出路只属于「人可见文件里的内部符号」，①②两档不接受它", async () => {
    for (const [touch, named] of [
      ["packages/server/src/i18n.ts", "packages/server/src/i18n.ts#随便编"],
      ["packages/core/manual/common.md", "packages/core/manual/common.md#随便编"],
      ["packages/core/src/events.ts#BATCH_LINES", "packages/core/src/events.ts#别的符号"],
    ] as const) {
      const r = await donex(await world(), [touch, named], [named]);
      expect(r, touch).not.toBe("过");
      expect(r).toContain("不能用 --internal-only 解释掉");
    }
  });

  it("符号必须真的落在被拦的那几处文件里，否则一句话可以拿任何符号名蒙混过去", async () => {
    const r = await donex(await world(), ["packages/server/src/html.ts", "packages/server/src/i18n.ts"], ["packages/server/src/html.ts#justDeferred"]);
    expect(r).not.toBe("过");
    expect(r).toContain("packages/server/src/i18n.ts");   // 这一处还没说清动了里面的什么
  });

  it("写不出「文件#符号」就不算具体到符号", async () => {
    const r = await donex(await world(), ["packages/server/src/html.ts"], ["justDeferred"]);
    expect(r).not.toBe("过");
    expect(r).toContain("要写成「文件#符号」");
  });
});

/**
 * t-171 (pd 08:27)：**承诺那头也要有闸。**
 *
 * 今晚 83 件里 78 件说不出人能看到什么。问题不在交活的人身上：没有人在**建**它的时候问过这个问题，而等到交活时
 * 才第一次被问，范围已经定死了，答案只能是把已经做的事描述一遍。所以两头同形状、同常量、同一句拒绝话。
 */
describe("t-171 · 建任务时也要说清它对人有什么影响", () => {
  const create = async (w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown>) =>
    w.put({ kind: "task", actor: "pm", op: "create", task: "t-新", title: "题", criteria: ["能用"], ...extra }, -10)
      .then(() => "过" as const)
      .catch((e) => (e as Rejected).message);

  it("两句都没有：拒绝，出路与 done 那头一模一样", async () => {
    const r = await create(await world(), {});
    expect(r).not.toBe("过");
    expect(r).toContain("--shows");
    expect(r).toContain("--no-human-impact");
    expect(r).toContain(NO_HUMAN_IMPACT);
    expect(r).toContain("空着不算「没影响」");
  });

  it("说了人会看到什么、或明写没有：都过，而且承诺留在任务上", async () => {
    const w1 = await world();
    expect(await create(w1, { shows: "牌桌第一行会是版本号" })).toBe("过");
    expect((await st(w1.s)).tasks.get("t-新")).toMatchObject({ promise: "牌桌第一行会是版本号" });
    const w2 = await world();
    expect(await create(w2, { no_human_impact: true })).toBe("过");
    expect((await st(w2.s)).tasks.get("t-新")).toMatchObject({ promise_none: true, promise: undefined });
  });

  it("两句都写就是自相矛盾，也拒绝", async () => {
    expect(await create(await world(), { shows: "人能看到 X", no_human_impact: true })).toContain("互相矛盾");
  });

  it("判据 2：同一句拒绝话——两头只写一遍，改一处两头一起变", () => {
    const rules = readFileSync(new URL("../src/rules.ts", import.meta.url), "utf8");
    // 这句话只有一个出处（humanImpactPromised），两头都调它；rules.ts 里搜不到第二份「空着不算」
    expect([...rules.matchAll(/空着不算/g)]).toHaveLength(1);
    expect([...rules.matchAll(/humanImpactPromised\(/g)].length).toBe(3);   // 一处定义 + create 与 done 各调一次
  });

  it("判据 4：不追溯——日志里已有的任务不受影响", async () => {
    const s = new MemoryStore();
    for (const e of [
      // 这一条是「口径之前」的形状：既没有 shows，也没有那句明写——直接写进日志，不走校验
      { id: "01OLDCREATE00000000000000", at: at(-120).toISOString(), kind: "task", op: "create", actor: "pm", task: "t-旧", title: "口径之前建的", criteria: ["能用"] },
      { id: "01OLDCLAIM000000000000000", at: at(-110).toISOString(), kind: "task", op: "claim", actor: "dev", task: "t-旧", touches: ["x"] },
    ]) await s.appendRaw(e as never);
    const t = (await reduce(await s.read(), at(0))).tasks.get("t-旧")!;
    expect(t.status).toBe("working");
    expect(t.promise).toBeUndefined();
    expect(t.promise_none).toBeUndefined();   // 它没有承诺，但也不因此变成不合格
  });
});
