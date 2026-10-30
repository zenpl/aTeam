/**
 * t-222：**闸把已验任务的提交当成了无主提交。**
 *
 * 量出来的样本（生产头 d57acbc → 31b92ae，我在一棵 fetch 全的树上跑 `plan()`）：区间里 12 条提交，闸点名 10 条
 * 为孤儿，而**这 12 条每一条都属于一件已验任务**（t-166×2、t-219×2、t-220×2、t-215×2、t-216×3…）。假阳性 10/10，
 * 而 release 17:10 因此第一次不得不用 `--anyway`——**一道每次都被越过的闸等于没有。**
 *
 * 根不在算法在数据：`base` 是 claim／reopen 那一刻本机 HEAD 的快照，而人往往**先提交、再跑命令**。四件里三件的
 * `base` 与自己的 `evidence` 是同一个 sha（区间 `(x, x]` 是空的），一件的 `base` 比 `evidence` 还新。
 *
 * 这里证两半（判据 2）：这一类不许被算成无主；真无主的照旧点名。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent, type Board } from "@ateam/core";
import { plan, effectiveBase } from "../src/release.js";

const HUMAN = "human";
const sha = (c: string) => c.repeat(7) + "1".repeat(33);
const A = sha("a"), B = sha("b"), C = sha("c"), D = sha("d"), E = sha("e");
const line = [A, B, C, D, E];                                  // A 最老，E 最新，一条线
const lineage = (x: string) => line.slice(0, line.indexOf(x) + 1);
const git = {
  isAncestor: (a: string, d: string) => (line.includes(d) && line.includes(a) ? lineage(d).some((s) => s.startsWith(a) || a.startsWith(s)) : null),
  revList: (from: string, to: string) => {
    if (!line.includes(from) || !line.includes(to)) return null;
    const had = new Set(lineage(from));
    return lineage(to).filter((x) => !had.has(x)).reverse();
  },
};

/** 一件走到 verified 的任务；`rounds` 是每一轮的 (base, evidence)，按顺序。 */
async function world(rounds: { base?: string; evidence: string }[], extra?: (emit: (e: NewEvent) => Promise<unknown>) => Promise<void>): Promise<Board> {
  const store = new MemoryStore();
  let t = Date.now() - 3600_000;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 1000)) });
  await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "git-ancestor" });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "题", criteria: ["x"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["a"] });
  for (const [i, r] of rounds.entries()) {
    if (i > 0) await emit({ kind: "task", op: "reopen", actor: "dev", task: "t-1", reason: "再来一轮" });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: `${r.evidence} 完成`, ...(r.base ? { base_sha: r.base } : {}), no_human_impact: true });
    // 中间那几轮判 fail 才重开得了（verified 是终局）——今天 t-166 三轮正是这么走的
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-1", surface: "repo", pass: i === rounds.length - 1, evidence: "看过了" });
  }
  if (extra) await extra(emit);
  return board(reduce(await store.read()), HUMAN);
}

describe("t-222 判据 1、2 · 起点戳在产出之后的那一类，不许算成无主", () => {
  it("先提交后 claim（base 与 evidence 同一个 sha）：它自己指名的那条提交不再是孤儿", async () => {
    // 生产在 A，这一轮真正的产出是 B，但 base 戳成了 B 本身 ⇒ 区间 (B, B] 是空的
    const b = await world([{ base: B, evidence: B }]);
    const p = plan(b, B, git.isAncestor, A, git.revList);
    expect(p.orphans, "任务自己 done 指名的提交，永远算它的产出").toEqual([]);
    expect(p.ok).toBe(true);
  });

  it("重开过的任务：起点被 reopen 戳到了这一轮的产出上，退到上一轮的证据，中间那几条都有人认领", async () => {
    // 第一轮 (A, B]；第二轮真正的产出是 C、D，而 base 戳成了 D
    const b = await world([{ base: A, evidence: B }, { base: D, evidence: D }]);
    const p = plan(b, D, git.isAncestor, A, git.revList);
    expect(p.orphans, "C 属于第二轮，D 是它自己指名的").toEqual([]);
    expect(p.wide_base, "宽在哪几件要说得出来").toEqual(["t-1"]);
    expect(p.reasons.join("\n")).toContain("起点证不出早于它自己的产出");
    expect(p.ok).toBe(true);
  });

  it("反过来那一半：起点可信时，真没人认领的提交照旧点名", async () => {
    // 区间 (A, B] 老老实实盖住 B；C 是别人塞进来的，没有任何任务盖着
    const b = await world([{ base: A, evidence: B }]);
    const p = plan(b, C, git.isAncestor, A, git.revList);
    expect(p.orphans).toEqual([C]);
    expect(p.ok, "有真孤儿就不该放行").toBe(false);
  });

  it("宽过的窗口之外仍然拦得住：退到上一轮证据之后，再往上的提交还是没人认领", async () => {
    const b = await world([{ base: A, evidence: B }, { base: D, evidence: D }]);
    const p = plan(b, E, git.isAncestor, A, git.revList);
    expect(p.orphans, "E 在这件任务最后一轮的证据之上，谁也没盖着它").toEqual([E]);
    expect(p.ok).toBe(false);
  });

  it("一轮都拿不出可信起点时说不清，但**只对它那一段说不清**：窗口里不诬告，窗口之上照旧点名", async () => {
    // base 比 evidence 还新，也没有上一轮可退 ⇒ 它到底做了 (A, B] 里的哪几条，说不清
    const b = await world([{ base: C, evidence: B }]);
    const p = plan(b, B, git.isAncestor, A, git.revList);
    expect(p.unknown_span, "说不清要说出来是哪一件").toEqual(["t-1"]);
    expect(p.orphans, "它自己那一段不诬告").toEqual([]);
    expect(p.wide_base).toEqual([]);
    // 同一件说不清的任务，挡不住它证据之上那条提交被点名——那一条与它无关
    const above = plan(b, D, git.isAncestor, A, git.revList);
    expect(above.orphans, "C、D 在它的证据之上，说不清它不该替它们挡着（新到旧）").toEqual([D, C]);
    expect(above.ok).toBe(false);
  });
});

describe("t-222 · effectiveBase 三种答案各自可核", () => {
  const task = (base: string | undefined, dones: string[]) => ({
    id: "t-1", base_sha: base,
    history: dones.map((e) => ({ op: "done", id: e, by: "dev", at: "", round: 1, evidence: `${e} 完成` })),
  }) as unknown as Parameters<typeof effectiveBase>[0];

  it("起点证得出早于产出 ⇒ 原样用它，不放宽", () => {
    expect(effectiveBase(task(A, [B]), B, git.isAncestor)).toEqual({ base: A, widened: false });
  });
  it("起点与产出同一个 sha ⇒ 退到上一轮的证据，并标记放宽过", () => {
    expect(effectiveBase(task(D, [B, D]), D, git.isAncestor)).toEqual({ base: B, widened: true });
  });
  it("既没有可信起点、也没有上一轮 ⇒ 给不出答案（说不清，交给 unknown_span）", () => {
    expect(effectiveBase(task(D, [D]), D, git.isAncestor)).toEqual({ base: undefined, widened: false });
  });
});
