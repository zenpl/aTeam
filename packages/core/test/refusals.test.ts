/**
 * t-212：拒绝不落成事件——一道闸挡住过谁、挡了几次、挡对没有，机器一条都数不出来。
 *
 * 今晚这个洞三次以不同面目出现（pm 14:49）。它挡住过两件真事：qa 09:04 那条要在生产上走一次的反例，14:57 结不掉，
 * 因为走了也没有证据；dev 15:14 只证得出「没有一条路能走到」，证不出「今天没人走到过」。pm 一个人被拒过至少 12 次，
 * 全部只活在它自己的终端里。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, Rejected, countRefusals, refusedOp, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (m: number) => new Date(T0 + m * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -100);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "题", criteria: ["能用"], no_human_impact: true }, -90);
  return { s, put };
}

describe("t-212 判据 1、4 · 被拒的写入留下一条能数的记录", () => {
  it("一次被拒：账上多一条，带规则名、谁被拒、哪种写入、什么时候", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc", no_human_impact: true }, -50).catch(() => {});
    const rs = await w.s.refusals!();
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ kind: "refused", who: "dev", op: "task:done" });
    expect(rs[0].rule).toBeTruthy();                 // 规则名说得出来
    expect(rs[0].at).toBeTruthy();
    expect(rs[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("成功的写入不产生记录（判据 4 的反面）", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["x"] }, -50);
    expect(await w.s.refusals!()).toEqual([]);
  });

  it("**不存正文**：被拒的内容一个字都不进这本账", async () => {
    const w = await world();
    await w.put({ kind: "note", actor: "dev", body: "这段正文不该出现在拒绝账里" } as NewEvent, -50).catch(() => {});
    await w.put({ kind: "note", actor: "dev" } as NewEvent, -50).catch(() => {});   // 缺 body：形状闸
    const dump = JSON.stringify(await w.s.refusals!());
    expect(dump).not.toContain("不该出现在拒绝账里");
  });

  it("被拒的事件仍然没有发生：日志里找不到它", async () => {
    const w = await world();
    const before = (await w.s.read()).events.length;
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc", no_human_impact: true }, -50).catch(() => {});
    expect((await w.s.read()).events).toHaveLength(before);      // 事件流一条没多
    expect(await w.s.refusals!()).toHaveLength(1);               // 账上多了一条
  });
});

describe("t-212 判据 1 · 能按规则名分组", () => {
  it("数得出总数、按规则名与按人分组，多的在前", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "a", no_human_impact: true }, -50).catch(() => {});
    await w.put({ kind: "note", actor: "qa" } as NewEvent, -49).catch(() => {});
    const c = countRefusals(await w.s.refusals!());
    expect(c.total).toBe(4);
    expect(c.by_rule[0].n).toBe(3);                              // 多的在前
    expect(c.by_who.find((x) => x.who === "dev")?.n).toBe(3);
    expect(c.by_who.find((x) => x.who === "qa")?.n).toBe(1);
    expect(c.first).toBeTruthy();
    expect(c.last).toBeTruthy();
  });

  it("空账数出来是 0——那与「存储答不出来」不同，后者由调用方给 null", () => {
    expect(countRefusals([])).toMatchObject({ total: 0, by_rule: [], by_who: [], first: null, last: null });
  });
});

describe("t-212 · 记在唯一那条写入路径上，所以每个调用方都被数进去", () => {
  it("形状闸与业务闸都记，规则名分得开", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-1" } as NewEvent, -50).catch(() => {});          // shape
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "a", no_human_impact: true }, -50).catch(() => {});  // 业务闸
    const rules = (await w.s.refusals!()).map((r) => r.rule);
    expect(rules).toContain("shape");
    expect(new Set(rules).size).toBe(2);
  });

  it("说不出就给 null，不造一个词：没带 kind 的写入，op 是 null", () => {
    expect(refusedOp({} as { kind?: unknown })).toBeNull();
    expect(refusedOp({ kind: "note" })).toBe("note");
    expect(refusedOp({ kind: "task", op: "done" })).toBe("task:done");
  });
});
