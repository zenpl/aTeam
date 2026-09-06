/**
 * t-037: before `task done`, check in local git that a resolved seam's "later merges earlier" really happened.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
import { seamWarnings, gitIsAncestor } from "../src/seamcheck.js";

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
