/**
 * t-344（pd 要求㉜，decision `01M69TGRYYAYV2KE38K6H8PJ8P`；两句措辞是 pd 22:19 的定稿
 * `01M6A0RERQ89NCVSWQK4NBGCK1`，照抄）：**`repo` 不是一个面，它至少是两个——「✓ repo」要说出是哪条支。**
 *
 * 真样本：t-240／t-245／t-274 都是 `verified`、板上都显示 `✓ repo`，而那五笔只在三条交付支上，
 * 能发车的那条支里一笔都没有——pd 18:51 因此被一件「已验」的毛病咬了一次。**一个会到人手上，一个不会，
 * 而两者在板上长得一模一样。**
 *
 * 落点是我定的（pd 明说「怎么分归实现与 pm」）：`verify` 多一个 `--branch`，支名**原样印出来**——
 * 于是两档天然不同行，不需要造「在交付支上验的／在整合支上验的」两句话。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, Rejected, verifiedSurface, VERIFY_BRANCH_REQUIRED, VERIFY_BRANCH_UNRECORDED, VERIFY_BRANCH_UNRECORDED_WHY, surfaceResults, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);
const DELIVERY = "claude/backend-development-gzqbjf";
const INTEGRATION = "claude/new-project-details-gif66k";

/** 一件做完了、等验的任务。 */
async function ready() {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, 0);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "一件", criteria: ["能用"], no_human_impact: true }, 1);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["a.ts"] }, 2);
  await put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234：做完了", no_human_impact: true }, 3);
  return { s, put };
}
const refusal = async (p: Promise<unknown>) => await p.then(() => null, (e: unknown) => e as Rejected);
const task = async (s: MemoryStore) => reduce(await s.read(), at(100), HUMAN).tasks.get("t-1")!;

describe("t-344 · repo 面的验收要说出是哪条支", () => {
  it("**判据 3**：不带 --branch 的 repo 验收被拒，拒绝句是 pd 定稿、两条出路在里面", async () => {
    const w = await ready();
    const r = await refusal(w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "跑过" }, 4));
    expect(r).toBeInstanceOf(Rejected);
    expect(r!.rule).toBe("verify");
    expect(r!.message, "照抄 pd 22:19 定稿").toContain(VERIFY_BRANCH_REQUIRED);
    expect(r!.message).toContain("两条出路");
    expect((await task(w.s)).status, "那条验收没有落库").toBe("done");
  });

  it("带了支名 ⇒ 过，而且板上那一行说得出是哪条支", async () => {
    const w = await ready();
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "跑过", branch: DELIVERY }, 4);
    const t = await task(w.s);
    expect(t.status).toBe("verified");
    expect(surfaceResults(t)).toEqual([{ surface: "repo", pass: true, branch: DELIVERY }]);
    expect(verifiedSurface("repo", DELIVERY)).toBe(`repo@${DELIVERY}`);
  });

  it("**判据 4**：在交付支上验的与在整合支上验的，板上不是同一行", () => {
    const a = verifiedSurface("repo", DELIVERY);
    const b = verifiedSurface("repo", INTEGRATION);
    expect(a).not.toBe(b);
    expect(a).toContain(DELIVERY);
    expect(b).toContain(INTEGRATION);
    // 读的人要能回答 pd 要的那个问题：这件事会不会到我手上——支名自己答得出，不需要我们替他判
    expect(b, "整合支那一行里就是整合支的名字，不是一句转述").toBe(`repo@${INTEGRATION}`);
  });

  it("**判据 2、6**：旧事件（没有这个字段）照旧印得出来，而且说「没记支名」——不猜、不默认当成整合支", () => {
    const line = verifiedSurface("repo", undefined);
    expect(line).toBe(`repo（${VERIFY_BRANCH_UNRECORDED}）`);
    expect(VERIFY_BRANCH_UNRECORDED, "pd：用「没记」不用「不知道」——事实是当时没记，不是此刻查不出").toBe("没记支名");
    expect(line, "不许出现任何一条支的名字：那会是凭空猜").not.toContain("claude/");
    // 展开那一段里最要紧的那半句（pd 点名的）
    expect(VERIFY_BRANCH_UNRECORDED_WHY).toContain("不说明它在不在你会拿到的那条支上");
  });

  it("别的面不收这个字段：staging／production 是一个面就是一个面", async () => {
    const w = await ready();
    const r = await refusal(w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上看过", branch: DELIVERY }, 4));
    expect(r).toBeInstanceOf(Rejected);
    expect(verifiedSurface("production", undefined), "它们原样不动，不带后缀").toBe("production");
  });

  it("**fail 也要说支**：一条 repo 上的 fail 不说支，同样答不出「这件事会不会到我手上」", async () => {
    const w = await ready();
    expect(await refusal(w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: false, evidence: "没过" }, 4))).toBeInstanceOf(Rejected);
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: false, evidence: "没过", branch: DELIVERY }, 5);
    expect((await task(w.s)).status).toBe("failed");
  });

  it("**一处例外，当缺口记在这里**：人自己点「过」那一路放过（服务替他落，而服务不知道是哪条支）", async () => {
    const w = await ready();
    await w.put({ kind: "task", actor: HUMAN, op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "human 在牌桌上确认" }, 4);
    const t = await task(w.s);
    expect(t.status, "人拍板那一路不许被这道闸挡住（t-055）").toBe("verified");
    // 而它落下来的那一条在板上就是「没记支名」——那正是 pd 为这一档定的后缀，说的是真的
    expect(verifiedSurface("repo", surfaceResults(t)[0].branch)).toBe(`repo（${VERIFY_BRANCH_UNRECORDED}）`);
  });
});
