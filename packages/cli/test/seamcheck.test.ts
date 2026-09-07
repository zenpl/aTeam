import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * t-037: before `task done`, check in local git that a resolved seam's "later merges earlier" really happened.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, append, reduce, board, NO_OUTPUT_PREFIX, type NewEvent } from "@ateam/core";
import { seamWarnings, seamErrors, absorbEvents, seamCheck, judgeAbsorb, gitIsAncestor, gitHasObject, unjudgeableSeams, gitCommitsSince, outputSinceClaim, realOverlap, seamTruthEvents, type CommitsSince, type ChangedSince, type HasObject } from "../src/seamcheck.js";

const HUMAN = "human";
let repo = "";
let shaA = "", shaB = "", shaC = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ateam-seam-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a"), "a"); git("add", "a"); git("commit", "-q", "-m", "A"); shaA = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "b"), "b"); git("add", "b"); git("commit", "-q", "-m", "B"); shaB = git("rev-parse", "HEAD");
  git("checkout", "-q", "--orphan", "other"); git("rm", "-q", "-rf", "."); writeFileSync(join(repo, "c"), "c"); git("add", "c"); git("commit", "-q", "-m", "C"); shaC = git("rev-parse", "HEAD");
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

async function scenario(otherEvidence: string | undefined, otherDone = true, resolve = true) {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-a", title: "earlier", criteria: ["x"] , no_human_impact: true});
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-b", title: "later", criteria: ["y"] , no_human_impact: true});
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-a", touches: ["app.ts"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-b", touches: ["app.ts"] });
  if (otherDone) await emit({ kind: "task", op: "done", actor: "frontend", task: "t-a", evidence: otherEvidence , no_human_impact: true});
  if (resolve) await emit({ kind: "task", op: "seam", actor: "pm", tasks: ["t-a", "t-b"], resolution: "t-b 后落地，合并 t-a" });
  return board(reduce(await store.read()), HUMAN);
}

describe("t-037 · gitIsAncestor", () => {
  it("answers from the repository, and null where git cannot know", () => {
    const is = gitIsAncestor(repo);
    expect(is(shaA, shaB)).toBe(true);
    expect(is(shaA.slice(0, 7), shaB.slice(0, 7))).toBe(true);
    expect(is(shaC, shaB)).toBe(false);
    expect(is("0000000", shaB)).toBeNull();
    expect(gitIsAncestor(tmpdir())(shaA, shaB)).toBeNull();
  });
});

describe("t-037 · seamWarnings before task done", () => {
  it("no warning when the other side's sha is an ancestor of mine", async () => {
    expect(seamWarnings(await scenario(`${shaA} 完成`), "t-b", `${shaB} 在 A 之上`, gitIsAncestor(repo))).toEqual([]);
  });

  it("warns, naming the seam and both shas, when it is not", async () => {
    const w = seamWarnings(await scenario(`${shaC} 完成`), "t-b", `${shaB} 没合并 C`, gitIsAncestor(repo));
    expect(w).toEqual([`seam:t-a+t-b 的解决方案要求你先合并 ${shaC}（t-a 的证据），当前证据 ${shaB} 不含它`]);
  });

  it("stays silent without git, with unknown objects, without shas, when the other side is not done, or when nothing was resolved", async () => {
    expect(seamWarnings(await scenario(`${shaC} 完成`), "t-b", `${shaB}`, gitIsAncestor(tmpdir()))).toEqual([]);
    expect(seamWarnings(await scenario("deadbeef1 完成"), "t-b", `${shaB}`, gitIsAncestor(repo))).toEqual([]);
    expect(seamWarnings(await scenario("见 PR，无 sha"), "t-b", `${shaB}`, gitIsAncestor(repo))).toEqual([]);
    expect(seamWarnings(await scenario(`${shaC}`), "t-b", "无 sha 的证据", gitIsAncestor(repo))).toEqual([]);
    expect(seamWarnings(await scenario(`${shaC}`, false), "t-b", `${shaB}`, gitIsAncestor(repo))).toEqual([]);
    expect(seamWarnings(await scenario(`${shaC}`, true, false), "t-b", `${shaB}`, gitIsAncestor(repo))).toEqual([]);
    // the injected judge is what decides: a fake one that always says no
    expect(seamWarnings(await scenario(`${shaA}`), "t-b", `${shaB}`, () => false)).toHaveLength(1);
  });
});

