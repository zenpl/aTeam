/**
 * t-280 的反例，pm 03:24 点名要我先证它：**唯一能推翻「只因目录包住就只记不挡」这条建议的，是 t-248+t-271。**
 *
 * 它是在案 12 条纯目录接缝里唯一被写成 `verdict=real` 的一条，而 pm 当时的裁词说得很清楚：两侧改的文件
 * 「不相交」，它的价值不在挡 `done`，在最后那句「**合并义务同前：后落地的是 t-248**」。
 * 所以 ①′ 要成立，必须证明：**变轻之后，那句合并义务一个字都没少。**
 *
 * 下面三条按真实形态各钉一处，包括我自己要付的那一份代价（第三条），不藏：
 * ① 已裁的接缝 —— `seamWarnings` 只看 `resolved`，不看 `light`：照旧要求先合并对方的 sha；
 * ② 我在对方 done 之后才 claim（stacked）—— `seamCheck` 那一支同样不看 `light`：照旧拦住 `done`；
 * ③ **代价**：两边都在途、对方先交、还没有人裁 —— 变轻之后这条不再自动吸收、也不再挡人。
 *    这正是 ①′ 用「6 条人工裁决」换来的那一格，写成断言而不是写成一句话。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, openSeamsFor, type NewEvent } from "@ateam/core";
import { seamCheck, seamWarnings } from "../src/seamcheck.js";

const HUMAN = "human";
const THEIRS = "abc1234";       // t-271 的证据 sha
const MINE = "def5678";         // t-248 的证据 sha
/** t-248 逐字的声明里与这条接缝有关的那几条；t-271 只声明了一个文件。 */
const DIR = ["packages/server/src/html.ts", "packages/server/test", "packages/server/test/criteria-added.test.ts"];
const FILE = ["packages/server/test/owed-endpoint.test.ts"];

/** `late` 决定时序：我（t-248）是在对方 done 之前 claim 的，还是之后（之后＝ stacked）。 */
async function world(opts: { late?: boolean; resolution?: string } = {}) {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  for (const [id, title] of [["t-271", "对方"], ["t-248", "我的"]])
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["x"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-271", touches: [...FILE] });
  if (!opts.late) await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-248", touches: [...DIR] });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-271", evidence: `${THEIRS}: 做完了`, touches: [...FILE], no_human_impact: true });
  if (opts.late) await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-248", touches: [...DIR] });
  if (opts.resolution) await emit({ kind: "task", op: "seam", actor: "pm", tasks: ["t-248", "t-271"], resolution: opts.resolution, verdict: "real" });
  const st = reduce(await store.read());
  return { st, b: board(st, HUMAN), seam: [...st.seams.values()].find((s) => s.tasks.includes("t-271"))! };
}

describe("t-280 · 变轻之后，合并义务还在不在", () => {
  it("①（反例本身）已裁的接缝：接缝是轻的、不挡 done，而「先合并对方的 sha」照旧说得出来", async () => {
    const { b, seam } = await world({ resolution: "不相交。合并义务同前：后落地的是 t-248" });
    expect(seam.light, "两侧没指名过同一个文件，只有目录包住").toBe(true);
    const lines = seamWarnings(b, "t-248", `${MINE}: 我的`, (theirs, mine) => (theirs === THEIRS && mine === MINE ? false : null));
    expect(lines.length, "改前改后都该有这一句").toBe(1);
    expect(lines[0]).toContain(THEIRS);
    expect(lines[0]).toContain("t-271");
  });

  it("② 我在对方 done 之后才 claim（stacked）：轻不轻都拦得住，出路是写明合并了哪个 sha", async () => {
    const { b, seam } = await world({ late: true });
    expect(seam.light).toBe(true);
    const r = seamCheck(b, "t-248", `${MINE}: 我的`, () => null);
    expect(r.errors.length, "这一支不看 light").toBe(1);
    expect(r.errors[0]).toContain(THEIRS.slice(0, 7));
    // 证据里写明了就放行，但要留痕，不是静默
    const named = seamCheck(b, "t-248", `${MINE}: 我的，已合并 ${THEIRS}`, () => null);
    expect(named.errors).toEqual([]);
    expect(named.unverified.length).toBe(1);
  });

  it("③ 代价：两边都在途、对方先交、没有人裁 —— 变轻之后不挡人，也不再自动吸收", async () => {
    const { st, b, seam } = await world();
    expect(seam.light).toBe(true);
    expect(openSeamsFor(st, "t-248"), "不再挡住我的 done").toEqual([]);
    const r = seamCheck(b, "t-248", `${MINE}: 我的`, () => true);
    expect(r.errors).toEqual([]);
    expect(r.absorbs, "改前这里会写一条自动吸收的裁决，改后不会——这是这一格的代价").toEqual([]);
    // 而它没有消失：牌桌照旧印着它，人照旧可以裁，一裁就回到第 ① 条
    expect(b.contained_seams.find((x) => x.id === seam.id)).toMatchObject({ light: true, open: false, contained: true });
  });
});
