/**
 * t-061: the service writes 分配预警 as the fact project:allocation, one entry per pattern, at most once per period
 * unless the patterns change. Times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, ALLOCATION_PERIOD_MS, SERVICE_ACTOR, type NewEvent } from "@ateam/core";
import { allocationFact, currentAllocationFact } from "../src/allocation.js";

const HUMAN = "human";
const min = (n: number) => n * 60_000;

describe("t-061 · project:allocation", () => {
  it("nothing to say and nothing said: no fact; a warning: one fact with numbers; same patterns within the period: no rewrite; a new pattern: a new fact", async () => {
    const store = new MemoryStore();
    let t = Date.now() - min(30);
    const now = () => new Date(t);
    const emit = (e: NewEvent) => { t += min(1); return append(store, e, { human: HUMAN, now: now() }); };
    const state = async () => reduce(await store.read(), now());
    expect(allocationFact(await state(), HUMAN, now())).toBeNull();
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: { 写手: ["R5"], 审稿: ["R3", "R6"] } });
    const f1 = allocationFact(await state(), HUMAN, now())!;
    expect(f1).toMatchObject({ kind: "reading", actor: SERVICE_ACTOR, surface: "project", key: "allocation", value: { count: 1, warnings: [{ pattern: "打破独立审核" }] } });
    expect(Date.parse((f1 as { valid_until: string }).valid_until) - now().getTime()).toBe(ALLOCATION_PERIOD_MS);
    await emit(f1);
    expect(currentAllocationFact(await state())!.warnings.map((w) => w.pattern)).toEqual(["打破独立审核"]);
    t += min(30);
    expect(allocationFact(await state(), HUMAN, now())).toBeNull(); // same pattern, within the period: the fact stands
    // a second pattern appears: a new fact now, with both
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: { 写手: ["R5", "R9"], 审稿: ["R3", "R6", "R9"] } });
    const f2 = allocationFact(await state(), HUMAN, now())!;
    expect((f2 as { value: { warnings: { pattern: string }[] } }).value.warnings.map((w) => w.pattern)).toEqual(["重叠", "打破独立审核"]);
    await emit(f2);
    // the period passes with nothing new: rewritten once with fresh numbers, then quiet again
    t += ALLOCATION_PERIOD_MS + min(1);
    const f3 = allocationFact(await state(), HUMAN, now())!;
    expect(f3).not.toBeNull();
    await emit(f3);
    expect(allocationFact(await state(), HUMAN, now())).toBeNull();
    // the warnings clear: one last fact saying none
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: { 写手: ["R5", "R9:自己的分支"], 审稿: ["R3", "R6:退化给 owner", "R9:集成"] } });
    const f4 = allocationFact(await state(), HUMAN, now())!;
    expect((f4 as { value: { count: number } }).value.count).toBe(0);
  });
});