describe("t-067 · a seam the rule released: the later side must name the merged sha in its evidence", () => {
  const world = async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成" , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["app.ts"] });
    return board(reduce(await store.read()), "human");
  };
  it("refuses an evidence that does not name the earlier side's sha; accepts the short or long form; the earlier side is never asked", async () => {
    const b = await world();
    expect(b.seams[0].stacked).toEqual({ done: "t-a", on: "t-b" });
    const e = seamErrors(b, "t-b", "bbbbbbb2 做完了");
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("写明合并了 aaaaaaa");
    expect(seamErrors(b, "t-b", "bbbbbbb2：合并了 aaaaaaa1111111")).toEqual([]);
    expect(seamErrors(b, "t-b", "bbbbbbb2 在 aaaaaaa1 之上")).toEqual([]);
    expect(seamErrors(b, "t-b", undefined)).toHaveLength(1);
    expect(seamErrors(b, "t-a", "aaaaaaa1111111")).toEqual([]);
    // qa 21:45 / t-074: with no absorb.form declared the sentence is all there is, and the fallback is said out loud (git's own verdicts are tested under t-074)
    const warnings: string[] = [];
    expect(seamErrors(b, "t-b", "bbbbbbb2：合并了 aaaaaaa1111111", () => false, (w) => warnings.push(w))).toEqual([]);
    expect(warnings).toEqual([expect.stringContaining("项目没有声明 absorb.form")]);
  });
});

describe("t-073 · absorbEvents at done: git-ancestor form", () => {
  const world = async (form?: string) => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
    if (form) await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: form });
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["app.ts"] }); // both in flight: a collision
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成" , no_human_impact: true});
    return board(reduce(await store.read()), "human");
  };
  it("records one resolution with the basis when git says my sha contains theirs; nothing when git cannot tell, the form is unset, or the other side is not done", async () => {
    const yes = () => true, no = () => false, unknown = () => null;
    let b = await world("git-ancestor");
    expect(b.seams[0].open).toBe(true);
    expect(absorbEvents(b, "t-b", "bbbbbbb2222222 在 A 之上", yes)).toEqual([{ kind: "task", op: "seam", tasks: ["t-b", "t-a"], resolution: "absorbed: 后者 bbbbbbb 含前者 aaaaaaa（git-ancestor）" }]);
    expect(absorbEvents(b, "t-b", "bbbbbbb2222222", no)).toEqual([]);
    expect(absorbEvents(b, "t-b", "bbbbbbb2222222", unknown)).toEqual([]);
    expect(absorbEvents(b, "t-b", "没有 sha 的证据", yes)).toEqual([]);
    b = await world();
    expect(absorbEvents(b, "t-b", "bbbbbbb2222222", yes)).toEqual([]); // no form declared
    b = await world("named-sha");
    expect(absorbEvents(b, "t-b", "bbbbbbb2222222", yes)).toEqual([]); // that form is judged from the log, not by git
  });
});

