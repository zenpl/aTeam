/**
 * t-347（t-344 自报的那个缺口的另一半）：**人在牌桌点「过」那一路也要说出是哪条支。**
 *
 * t-344 把「`repo` 验收必须带支名」落成了闸，而人点「过」那一路我放过了——那条验收是**服务替他组装**的，
 * 而服务手上没有仓库。我把它当缺口写进了 t-344 的证据：**一个角色若想绕开支名，可以不自己验、改去请人判。**
 *
 * 这一单堵它：支名从那件 `done` 抄（`done --branch`，命令行从本地 git HEAD **量**出来，不猜）；
 * 抄不到就带一个记号，板上那一档另有一句话（pd 00:00 的定稿 `01M6A6FGCHXXF2MVH5BMKF36HW`，照抄）。
 * **两种「没有支名」不共用一句话**：存量是「当时没有记」（下一步：自己核那条支），
 * 这一档是「此刻服务不知道」（下一步：拿它证据里的 sha 查）。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, runFollowUps, Rejected, verifiedSurface, surfaceResults,
  VERIFY_BRANCH_BY_HUMAN, VERIFY_BRANCH_BY_HUMAN_SHORT, VERIFY_BRANCH_BY_HUMAN_WHY, VERIFY_BRANCH_UNRECORDED, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);
const DELIVERY = "claude/backend-development-gzqbjf";

/** 一件交完、等人判的任务；`branch` 给 undefined 就是「那件 done 没带支名」。 */
async function waiting(branch?: string) {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev"] }, 0);   // 没有 qa：验收自动进人那一页（t-055）
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "一件", criteria: ["能用"], no_human_impact: true }, 1);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["a.ts"] }, 2);
  const done = await put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234：做完了", no_human_impact: true, ...(branch ? { branch } : {}) }, 3);
  // t-055：项目里没有验收角色时，服务把这一件的验收问给人——那张卡是服务在 done 之后落的。
  await runFollowUps(s, done, HUMAN, at(4));
  return { s, put };
}
/** 人在牌桌点「过」：服务据此替他落那条验收（t-055 那一路）。 */
async function humanSaysPass(w: Awaited<ReturnType<typeof waiting>>) {
  const ask = [...reduce(await w.s.read(), at(10), HUMAN).instructions.values()].map((x) => x.instruction).find((i) => i.to === HUMAN && i.options?.length);
  expect(ask, "服务要先问人（t-055）").toBeTruthy();
  const decided = await w.put({ kind: "note", actor: HUMAN, body: `decision: ${ask!.options![0]}`, decision: true, decides: { of: ask!.id, option: ask!.options![0] } }, 11);
  return runFollowUps(w.s, decided, HUMAN, at(11));
}
const verifyOf = async (s: MemoryStore) => surfaceResults(reduce(await s.read(), at(20), HUMAN).tasks.get("t-1")!)[0];

describe("t-347 · 人点「过」那一路也说得出是哪条支", () => {
  it("**判据 1**：那件 done 带了支名 ⇒ 服务抄它，落下来的那条验收带着同一个支名（人不必多点一下）", async () => {
    const w = await waiting(DELIVERY);
    const landed = await humanSaysPass(w);
    expect(landed.some((e) => (e as { op?: string }).op === "verify"), "那条验收落下去了").toBe(true);
    const v = await verifyOf(w.s);
    expect(v).toMatchObject({ surface: "repo", pass: true, branch: DELIVERY });
    expect(verifiedSurface(v.surface, v.branch, { unknown: v.branch_unknown })).toBe(`repo@${DELIVERY}`);
  });

  it("**判据 3**：那个按钮不许失效——抄不到支名也照旧落下去，不拒他（他是政策权威）", async () => {
    const w = await waiting();
    const landed = await humanSaysPass(w);
    expect(landed.some((e) => (e as { op?: string }).op === "verify")).toBe(true);
    expect(reduce(await w.s.read(), at(20), HUMAN).tasks.get("t-1")!.status).toBe("verified");
  });

  it("**判据 2、4**：抄不到时落的是这一档自己那句话，不是存量那一档的「没记支名」", async () => {
    const w = await waiting();
    await humanSaysPass(w);
    const v = await verifyOf(w.s);
    expect(v.branch, "没有支名可抄").toBeUndefined();
    expect(v.branch_unknown, "而它带着这一档的记号").toBe(true);
    const line = verifiedSurface(v.surface, v.branch, { unknown: v.branch_unknown });
    expect(line, "pd 00:00 定稿，行内那一句").toBe(`repo（${VERIFY_BRANCH_BY_HUMAN}）`);
    expect(line, "**不许是存量那一档**").not.toContain(VERIFY_BRANCH_UNRECORDED);
    // 两档的下一步不同，这正是它们不共用一句话的理由
    expect(VERIFY_BRANCH_BY_HUMAN_WHY).toContain("拿它证据里的 sha 自己查");
    expect(VERIFY_BRANCH_BY_HUMAN_WHY).toContain("不说明它在不在你会拿到的那条支上");
  });

  it("**pd 的那个条件**：那一行若已经印了验收人，就只留后半（两处说同一件事就是重复）", () => {
    // 我量过的：逐条判决那一行印 `by <谁>` ⇒ 后半；聚合与 history 那几行不印 ⇒ 全句。
    expect(verifiedSurface("repo", undefined, { unknown: true, showsWho: true })).toBe(`repo（${VERIFY_BRANCH_BY_HUMAN_SHORT}）`);
    expect(verifiedSurface("repo", undefined, { unknown: true })).toBe(`repo（${VERIFY_BRANCH_BY_HUMAN}）`);
    expect(VERIFY_BRANCH_BY_HUMAN_SHORT, "后半里不许再出现「人点的」").not.toContain("人点的");
  });

  it("**判据 4：堵住那条绕路**——一个角色自己带那个记号来，照旧被拒", async () => {
    const w = await waiting(DELIVERY);
    const r = await w.put({ kind: "task", actor: "pm", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "我验过", branch_unknown: true } as NewEvent, 12)
      .then(() => null, (e: unknown) => e as Rejected);
    expect(r, "带着服务那个记号来 = 自己给自己免掉支名").toBeInstanceOf(Rejected);
    expect(r!.rule).toBe("verify");
  });

  it("**判据 5**：不回填历史，也没动 t-344 那部分判法（别的面带支名照旧当场拒）", async () => {
    const w = await waiting(DELIVERY);
    const r = await w.put({ kind: "task", actor: "pm", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上看过", branch: DELIVERY } as NewEvent, 12)
      .then(() => null, (e: unknown) => e as Rejected);
    expect(r).toBeInstanceOf(Rejected);
    // 存量那一档（既没有支名也没有记号）照旧是「没记支名」
    expect(verifiedSurface("repo", undefined, {})).toBe(`repo（${VERIFY_BRANCH_UNRECORDED}）`);
  });
});
