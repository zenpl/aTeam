/**
 * t-037: before `task done`, check in local git that a resolved seam's "later merges earlier" really happened.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
import { seamWarnings, seamErrors, absorbEvents, seamCheck, judgeAbsorb, gitIsAncestor } from "../src/seamcheck.js";

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