describe("t-074 · one judgment for both checks: really contained, claimed but not, undecidable", () => {
  const world = async (form?: string) => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
    if (form) await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: form });
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成" , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["app.ts"] }); // stacked: t-b on t-a
    return board(reduce(await store.read()), "human");
  };
  const yes = () => true, no = () => false, unknown = () => null;
  it("git-ancestor: git decides; a sentence naming the sha is not enough", async () => {
    const b = await world("git-ancestor");
    expect(judgeAbsorb(b, "bbbbbbb2 合并了 aaaaaaa1", "aaaaaaa1111111", yes)).toEqual({ verdict: "yes", basis: "后者 bbbbbbb 含前者 aaaaaaa（git-ancestor）" });
    expect(judgeAbsorb(b, "bbbbbbb2 合并了 aaaaaaa1", "aaaaaaa1111111", no).verdict).toBe("no");
    expect(judgeAbsorb(b, "bbbbbbb2", "aaaaaaa1111111", unknown).verdict).toBe("unknown");
    const refused = seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", no);
    expect(refused.errors).toEqual([expect.stringContaining("证据声称含 aaaaaaa（t-a 的证据 sha），但 bbbbbbb 并不包含它")]);
    // t-160 判据 5：git 说「真的含」的时候，结论要落回日志——以前这一支什么都不做，于是 git-ancestor 形态下
    // 自动吸收永远不发生，接缝一直开着，最后由人一条条手工裁。现在它写一条 resolution，依据写明是 git-ancestor。
    const absorbed = seamCheck(b, "t-b", "bbbbbbb2 做完了", yes);
    expect(absorbed).toMatchObject({ errors: [], unverified: [] });
    expect(absorbed.absorbs).toEqual([{ kind: "task", op: "seam", tasks: ["t-b", "t-a"], resolution: expect.stringContaining("后者 bbbbbbb 含前者 aaaaaaa（git-ancestor）") }]);
    const fell = seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", unknown);
    expect(fell).toMatchObject({ errors: [], absorbs: [] });
    expect(fell.unverified).toEqual([expect.stringContaining("无法验证 t-b 是否真的含 aaaaaaa（本地 git 没有")]);
    expect(seamCheck(b, "t-b", "bbbbbbb2 做完了", unknown).errors).toHaveLength(1); // undecidable and not even named: today's rule
  });
  it("no form declared: undecidable, today's rule, and the fallback is on record; named-sha: the text decides", async () => {
    let b = await world();
    const r = seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", yes);
    expect(r.errors).toEqual([]);
    expect(r.unverified).toEqual([expect.stringContaining("项目没有声明 absorb.form")]);
    b = await world("named-sha");
    // named-sha 那一头同理：判「含」就把结论写下来，不再只是默默不拦
    expect(seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", no)).toMatchObject({
      errors: [], unverified: [], absorbs: [{ resolution: expect.stringContaining("后者证据写明含前者 aaaaaaa（named-sha）") }],
    });
    expect(seamCheck(b, "t-b", "bbbbbbb2 做完了", yes).errors).toEqual([expect.stringContaining("证据声称含 aaaaaaa")]);
  });
});

/**
 * t-160 判据 7：一正一反，两条都跑在 git-ancestor 这个形态上（本项目声明的就是它）。
 *
 * 正：git 说真的含 → 自动吸收，结论落回日志，没有人需要裁。这条以前不存在——`reduce.ts` 里那条自动吸收只在
 *     `named-sha` 时执行，而本项目是 `git-ancestor`，**那条分支从来没生效过**（qa 10:16 量的）。
 * 反：证据里写了那个 sha，git 却说不含 → 必须仍然挡住。那正是 t-074 当初发现的假放行：
 *     一句「我合并了 aaaaaaa」谁都写得出，写下来不等于合过。
 */
