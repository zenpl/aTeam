/**
 * t-120: 线上 splits what is verified on this version from what came before it. The split is by the log's own order,
 * not by the clock — two appends can land in the same millisecond, and then a verification recorded *before* the
 * deploy was being counted as part of this version.
 *
 * This is the one that made a server test red once in a full run and stayed green in nine single runs: under load the
 * two requests shared a millisecond. Here that condition is the fixture, so it fails every time without the fix.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "../src/index.js";

const HUMAN = "human";

/** A log where the second deploy reading is recorded `gap` ms after the production pass. gap 0 = the same millisecond. */
async function log(gap: number) {
  const store = new MemoryStore();
  let t = Date.parse("2026-09-07T00:00:00.000Z");
  const emit = (e: NewEvent, ms: number) => append(store, e, { human: HUMAN, now: new Date(ms) });
  await emit({ kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" }, (t += 1000));
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "登录修复", criteria: ["可用"] }, (t += 1000));
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["src/1.ts"] }, (t += 1000));
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: "提交 1234567" , no_human_impact: true}, (t += 1000));
  const passed = (t += 1000);
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-1", surface: "production", pass: true, evidence: "线上看到" }, passed);
  await emit({ kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" }, passed + gap);
  return board(reduce(await store.read()), HUMAN);
}

describe("t-120 · 线上 splits by log order, not by the clock", () => {
  it("a pass recorded before the deploy is earlier, whether or not they share a millisecond", async () => {
    for (const gap of [1000, 1, 0]) {
      const b = await log(gap);
      expect(b.live.deployed_sha, `gap ${gap}`).toBe("bbbbbbb2222");
      expect(b.live.recent.map((x) => x.id), `gap ${gap}`).toEqual([]);
      expect(b.live.earlier.map((x) => x.id), `gap ${gap}`).toEqual(["t-1"]);
      expect(b.tasks.verified?.[0]?.era, `gap ${gap}`).toBe("earlier");
    }
  });

  it("a pass recorded after the deploy belongs to this version, in the same millisecond too", async () => {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-07T00:00:00.000Z");
    const emit = (e: NewEvent, ms: number) => append(store, e, { human: HUMAN, now: new Date(ms) });
    await emit({ kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" }, (t += 1000));
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "登录修复", criteria: ["可用"] }, (t += 1000));
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["src/1.ts"] }, (t += 1000));
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: "提交 1234567" , no_human_impact: true}, (t += 1000));
    const together = (t += 1000);
    await emit({ kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" }, together);
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-1", surface: "production", pass: true, evidence: "线上看到" }, together);
    const b = board(reduce(await store.read()), HUMAN);
    expect(b.live.recent.map((x) => x.id)).toEqual(["t-1"]);
    expect(b.live.earlier).toEqual([]);
  });
});
