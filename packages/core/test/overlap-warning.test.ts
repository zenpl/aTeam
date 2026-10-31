/**
 * t-345（pm 20:25 自己撞上并记成 friction 的那一次，我按归属引）：**照这条预警的建议做，它要认。**
 *
 * 它的 hint 写着「改决定用 `--supersedes`」。pm 20:17 照着做了——用一条**第三方**决策取代了那一对里的
 * 一条——20:24 再量，预警一字不差地报同一条。判法此前只认那一对里**互指**，所以照它说的做，它不认：
 * 这条预警没有出口，队里每个人每次 board 都会再读到它一遍，而没有任何动作能让它消失（只剩 4 小时窗口滑出）。
 *
 * **落点我在自己这棵树上重量过**（判据 6）：判法在 `packages/core/src/allocation.ts` 的「重叠 (runtime)」那一段
 * （本支 40a3e9e 上是 208-230 行），窗口常量 `ALLOCATION_WINDOW_MS` 在同文件 91 行（4 小时）。
 * pm 读的是生产那一版（`30aa368:packages/core/src/allocation.ts:173-191`、`:56`），行号对不上是两棵树的差，不是两件事。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, runtimeAllocation, ALLOCATION_WINDOW_MS, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-31T20:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);

/** 一对十分钟内、互不取代的决策——预警要的那个形状。 */
async function pair() {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "pd", "dev"] }, 0);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "x", criteria: ["x"], no_human_impact: true }, 1);
  const a = await put({ kind: "note", actor: "pd", body: "决策：A", decision: true, task: "t-1" }, 2);
  const b = await put({ kind: "note", actor: "pm", body: "决策：B", decision: true, task: "t-1" }, 3);
  return { s, put, a, b };
}
const warnings = async (s: MemoryStore, m: number) => runtimeAllocation(reduce(await s.read(), at(m), HUMAN), at(m), HUMAN);
const overlap = async (s: MemoryStore, m = 10) => (await warnings(s, m)).find((w) => w.pattern === "重叠");

describe("t-345 · 照它的建议做，它要认", () => {
  it("**判据 4 的正方向**：一对互不取代的决策 ⇒ 报", async () => {
    const w = await pair();
    expect((await overlap(w.s))?.evidence[0]).toContain("十分钟内有两条互不取代的决策");
  });

  it("**判据 1、4 的反方向**：第三方的 --supersedes 指着那一对中的一条 ⇒ 不再报", async () => {
    const w = await pair();
    // pm 20:17 做的正是这个动作：一条**第三方**（dev）的决策取代那一对里的一条
    await w.put({ kind: "note", actor: "dev", body: "决策：以 A 为准", decision: true, task: "t-1", supersedes: w.a.id }, 5);
    expect(await overlap(w.s), "照 hint 说的做了，它必须认").toBeUndefined();
  });

  it("那一对里互指照旧认（没有把原来成立的那一半弄坏）", async () => {
    const s = new MemoryStore();
    const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "pd"] }, 0);
    await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "x", criteria: ["x"], no_human_impact: true }, 1);
    const a = await put({ kind: "note", actor: "pd", body: "决策：A", decision: true, task: "t-1" }, 2);
    await put({ kind: "note", actor: "pm", body: "决策：B", decision: true, task: "t-1", supersedes: a.id }, 3);
    expect(await overlap(s)).toBeUndefined();
  });

  it("**取代不限在回看窗口内**：窗口管的是「这一对有多新」，不是「处置有多新」", async () => {
    const w = await pair();
    await w.put({ kind: "note", actor: "dev", body: "决策：以 A 为准", decision: true, task: "t-1", supersedes: w.a.id }, 5);
    // 那一对还在窗口里（3.5 小时前），而处置就在它之后不久；换一个更晚的「现在」再量一次，仍然不报
    const late = ALLOCATION_WINDOW_MS / 60_000 - 20;
    expect(await overlap(w.s, late), "处置是存在不存在的事，不是新不新的事").toBeUndefined();
  });

  it("**判据 2**：报的时候带上那一对的时刻——窗口滑出与被处置，不再长成同一种消失", async () => {
    const w = await pair();
    const text = (await overlap(w.s))!.evidence[0];
    expect(text, "两条各带自己的时刻").toMatch(/（pd \w+@\d\d:\d\d 与 pm \w+@\d\d:\d\d）/);
    expect(text).toContain("@20:02");     // 那一对真正发生的时刻，不是现在
    expect(text).toContain("@20:03");
  });

  it("**判据 2 的另一半**：窗口滑出之后它不再报，而那一对的时刻说得出它为什么走的", async () => {
    const w = await pair();
    const past = ALLOCATION_WINDOW_MS / 60_000 + 5;      // 那一对已经滑出 4 小时窗口
    expect(await overlap(w.s, past), "窗口滑出 ⇒ 不报").toBeUndefined();
    // 而在它还在报的那一刻，印出来的时刻就是判断依据：时刻贴着窗口边缘 ⇒ 它快到期了；时刻还新 ⇒ 真被处置掉的
    const edge = ALLOCATION_WINDOW_MS / 60_000 - 5;
    expect((await overlap(w.s, edge))!.evidence[0]).toContain("@20:02");
  });

  it("**判据 3**：hint 建议的那个动作，正是能让它消失的那个", async () => {
    const w = await pair();
    const hint = (await overlap(w.s))!.hint;
    expect(hint).toContain("--supersedes");
    await w.put({ kind: "note", actor: "dev", body: "决策：以 A 为准", decision: true, task: "t-1", supersedes: w.a.id }, 5);
    expect(await overlap(w.s), "hint 里那句话此刻是实话").toBeUndefined();
  });
});