describe("t-160 判据 7 · 自动吸收只认 git 说的，不认证据里写了什么", () => {
  const world = async (form?: string) => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
    if (form) await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: form });
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"], no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成", no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["app.ts"] }); // stacked: t-b on t-a
    return board(reduce(await store.read()), "human");
  };
  const yes = () => true, no = () => false, unknown = () => null;
  it("正：git 说含——自动落一条 resolution，依据写明是 git-ancestor 与两个 sha", async () => {
    const b = await world("git-ancestor");
    const r = seamCheck(b, "t-b", "bbbbbbb2 做完了", yes);   // 证据里一个字都没提 aaaaaaa
    expect(r.errors).toEqual([]);
    expect(r.absorbs).toHaveLength(1);
    expect((r.absorbs[0] as { resolution: string }).resolution).toContain("git-ancestor");
    expect((r.absorbs[0] as { resolution: string }).resolution).toContain("aaaaaaa");
  });

  it("反：证据写了那个 sha，git 说不含——挡住，而且说得出是 git 说的", async () => {
    const b = await world("git-ancestor");
    const r = seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", no);
    expect(r.absorbs).toEqual([]);                        // 一个字都没吸收
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("并不包含它");
    expect(r.errors[0]).toContain("merge-base --is-ancestor 为否");
  });

  it("判据 6：判在有仓库的这一头做——没有 git 就说不知道，不退回文本匹配", async () => {
    const b = await world("git-ancestor");
    const r = seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", unknown);
    expect(r.absorbs).toEqual([]);                        // 不知道就不吸收：文本写了也不算
    expect(r.unverified).toEqual([expect.stringContaining("无法验证")]);
  });
});

/**
 * t-191：**对方 claim 了却还没写代码时，那条接缝无从判定重叠——不该挡住前者的验收。**
 *
 * 今夜四次同形状（t-143+t-180、t-180+t-179、t-144+t-185、t-160+t-189），每次都是 qa 一次自查、pm 一次裁定、
 * 两条 tell。判据 2 的界线：t-160 按**时序**（在它 done 之后才 claim 的不挡），这一条按**有没有产出**
 * （claim 了但没写代码的不挡）。两条各自独立，不互相取代——一件在前者 done 之前就 claim、而且真的在写代码的，
 * 两条都不放行，那正是该挡的那一种。
 */
describe("t-191 · 对方还没写代码时，接缝无从判定", () => {
  const world = async (otherStatus: "working" | "done") => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"], no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["packages/core/src/board.ts"] });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["packages/core/src/board.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa 完成", no_human_impact: true });
    if (otherStatus === "done") await emit({ kind: "task", op: "done", actor: "frontend", task: "t-b", evidence: "bbbbbbb 完成", no_human_impact: true });
    return board(reduce(await store.read()), "human");
  };
  const none: CommitsSince = () => false, some: CommitsSince = () => true, blind: CommitsSince = () => null;

  it("判据 1 正例：对方自 claim 以来没有提交——写一条结论把接缝解掉，前者的验收放行", async () => {
    const b = await world("working");
    expect(b.seams[0].open, "先确认它此刻确实挡着").toBe(true);
    const r = unjudgeableSeams(b, "t-a", none);
    expect(r.notes).toEqual([]);
    expect(r.events).toHaveLength(1);
    const ev = r.events[0] as { resolution: string; tasks: string[] };
    expect(ev.resolution).toContain(NO_OUTPUT_PREFIX);
    expect(ev.resolution).toContain("t-b");
    expect(ev.resolution, "合并义务照旧留给后落地方").toContain("合并义务照旧");
    expect(ev.tasks).toEqual(expect.arrayContaining(["t-a", "t-b"]));
  });

  it("判据 3 反例：对方一有提交，立刻回到正常判定——没有「曾经无提交」这种永久豁免", async () => {
    const b = await world("working");
    expect(unjudgeableSeams(b, "t-a", some).events, "它写代码了，这条接缝就是真的").toEqual([]);
    // 同一块板、同一条接缝，只是 git 的回答变了：判定跟着变，因为每次都现问，不记状态
    expect(unjudgeableSeams(b, "t-a", none).events).toHaveLength(1);
    expect(unjudgeableSeams(b, "t-a", some).events).toEqual([]);
  });

  it("对方已经交过活的不走这一条：那时有产出可判，回到正常的接缝判定（含 t-160 那条时序）", async () => {
    const b = await world("done");
    expect(unjudgeableSeams(b, "t-a", none).events, "对方 done 了还说它没产出，那是拿一个假前提放行").toEqual([]);
  });

  it("看不见就当有：判不了的时候不放行，但把原因说出来", async () => {
    const b = await world("working");
    const r = unjudgeableSeams(b, "t-a", blind);
    expect(r.events, "猜错的方向是放行一次真碰车").toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toContain("判不了");
    expect(r.notes[0]).toContain("照旧挡着");
  });

  it("只声明了符号、没声明路径时也问不了 git——同样按「看不见就当有」处理", () => {
    expect(outputSinceClaim("2026-09-07T00:00:00Z", ["inFlightGroups"], none, "aaaaaaa")).toBe("unknown");
    expect(outputSinceClaim("2026-09-07T00:00:00Z", [], none, "aaaaaaa")).toBe("unknown");
    expect(outputSinceClaim(undefined, ["a/b.ts"], none, "aaaaaaa"), "没有认领时刻就没有「自那以后」").toBe("unknown");
    expect(outputSinceClaim("2026-09-07T00:00:00Z", ["a/b.ts#sym"], none, "aaaaaaa"), "「文件#符号」取得出文件名").toBe("none");
  });

  it("被验那一侧的证据里没有 sha：判不了，接缝照旧挡着", () => {
    // 排掉的那一侧必须来自日志（被验任务的证据 sha）。日志里没有它，就没有「哪一侧是我」这个答案——
    // 这时候拿谁的 checkout 去补都是猜，而猜错的方向是放行一次真碰车。
    expect(outputSinceClaim("2026-09-07T00:00:00Z", ["a/b.ts"], none), "没有 sha 却答得出「对方没写代码」").toBe("unknown");
  });
});

