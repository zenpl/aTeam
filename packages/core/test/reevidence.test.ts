/**
 * t-311：**改记一条证据 sha，而不丢掉已经给过的判决。**
 *
 * 这张单的来历是一笔每天都在收的税：t-025 的证据 sha `3683577` 只在 pd 那一支上，而活着这条线上任何一笔交付
 * 都不含它——闸测的是**祖先关系**，所以它永远验不出「已吸收」，今天六次 `--no-seam-check-for` 全是它。
 * 而此刻改不动它：`note "evidence: …"` 只改人读到的那段、不改闸读的那一格，再 `done` 一次又会丢掉 qa 的判决。
 *
 * 所以这一份盯的是两件事，一件都不许松：**闸读到的那个 sha 真的换了**（判据③ 后半），
 * 而**那张判决的 by／surface／时刻一个字没变**（判据③ 前半、pm 16:40「不拿一张判决去换一格记录」）。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, boardTask, Rejected, evidenceSha, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const WAS = "3683577";
const NOW = "530eb9e";
const WHY = "原证据在 pd 支 claude/collaboration-mode-pd-4vqh4i；主干上携带同样两行的是 530eb9e";

async function world() {
  const store = new MemoryStore();
  let at = Date.parse("2026-10-30T06:00:00Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((at += 60_000)) });
  await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "pd", "dev", "qa"] });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-025", title: "判据作者可给已建任务追加判据", criteria: ["pd 也能加"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-025", touches: ["packages/core/src/rules.ts"] });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-025", evidence: `${WAS}：pd 那一支上的那一笔`, no_human_impact: true });
  const verdict = await emit({ kind: "task", op: "verify", actor: "qa", task: "t-025", surface: "repo", pass: true, evidence: "判过了" });
  return { store, emit, verdict };
}
const state = async (store: MemoryStore) => reduce(await store.read());
const task = async (store: MemoryStore) => (await state(store)).tasks.get("t-025")!;
const refusal = async (p: Promise<unknown>): Promise<Rejected> => {
  try { await p; } catch (e) { if (e instanceof Rejected) return e; throw e; }
  throw new Error("expected Rejected");
};

describe("t-311 判据③ · 闸读的那个 sha 换了，而判决一个字没变", () => {
  it("**改记之前**：闸读到的是 pd 支上那一笔——这正是今天六次免闸的全部成因", async () => {
    const { store } = await world();
    const t = await task(store);
    expect(t.evidence_sha, "改记之前这一格是空的：闸回到证据正文里读").toBeUndefined();
    expect(evidenceSha(t.evidence)).toBe(WAS);
    const b = board(await state(store), HUMAN);
    expect(boardTask(b, "t-025")!.evidence_sha).toBe(WAS);
  });

  it("**改记之后**：闸读到的是主干那一笔，而 qa 那张判决的 by／surface／时刻逐字不变", async () => {
    const { store, emit, verdict } = await world();
    const before = await task(store);
    const v0 = [...before.verifications];
    await emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: WHY });
    const t = await task(store);
    // 闸这一侧
    expect(t.evidence_sha, "闸读的那一格是新的那一个").toBe(NOW);
    expect(boardTask(board(await state(store), HUMAN), "t-025")!.evidence_sha).toBe(NOW);
    // 判决这一侧：不是「还有一条判决」，是**同一条**，by／surface／时刻／轮次逐字相同
    expect(t.status, "状态照旧是 verified").toBe("verified");
    expect(t.verifications).toEqual(v0);
    expect(t.verifications[0]).toMatchObject({ id: verdict.id, by: "qa", surface: "repo", pass: true, at: verdict.at, round: 1 });
    expect(t.round, "轮次不动——改记不是新的一轮").toBe(before.round);
    expect(t.criteria, "判据一条不动").toEqual(before.criteria);
  });

  it("判据④ · 两个 sha 都在，而且说得出来路：原证据正文一个字没删", async () => {
    const { store, emit } = await world();
    await emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: WHY });
    const t = await task(store);
    expect(t.evidence, "原证据留着——它仍然指得出那一笔在哪一支").toContain(WAS);
    expect(t.evidence_recorded).toHaveLength(1);
    expect(t.evidence_recorded[0]).toMatchObject({ was: WAS, sha: NOW, by: "dev", why: WHY });
    const h = t.history.filter((x) => x.op === "evidence");
    expect(h, "这一笔也进 history：改记发生过，不许看起来像原来就是这样").toHaveLength(1);
    const b = boardTask(board(await state(store), HUMAN), "t-025")!;
    expect(b.evidence_recorded, "板子上也带着这份来路，不只在 core 里").toHaveLength(1);
  });

  it("改两次就看得出两次：只追加，不覆盖", async () => {
    const { store, emit } = await world();
    await emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: WHY });
    await emit({ kind: "task", op: "evidence", actor: "pm", task: "t-025", sha: "09256fd", why: "整合支上的那一笔" });
    const t = await task(store);
    expect(t.evidence_sha).toBe("09256fd");
    expect(t.evidence_recorded.map((r) => [r.was, r.sha])).toEqual([[WAS, NOW], [NOW, "09256fd"]]);
  });
});

describe("t-311 判据⑤ · 谁可以改，以及不许拿它换别的", () => {
  it("只有 owner 与 pm：qa 不行，**human 也不行**（判据⑤ 的字面，与本仓其余每条「owner／pm／human」的惯例不同）", async () => {
    const { store, emit } = await world();
    expect((await refusal(emit({ kind: "task", op: "evidence", actor: "qa", task: "t-025", sha: NOW, why: WHY }))).message)
      .toContain("only dev (owner) or pm");
    await refusal(emit({ kind: "task", op: "evidence", actor: HUMAN, task: "t-025", sha: NOW, why: WHY }));
    const t = await task(store);
    expect(t.evidence_sha, "被拒的两笔一个都没落下去").toBeUndefined();
  });

  it("owner 自己可以，pm 也可以", async () => {
    const a = await world();
    await a.emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: WHY });
    expect((await task(a.store)).evidence_sha).toBe(NOW);
    const b = await world();
    await b.emit({ kind: "task", op: "evidence", actor: "pm", task: "t-025", sha: NOW, why: WHY });
    expect((await task(b.store)).evidence_sha).toBe(NOW);
  });

  it("形状与来路：分支名不收、HEAD 不收、不说来路不收、同一笔不收", async () => {
    const { store, emit } = await world();
    for (const sha of ["claude/backend-development-gzqbjf", "HEAD", "530EB9E", "530eb"])
      expect((await refusal(emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha, why: WHY }))).message).toContain("--sha takes a 7-40 char hex sha");
    expect((await refusal(emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: "   " }))).message).toContain("--why");
    // 同一笔：拒绝话里带着它此刻是哪一个，否则人只知道「不行」，不知道「已经是它了」
    expect((await refusal(emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: WAS, why: WHY }))).message).toContain(WAS);
    expect((await task(store)).evidence_sha).toBeUndefined();
  });

  it("还没交过的任务没有证据那一格，而拒绝话说出它此刻是什么状态", async () => {
    const store = new MemoryStore();
    let at = Date.parse("2026-10-30T06:00:00Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((at += 60_000)) });
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev"] });
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-9", title: "还没做的", criteria: ["一条"], no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-9", touches: ["x"] });
    const err = await refusal(emit({ kind: "task", op: "evidence", actor: "dev", task: "t-9", sha: NOW, why: WHY }));
    expect(err.message).toContain("t-9 is working");
  });
});

/**
 * **qa 21:3x 在 t-311 的判决里点出的那一格：两边各测一半，中间那一格没人站。**
 *
 * 它说得对，而我核了它指的是哪一行：`reduce.ts` 的 settle 在 **named-sha** 形态下自己判「后者有没有吸收前者」，
 * 那一行也改成了「改记过的优先」，**而本件此前没有一格碰它**——`cli/test/reevidence-gate.test.ts` 量的是
 * git-ancestor 形态（`seamCheck`），既有的 named-sha 用例又住在别的文件里、夹具里没有 `evidence_sha`。
 *
 * **这一格是判决之后补的，不在 `0790894` 里**（我在日志上说明了这件事）：它不改判决覆盖的任何一条，
 * 只是把那一行从「没人站」变成「有一格站着」。对照就在同一条里：后者写旧 sha 的那一支必须**仍然开着**。
 */
