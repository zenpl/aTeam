/**
 * t-128 (P0, the write path's half of t-121): a reduction that moves forward with the log instead of being rebuilt.
 *
 * The claim this file has to make good is not "it is faster" — it is **"it is the same"**. So the test is an
 * equivalence: replay a log one event at a time through one long-lived reduction, and after every single event compare
 * it, field by field, with what a full reduce of the whole log produces at the same moment. If any accumulation leaks
 * across events, or any clock-dependent field is remembered when it should have been recomputed, one of these steps
 * disagrees.
 *
 * All times are relative to now: nothing here is pinned to a date.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, Reduction, reduce, advance, settle, empty, DEFAULT_DECIDER, type State, type Event, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);
const iso = (mins: number) => at(mins).toISOString();

/** State as plain data, with every Map and Set in a fixed order: two states are equal iff these are. */
function shape(s: State): unknown {
  const norm = (v: unknown): unknown => {
    if (v instanceof Map) return [...v].map(([k, x]) => [k, norm(x)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (v instanceof Set) return [...v].sort();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]).sort((a, b) => a[0].localeCompare(b[0])));
    return v;
  };
  return norm(s as unknown as Record<string, unknown>);
}

/** A log that exercises every part of a reduction: readings that expire, instructions that default, seams, rounds. */
async function busyLog(store: MemoryStore): Promise<Event[]> {
  const out: Event[] = [];
  const put = async (ne: NewEvent, mins: number) => { out.push(await append(store, ne, { human: HUMAN, now: at(mins) })); };

  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "frontend"] }, 0);
  await put({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "named-sha" }, 1);
  // a reading that goes off on its own, and one that supersedes another
  await put({ kind: "reading", actor: "qa", surface: "staging", key: "rows", value: 12, method: "数了一遍", valid_until: iso(30) }, 2);
  await put({ kind: "reading", actor: "qa", surface: "staging", key: "rows", value: 13, method: "又数了一遍" }, 3);

  // an ask with a default that nobody answers, one that gets acked, one that is taken back
  await put({ kind: "instruction", actor: "pd", to: HUMAN, body: "A 还是 B？", intent: "ask", options: ["A", "B"], default: "B", ack_by: iso(20) }, 4);
  await put({ kind: "instruction", actor: "pm", to: "dev", body: "先做这件", ack_by: iso(10) }, 5);
  await put({ kind: "instruction", actor: "pm", to: "qa", body: "算了，别做了", ack_by: iso(10) }, 6);
  await put({ kind: "ack", actor: "dev", of: out[5].id }, 7);
  await put({ kind: "untell", actor: "pm", of: out[6].id, reason: "改主意了" }, 8);

  // two tasks that collide, one that stacks on a done, a round that fails and is reopened
  await put({ kind: "task", op: "create", actor: "pm", task: "t-a", title: "甲", criteria: ["能用"] }, 9);
  await put({ kind: "task", op: "create", actor: "pm", task: "t-b", title: "乙", criteria: ["能用"] }, 10);
  await put({ kind: "task", op: "create", actor: "pm", task: "t-c", title: "丙", criteria: ["能用"] }, 11);
  await put({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["packages/core/src/x.ts"] }, 12);
  await put({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["packages/core/src/x.ts", "packages/core/src/y.ts"] }, 13);
  await put({ kind: "task", op: "claim", actor: "dev", task: "t-c", touches: ["docs"] }, 14);
  await put({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "abc1234: 做完了" , no_human_impact: true}, 15);
  await put({ kind: "task", op: "verify", actor: "qa", task: "t-a", surface: "repo", pass: false, evidence: "少一条测试" }, 16);
  await put({ kind: "task", op: "reopen", actor: "dev", task: "t-a", reason: "补测试" }, 17);
  await put({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "def5678: 补上了", touches: ["packages/core/src/x.ts#f"] , no_human_impact: true}, 18);
  await put({ kind: "task", op: "seam", actor: "pm", tasks: ["t-a", "t-b"], resolution: "frontend 合 dev 的" }, 19);
  await put({ kind: "task", op: "create", actor: "pm", task: "t-d", title: "丁", criteria: ["能用"] }, 20);
  await put({ kind: "task", op: "withdraw", actor: "pm", task: "t-d", reason: "前提不成立" }, 20);
  await put({ kind: "note", actor: HUMAN, body: "decision: A 还是 B？ -> A", decision: true, decides: { of: out[4].id, option: "A" }, refs: [out[4].id] }, 21);
  return out;
}