/**
 * t-182：**闸拦对了，但报出来的文件不是两侧真正都改过的那些。**
 *
 * 今晚的实例：t-139+t-140 报 `packages/cli/src/deaf.ts`——两侧都没碰它，它是祖先里改的；而真正撞的
 * `server/test/release-page.test.ts` 一个字没说。被拦下来的人照那份名单去查，查的是一个两边都没碰过的文件。
 *
 * 根在于接缝的 overlap 是两份**触点清单**的交集，清单里没有「自共同祖先以来」这回事。我拿那两条真证据 sha
 * 核过：`git merge-base c838dec 9867803` 就是 `c838dec` 自己——两边根本没有分叉，真交集是空的。
 */
describe("t-182 · 报的是三方比较的交集，不是两份清单的交集", () => {
  // 判据 3 一正一反，都在构造的 changed 上跑，不依赖本仓库的历史
  const changed = (map: Record<string, string[]>): ChangedSince => (from, to) => map[`${from}->${to}`] ?? null;

  it("判据 3 正例：真撞的逐个文件报准", () => {
    const c = changed({ "b->a": ["x.ts", "y.ts"], "a->b": ["y.ts", "z.ts"] });
    expect(realOverlap("a", "b", c)).toEqual(["y.ts"]);
  });

  it("判据 3 反例：祖先里改的、两侧都没碰的，不出现在名单里", () => {
    // deaf.ts 在两边的 merge-base..to 里都不出现——它是祖先里改的
    const c = changed({ "b->a": ["board.ts"], "a->b": ["html.ts"] });
    expect(realOverlap("a", "b", c), "两边改的东西不相交，就没有真撞").toEqual([]);
  });

  it("判据 1、2：一侧是另一侧的祖先时真交集为空——今晚那三条的形状", () => {
    const c = changed({ "b->a": [], "a->b": ["board.ts", "deaf.ts"] });   // a 是 b 的祖先：a 那一边没有独有改动
    expect(realOverlap("a", "b", c)).toEqual([]);
  });

  it("判不了就答 null，接缝照旧挡着——不拿猜的当判定", () => {
    expect(realOverlap("a", "b", changed({ "b->a": ["x.ts"] })), "只答得出一半也是判不了").toBeNull();
    expect(realOverlap("a", "b", changed({}))).toBeNull();
  });

  it("落回日志：真交集为空的解掉；不空但名单报错的把对的说出来；判不了的什么都不写", () => {
    const empty = seamTruthEvents([{ seam: "seam:t-1+t-2", other: "t-2", reported: ["deaf.ts"], real: [] }], "t-1");
    expect(empty.events).toHaveLength(1);
    expect((empty.events[0] as { resolution: string }).resolution).toContain("没有一个文件是两边都改过的");
    expect((empty.events[0] as { resolution: string }).resolution, "把先前报错的那个也说出来，读的人才知道换了什么").toContain("deaf.ts");

    const wrong = seamTruthEvents([{ seam: "s", other: "t-2", reported: ["deaf.ts"], real: ["release-page.test.ts"] }], "t-1");
    expect(wrong.events).toEqual([]);                       // 真撞：接缝该挡就挡
    expect(wrong.notes[0]).toContain("release-page.test.ts");
    expect(wrong.notes[0], "也说出先前报的是什么，否则人不知道该改看哪儿").toContain("deaf.ts");

    expect(seamTruthEvents([{ seam: "s", other: "t-2", reported: ["x"], real: null }], "t-1")).toEqual({ events: [], notes: [] });
  });

  it("名单本来就报得准时，不多说一句", () => {
    const same = seamTruthEvents([{ seam: "s", other: "t-2", reported: ["a.ts", "b.ts"], real: ["a.ts", "b.ts"] }], "t-1");
    expect(same).toEqual({ events: [], notes: [] });
  });
});