describe("t-311 · named-sha 形态：settle 自己判吸收时，读的也是改记之后那个 sha", () => {
  const WHY2 = "原证据在 pd 支；主干上携带同样内容的是 530eb9e";
  /** 两件撞在同一处、都已交；`later` 的证据里写哪个 sha 由参数给。 */
  async function collide(laterNames: string, reRecord: boolean) {
    const store = new MemoryStore();
    let at = Date.parse("2026-10-30T06:00:00Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((at += 60_000)) });
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "named-sha" });
    for (const [id, who] of [["t-025", "dev"], ["t-9", "qa"]] as const) {
      await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["一条"], no_human_impact: true });
      await emit({ kind: "task", op: "claim", actor: who, task: id, touches: ["packages/core/src/rules.ts"] });
    }
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-025", evidence: `${WAS}：pd 那一支`, no_human_impact: true });
    if (reRecord) await emit({ kind: "task", op: "evidence", actor: "dev", task: "t-025", sha: NOW, why: WHY2 });
    await emit({ kind: "task", op: "done", actor: "qa", task: "t-9", evidence: `00e6282：我这一笔，含 ${laterNames}`, no_human_impact: true });
    return (await state(store)).seams.get("seam:t-025+t-9")!;
  }

  it("改记之后，后者写**新** sha ⇒ settle 落下「已吸收」", async () => {
    expect(await collide(NOW, true)).toMatchObject({ absorbed: { later: "t-9", earlier: "t-025" } });
  });

  it("**对照**：同一条接缝，后者写**旧** sha ⇒ 仍然开着（否则这一格对任何输入都说「吸收了」）", async () => {
    const seam = await collide(WAS, true);
    expect(seam.absorbed, "闸要的是改记之后那一个；写旧的那个不算").toBeUndefined();
  });

  it("**而没改记过时，写旧 sha 是算的**——这一格自证它看见的是改记，不是「写新 sha 才算」", async () => {
    expect(await collide(WAS, false)).toMatchObject({ absorbed: { later: "t-9", earlier: "t-025" } });
  });
});