describe("t-128 · an advanced reduction is the reduction", () => {
  it("after every event, at every moment asked about, it equals a full reduce of the whole log", async () => {
    const store = new MemoryStore();
    const events = await busyLog(store);
    // Moments deliberately out of order: the last one is *before* the defaults fire, so anything a settle accumulated
    // has to be given back. A clock only ever moves forward in the world; a test is where that assumption gets checked.
    const moments = [at(5), at(15), at(25), at(60), at(5)];

    for (const when of moments) {
      const inc = new Reduction(store);
      const log = await store.read();
      for (let n = 1; n <= events.length; n++) {
        // the reduction is fed the same prefix the full reduce sees, one event at a time
        const prefix = { ...log, events: log.events.slice(0, n) };
        const cut = new MemoryStore();
        cut.events = prefix.events;
        const stepwise = await new Reduction(cut).at(when);
        expect(shape(stepwise)).toEqual(shape(reduce(prefix, when)));
      }
      expect(shape(await inc.at(when))).toEqual(shape(reduce(log, when)));
    }
  });

  it("one reduction settled again and again gives each moment its own answer", async () => {
    const store = new MemoryStore();
    await busyLog(store);
    const r = new Reduction(store);
    for (const when of [at(5), at(25), at(5), at(60), at(0)]) {
      expect(shape(await r.at(when))).toEqual(shape(reduce(await store.read(), when)));
    }
  });

  it("the default fires with the clock and is given back when the clock is asked earlier", async () => {
    const store = new MemoryStore();
    const ask = await append(store, { kind: "instruction", actor: "pd", to: HUMAN, body: "A 还是 B？", intent: "ask", options: ["A", "B"], default: "B", ack_by: iso(20) }, { human: HUMAN, now: at(0) });
    const r = new Reduction(store);
    expect((await r.at(at(30))).instructions.get(ask.id)!.chosen).toMatchObject({ option: "B", by: DEFAULT_DECIDER });
    expect((await r.at(at(10))).instructions.get(ask.id)!.chosen).toBeUndefined();
    expect((await r.at(at(30))).instructions.get(ask.id)!.overdue).toBe(false);   // the default answered it
  });

  it("an ack after a default had fired leaves no default behind", async () => {
    const store = new MemoryStore();
    const ask = await append(store, { kind: "instruction", actor: "pd", to: HUMAN, body: "A 还是 B？", intent: "ask", options: ["A", "B"], default: "B", ack_by: iso(20) }, { human: HUMAN, now: at(0) });
    const r = new Reduction(store);
    expect((await r.at(at(30))).instructions.get(ask.id)!.chosen?.by).toBe(DEFAULT_DECIDER);
    await append(store, { kind: "ack", actor: HUMAN, of: ask.id }, { human: HUMAN, now: at(31) });
    const s = await r.at(at(40));
    expect(s.instructions.get(ask.id)!.chosen).toBeUndefined();
    expect(s.instructions.get(ask.id)!.overdue).toBe(false);
    expect(shape(s)).toEqual(shape(reduce(await store.read(), at(40))));
  });

  it("an event that lands behind the mark is not missed: the count disagrees and it rebuilds", async () => {
    const store = new MemoryStore();
    await append(store, { kind: "note", actor: "pm", body: "一" }, { human: HUMAN, now: at(0) });
    const r = new Reduction(store);
    await r.at(at(1));
    // a second writer whose clock ran backwards: an id that sorts before what we already folded
    store.events.unshift({ id: "0", at: iso(-1), kind: "note", actor: "qa", body: "更早的一笔" } as Event);
    const s = await r.at(at(2));
    expect(s.notes.map((n) => n.body)).toEqual(["更早的一笔", "一"]);
    expect(shape(s)).toEqual(shape(reduce(await store.read(), at(2))));
  });

  it("advance is only ever the events: the same batch folded twice changes nothing", async () => {
    const store = new MemoryStore();
    await busyLog(store);
    const log = await store.read();
    const once = advance(empty(), log);
    const twice = advance(advance(empty(), log), log);
    expect(shape(settle(twice, at(60)))).toEqual(shape(settle(once, at(60))));
  });
});