/**
 * t-191 判据 1，第二、三轮：**问的必须是「对方有没有提交」，而「我是哪一侧」不能来自谁的 checkout。**
 *
 * 第二轮（qa 12:01 判 fail）：上一版是 `git log --all -- <paths>`——没有作者、没有分支、没有排除我自己，
 * 于是它答的是「自那一刻起任何人有没有碰过那些路径」。而一条接缝之所以存在，恰恰是因为两边声明了**同一批
 * 路径**——所以「我自己在那些路径上的提交」不是边角情形，**它就是这个场景的常态**：我一提交它就答「对方写
 * 代码了」，这条判定几乎永远放行不了。分得出来的不是作者（这个仓库里每个 agent 都以同一个 git author 提交），
 * 是**可达性**。
 *
 * 第三轮（qa 12:27 判 fail，也是在真仓库上跑出来的）：可达性对，可排掉的那一侧写成了 `HEAD`。这段判定跑在
 * `task verify --pass` 里，而**落 pass 的只有 qa**——qa 的 HEAD 是 qa 自己的分支，不是被验那件任务的分支。
 * 于是 `--not HEAD` 排掉的是 qa 那条线，被验任务的提交照样不可达、照样被算成「对方写了代码」。
 * 排的必须是**被验那一侧记在日志里的证据 sha**：它不来自谁的 checkout，谁跑都一样。
 *
 * 这几条在一个真 git 仓库上跑，而且**站在 qa 的 checkout 上跑**——要证的正是「HEAD 是谁的」这件事。
 */
