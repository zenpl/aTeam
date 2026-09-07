/**
 * t-133 (qa 05:31): the 上线 page said 「这次能带上 28 件」 while the board said 9 were waiting. The page was counting
 * candidates that had no production *verification*, but t-078 already draws the line that matters: pending_deploy is
 * code that is not in production, deployed_unverified is code that already runs there. Twenty-seven of that 28 were
 * running.
 *
 * So the invariant is: what the page says a release would bring must equal what the board says is waiting. One
 * number, two places, and they are not allowed to disagree.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, releaseUnits, type NewEvent } from "../src/index.js";

const HUMAN = "human";

async function world() {
  const store = new MemoryStore();
  let t = Date.parse("2026-09-07T05:00:00.000Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 1000)) });
  const finish = async (id: string, sha: string, verify: boolean) => {
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title: `任务 ${id}`, criteria: ["能用"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: id, touches: [`src/${id}.ts`] });
    await emit({ kind: "task", op: "done", actor: "dev", task: id, evidence: `${sha}：做完了`, no_human_impact: true });
    if (verify) await emit({ kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true, evidence: "跑过了" });
  };
  await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
  // two whose code is already in production, one whose code is not, one not verified at all
  await finish("t-1", "1111111", true);
  await finish("t-2", "2222222", true);
  await finish("t-3", "3333333", true);
  await finish("t-4", "4444444", false);
  await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks",
    value: { sha: "aaaaaaa1111", contained: ["t-1", "t-2"], not_contained: ["t-3", "t-4"], method: "逐件 git merge-base 测" } });
  return board(reduce(await store.read()), HUMAN);
}

describe("t-133 · 页面说能带上的，与牌桌说在等的，是同一个数", () => {
  it("counts only the code that is not in production yet, never what already runs there", async () => {
    const b = await world();
    const units = releaseUnits(b);
    const brings = units.reduce((n, u) => n + u.brings, 0);
    expect(b.release.counts.pending_deploy).toBe(1);        // t-3 only: t-1/t-2 are already deployed, t-4 is unverified
    expect(brings).toBe(b.release.counts.pending_deploy);
    // the ones already running are not offered as something a release would bring
    expect(units.find((u) => u.sha === "1111111")).toBeUndefined();
    expect(units.find((u) => u.sha === "2222222")).toBeUndefined();
    // the unverified one is listed, but as something holding its string rather than something it brings
    const four = units.find((u) => u.sha === "4444444")!;
    expect(four.brings).toBe(0);
    expect(four.held_by.map((h) => h.id)).toEqual(["t-4"]);
  });

  it("says it cannot tell rather than guessing, when the board cannot place the tasks", async () => {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-07T05:00:00.000Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 1000)) });
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "任务", criteria: ["能用"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["src/a.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: "1111111：做完了" , no_human_impact: true });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-1", surface: "repo", pass: true, evidence: "跑过了" });
    // no deployed.sha at all: the board cannot say what is waiting, so neither may this page
    const b = board(reduce(await store.read()), HUMAN);
    const slim = { ...b, release: { ...b.release, pending_deploy: undefined } };
    const units = releaseUnits(slim);
    expect(units.every((u) => u.brings_unknown)).toBe(true);
    expect(units.reduce((n, u) => n + u.brings, 0)).toBe(0);
  });
});
