/**
 * t-311 判据③ 的另一半，在闸自己身上量：**改记之后，接缝闸真的拿新那一个 sha 去问 git。**
 *
 * core 那一份（`core/test/reevidence.test.ts`）证的是状态里那一格换了；这一份证的是**读它的人换了问法**——
 * 两者缺一不可：一格换了而没人读它，今天那六次免闸一次都省不下来。
 *
 * 量法是把 `isAncestor` 换成一个记账的桩：它把每次被问到的 (祖先, 后代) 原样记下来，**于是「闸问的是哪一个 sha」
 * 不是从结论反推的，是直接读到的**。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, boardTask, type NewEvent, type Board } from "@ateam/core";
import { seamCheck } from "../src/seamcheck.js";
import * as fmt from "../src/format.js";

const HUMAN = "human";
const WAS = "3683577";
const NOW = "530eb9e";
const MINE = "00e6282";

/** 两件撞在同一处的任务：早的那件已交已验（证据记在另一条历史线上），晚的那件正要 done。 */
async function fixture(reRecord: boolean): Promise<Board> {
  const store = new MemoryStore();
  let at = Date.parse("2026-10-30T06:00:00Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((at += 60_000)) });
  await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "git-ancestor" });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-025", title: "早的那件", criteria: ["一条"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-025", touches: ["packages/core/src/rules.ts"] });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-025", evidence: `${WAS}：pd 那一支`, no_human_impact: true });
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-025", surface: "repo", pass: true, evidence: "判过了" });
  // 真的 t-025 就是这个形状：repo 过、production 没过（`✓ repo ✗ production`）。
  // **而这个形状是这条闸看得见它的前提**：`detectSeams` 跳过 `verified`，所以一件两面都过的任务不会再撞上谁。
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-025", surface: "production", pass: false, evidence: "还没上线" });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-311", title: "晚的那件", criteria: ["一条"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-311", touches: ["packages/core/src/rules.ts"] });
  if (reRecord) await emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: "主干上携带同样内容的是 530eb9e" });
  return board(reduce(await store.read()), HUMAN);
}

/** 记下闸每一次问 git 的那一对，并一律答「不含」——这样被问到的 sha 一定出现在拒绝话里，两处都看得见。 */
function asking(): { asked: [string, string][]; isAncestor: (a: string, d: string) => boolean } {
  const asked: [string, string][] = [];
  return { asked, isAncestor: (a, d) => { asked.push([a, d]); return false; } };
}

describe("t-311 判据③ · 接缝闸拿改记之后的那个 sha 去问", () => {
  it("**改记之前**：闸问的是 pd 支上那一笔，于是任何交付都过不了——今天六次免闸的那个形状", async () => {
    const b = await fixture(false);
    const g = asking();
    const out = seamCheck(b, "t-311", `${MINE}：我这一笔`, g.isAncestor);
    expect(g.asked, "闸拿旧那个 sha 去问的").toContainEqual([WAS, MINE]);
    expect(out.errors.join("\n")).toContain(WAS.slice(0, 7));
  });

  it("**改记之后**：同一条接缝，闸问的是主干那一笔——而旧那个它一次都没再问", async () => {
    const b = await fixture(true);
    const g = asking();
    const out = seamCheck(b, "t-311", `${MINE}：我这一笔`, g.isAncestor);
    expect(g.asked).toContainEqual([NOW, MINE]);
    expect(g.asked.map(([a]) => a), "旧那个不再被问——否则改记只是多了一句话，闸没换").not.toContain(WAS);
    expect(out.errors.join("\n")).toContain(NOW.slice(0, 7));
  });

  it("而它真的会过：主干那一笔确实被含着的时候，闸落下一条「已吸收」，不再要人写免除理由", async () => {
    const b = await fixture(true);
    const out = seamCheck(b, "t-311", `${MINE}：我这一笔`, (a) => a === NOW);
    expect(out.errors, "没有拒绝").toEqual([]);
    expect(out.absorbs.length, "闸自己把结论落回日志").toBeGreaterThan(0);
  });
});

/**
 * 判据③ 前半与判据④ 落在同一页上：**人打开 `task show`，判决还在，而两个 sha 都看得见。**
 *
 * 这一格防的是一种很安静的坏结果：证据那一格印的已经是新 sha，而没有任何一行说它被改过——
 * 读的人会以为原来就是这样，于是 pm 15:13 那条通则（搬内容、不嫁接历史，搬完回去改记）缺的那半个工具
 * 变成了一处无从追溯的改写。
 */
describe("t-311 判据③④ · task show 上判决仍在，而两个 sha 都看得见", () => {
  const shown = (b: Board) => fmt.task(boardTask(b, "t-025")!, b.seams, b.omitted);

  it("改记之后：证据那一格是新 sha，紧跟一行说清从哪一笔改到哪一笔、谁改的、为什么", async () => {
    const text = shown(await fixture(true));
    expect(text).toContain("evidence sha re-recorded");
    expect(text, "旧那一笔在同一页上").toContain(WAS);
    expect(text, "新那一笔也在").toContain(NOW);
    expect(text, "来路那句话原样印出来").toContain("主干上携带同样内容的是 530eb9e");
  });

  it("而那张判决一个字没少：谁判的、在哪个表面、过没过，都还在", async () => {
    const text = shown(await fixture(true));
    expect(text).toContain("✓ pass  repo  by qa");
    expect(text).toContain("✗ fail  production  by qa");
  });

  it("没改记过的任务，这一页上一行都不多——这一格自证它看得见差别", async () => {
    const text = shown(await fixture(false));
    expect(text).not.toContain("evidence sha re-recorded");
    expect(text, "没改记过时，页上只有原来那一笔").toContain(WAS);
    expect(text).not.toContain(NOW);
  });
});