describe("t-191 · 排掉的是被验任务的证据 sha，不是谁的 HEAD", () => {
  const repo = mkdtempSync(join(tmpdir(), "t191-"));
  const run = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  const EPOCH = "1970-01-01T00:00:00Z";
  let mine = "";
  beforeAll(() => {
    run("init", "-q", ".");
    run("config", "user.email", "t@t"); run("config", "user.name", "t");
    writeFileSync(join(repo, "shared.ts"), "base\n");
    run("add", "."); run("commit", "-qm", "base");
    run("checkout", "-qb", "theirs");
    writeFileSync(join(repo, "shared.ts"), "theirs\n");
    run("commit", "-qam", "theirs");                       // 对方分支上的提交
    run("checkout", "-q", "master");
    run("checkout", "-qb", "dev-branch");
    writeFileSync(join(repo, "shared.ts"), "mine\n");
    run("commit", "-qam", "mine");                         // 被验那件任务自己的提交，在同一批路径上
    mine = run("rev-parse", "HEAD").stdout.trim();
    // **判定跑在 qa 的 checkout 上**：HEAD 既不是 dev 那条分支，也不是对方那条。
    run("checkout", "-q", "master");
    run("checkout", "-qb", "qa-branch");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("被验任务自己的提交不算「对方写代码了」——哪怕跑这条命令的是 qa", () => {
    // 先确认对方那条分支上确实有提交，该答 true
    expect(gitCommitsSince(repo)(EPOCH, ["shared.ts"], mine), "对方分支上确实有提交").toBe(true);
    // 把对方那条分支删掉：shared.ts 上只剩**被验那件任务自己**的那条提交
    run("branch", "-qD", "theirs");
    // qa 12:27 判 fail 的那一条：排 HEAD 排掉的是 qa 自己那条线，dev 的提交照样被算成对方的
    expect(gitCommitsSince(repo)(EPOCH, ["shared.ts"], "HEAD"), "这正是上一版：qa 的 HEAD 上没有 dev 的提交，于是它被算成了对方的").toBe(true);
    // 排被验任务的证据 sha：不来自谁的 checkout，谁跑都一样，答 false
    expect(gitCommitsSince(repo)(EPOCH, ["shared.ts"], mine), "只剩被验任务自己的提交，却答成「对方写代码了」").toBe(false);
  });

  it("路径不在任何提交里：答 false（对方确实没碰过它）", () => {
    expect(gitCommitsSince(repo)(EPOCH, ["nobody-touched.ts"], mine)).toBe(false);
  });

  it("没有可排的那一侧（证据里没有 sha）：答 null，接缝照旧挡着", () => {
    expect(gitCommitsSince(repo)(EPOCH, ["shared.ts"], "")).toBeNull();
  });

  it("不是 git 仓库：答 null，接缝照旧挡着", () => {
    expect(gitCommitsSince(mkdtempSync(join(tmpdir(), "notgit-")))(EPOCH, ["x.ts"], "HEAD")).toBeNull();
  });
});

/**
 * t-201：**闸拿到一个 git 里不存在的证据 sha 时，唯一的出路是关掉整道闸。**
 *
 * 真样本是我自己 12:41 那次（判据 3）：t-191 第三轮要交，接缝 t-183+t-191 要求证据写明合并了 t-183 的证据
 * sha `72e8f6e`——而那个 sha **从来没有存在过**，它是 t-183 的 owner 写下的一个占位，12:18 已经用 note 更正过
 * （真 sha 是 `59b795b`），可牌桌上那一栏仍留着占位。闸于是拿它去要一个合不了的东西，而它给的唯一出路是
 * `--no-seam-check`——一把把**所有**接缝义务一起免掉的钥匙。合并义务其实早已履行。
 *
 * 两件事分开（判据 1、2）：
 * ① 「我在本地 git 里找不到这个对象」——**这不是说你没合并，是说我看不见**；
 * ② 「git 说你的 sha 不含它」——义务没履行，那句话不该长得像①。
 * 出路也分开（判据 4，今晚第三次「唯一出路是全关」）：`--no-seam-check-for <接缝 id>` 只免这一条，
 * 其余接缝照判，而且被免掉的那一条随 done 落在日志上——免掉不等于没发生。
 */
describe("t-201 · 找不到那个对象，与「你没合上」，是两句不同的话", () => {
  const world = async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "git-ancestor" });
    for (const id of ["t-a", "t-b", "t-c"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"], no_human_impact: true });
    // 两条接缝都是「我在它们 done 之后才 claim」——那正是要我合并的那一种（t-160 的 stacked）
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "72e8f6e1111111 完成", no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "qa", task: "t-c", touches: ["board.ts"] });
    await emit({ kind: "task", op: "done", actor: "qa", task: "t-c", evidence: "ccccccc2222222 完成", no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["app.ts", "board.ts"] });
    return board(reduce(await store.read()), "human");
  };
  // 本地 git 里有 ccccccc、没有 72e8f6e：正是那次的形状——一个占位，一个真 sha
  const has: HasObject = (sha) => sha !== "72e8f6e1111111";
  const isAncestor = () => null;   // 有对象缺着，git 答不了

  it("判据 1、2：找不到对象那一条自己一句话，且不叫人去关整道闸", async () => {
    const b = await world();
    const r = seamCheck(b, "t-b", "bbbbbbb3333333 完成", isAncestor, has);
    const line = r.errors.find((x) => x.includes("t-a"))!;
    expect(line, "要说得出是「我找不到」").toContain("这个对象我在本地 git 里找不到");
    expect(line, "要说清它不是「你没合上」").toContain("这不是说你没合并，是说我看不见");
    expect(line, "窄出路要指名道姓").toContain("--no-seam-check-for");
    expect(/--no-seam-check(?!-for)/.test(line), "不许再把人推向那把关掉全部的钥匙").toBe(false);
  });

  it("判据 2：「你没合上」那句与它长得不一样——一句谈义务，一句谈视线", async () => {
    const b = await world();
    const notContained = seamCheck(b, "t-b", "bbbbbbb3333333 完成", () => false, () => true);
    const line = notContained.errors.find((x) => x.includes("t-a"))!;
    expect(line).toContain("并不包含它");
    expect(line, "义务那句不许说成「我看不见」").not.toContain("我在本地 git 里找不到");
  });

  it("判据 3：只免掉那一条，其余接缝照判", async () => {
    const b = await world();
    // 免掉 t-a 那条（用对方任务 id）：t-c 那条仍然要判，而它此刻判不了，所以仍然拦着
    const r = seamCheck(b, "t-b", "bbbbbbb3333333 完成", isAncestor, has, ["t-a"]);
    expect(r.errors.some((x) => x.includes("找不到")), "被免掉的那条不再拦").toBe(false);
    expect(r.errors.some((x) => x.includes("t-c")), "另一条接缝照判，没有被一起免掉——这正是 --no-seam-check 做不到的").toBe(true);
    expect(r.unverified.some((x) => x.includes("单独免掉")), "免掉不等于没发生：它随 done 落在日志上").toBe(true);
  });

  it("免掉可以按接缝 id 说，也可以按对方任务 id 说", async () => {
    const b = await world();
    const seamId = b.seams.find((x) => x.tasks.includes("t-a") && x.tasks.includes("t-b"))!.id;
    for (const key of [seamId, "t-a"]) {
      const r = seamCheck(b, "t-b", "bbbbbbb3333333 完成", isAncestor, has, [key]);
      expect(r.errors.some((x) => x.includes("找不到")), `按 ${key} 免不掉`).toBe(false);
    }
  });

  it("没有 git 的时候不许说成「找不到那个对象」：那是我们看不见的另一种", async () => {
    const b = await world();
    const r = seamCheck(b, "t-b", "bbbbbbb3333333 完成", isAncestor, () => null);
    expect(r.errors.some((x) => x.includes("找不到")), "没有 git 与「这个对象不存在」不是同一件事").toBe(false);
  });

  it("gitHasObject 在真仓库上答得准，在非仓库里答 null 而不是 false", () => {
    const repo = mkdtempSync(join(tmpdir(), "t201-"));
    const run = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    run("init", "-q", ".");
    run("config", "user.email", "t@t"); run("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "x\n");
    run("add", "."); run("commit", "-qm", "base");
    const real = run("rev-parse", "HEAD").stdout.trim();
    expect(gitHasObject(repo)(real)).toBe(true);
    expect(gitHasObject(repo)("72e8f6e"), "那个占位在真仓库里也找不到").toBe(false);
    expect(gitHasObject(mkdtempSync(join(tmpdir(), "notgit-")))(real), "不是仓库：判不了，不是「没有」").toBeNull();
    rmSync(repo, { recursive: true, force: true });
  });
});
