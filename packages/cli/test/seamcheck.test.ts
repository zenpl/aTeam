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
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-a", title: "earlier", criteria: ["x"] });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-b", title: "later", criteria: ["y"] });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-a", touches: ["app.ts"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-b", touches: ["app.ts"] });
  if (otherDone) await emit({ kind: "task", op: "done", actor: "frontend", task: "t-a", evidence: otherEvidence });
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
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成" });
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
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["app.ts"] }); // both in flight: a collision
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成" });
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
    for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["app.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa1111111 完成" });
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
    expect(seamCheck(b, "t-b", "bbbbbbb2 做完了", yes)).toEqual({ errors: [], unverified: [], absorbs: [] }); // git says yes: no need to name it
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
    expect(seamCheck(b, "t-b", "bbbbbbb2 合并了 aaaaaaa1", no)).toEqual({ errors: [], unverified: [], absorbs: [] });
    expect(seamCheck(b, "t-b", "bbbbbbb2 做完了", yes).errors).toEqual([expect.stringContaining("证据声称含 aaaaaaa")]);
  });
});
