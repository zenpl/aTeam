/**
 * t-112 round 2 (qa 03:53 判不过). Round one surveyed the gates by hand, from the ones pd and pm had named out loud,
 * and missed the R6 gate added the same night — the very failure the criterion warned against: 「数目以普查为准…今天已经
 * 栽过一次只修报上来的那一处」. Repeating it means a hand count is the wrong instrument, not that the count was careless.
 *
 * So the survey is made structural. `case "verify"`'s `if (e.pass)` block is, by construction, exactly the branches
 * that refuse a pass and nothing else — the gates the rule is about. This file reads that block out of the source and
 * requires pd's sentence of every throw in it. A gate added tomorrow without the sentence fails here, rather than on
 * production three days later.
 *
 * Reading source in a test is not a substitute for behaviour, so each gate is also driven for real below.
 * All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryStore, append, reduce, Rejected, PASS_ONLY_GATE, PASS_ONLY_REGION, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

const SRC = readFileSync(new URL("../src/rules.ts", import.meta.url), "utf8");

/** The `if (e.pass) { … }` block of `case "verify"`, by brace depth. Everything that refuses a pass lives there. */
function passOnlyBlock(): string {
  const start = SRC.indexOf(PASS_ONLY_REGION, SRC.indexOf('case "verify":'));
  expect(start).toBeGreaterThan(0);
  let depth = 0, i = start + PASS_ONLY_REGION.length - 1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

/** Every `throw new Rejected(` in a block, as its own text up to the closing `);` of that statement. */
function throwsIn(block: string): string[] {
  return [...block.matchAll(/throw new Rejected\([\s\S]*?\);/g)].map((m) => m[0]);
}

describe("t-112 · every gate that refuses a pass says the same sentence", () => {
  it("the survey is the code, not a list: each throw in the pass-only block carries PASS_ONLY_GATE", () => {
    const gates = throwsIn(passOnlyBlock());
    expect(gates.length).toBeGreaterThanOrEqual(6);          // round one found one of these by hand
    const naked = gates.filter((g) => !g.includes("PASS_ONLY_GATE"));
    expect(naked).toEqual([]);
  });

  it("and none of them writes that sentence out again in its own words", () => {
    const block = passOnlyBlock();
    // the two synonyms round one left behind; a gate saying it twice, differently, is what t-118 exists to stop
    expect(block).not.toContain("fail 不受此限");
    expect(SRC.slice(SRC.indexOf("export function whoCanVerify"))).not.toContain("fail 不受此限");
    // the sentence itself lives in one place
    expect([...SRC.matchAll(/这挡住的是通过，不是不通过/g)]).toHaveLength(1);
  });

  it("a fail is never refused for who is saying it: nothing in the else branch is a gate", () => {
    const verify = SRC.slice(SRC.indexOf('case "verify":'));
    const block = passOnlyBlock();
    const rest = verify.slice(verify.indexOf(block) + block.length, verify.indexOf("\n      return;"));
    for (const g of throwsIn(rest)) {
      expect(g).toMatch(/evidence|判据/);                     // what the fail says, never who says it
      expect(g).not.toContain("whoCanVerify");
    }
    expect(block).not.toMatch(/anyway|--force|bypass|旁路/);   // t-112 判据 3: no reasoned way around a fail
  });
});

describe("t-112 · each gate, driven for real: the pass is refused with pd's sentence, the fail lands", () => {
  /** A task done and waiting, in a project whose roles are pm/dev/qa/frontend (qa alone holds R6 by default). */
  const ready = async () => {
    const s = new MemoryStore();
    const put = (ne: NewEvent, mins: number) => append(s, ne, { human: HUMAN, now: at(mins) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "frontend"] }, 0);
    await put({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "一件", criteria: ["能用", "能看"] }, 1);
    await put({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["packages/x/a.ts"] }, 2);
    await put({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: "abc1234: 做完了" }, 3);
    return { s, put };
  };
  const refusal = async (s: MemoryStore, ne: NewEvent, mins: number) =>
    append(s, ne, { human: HUMAN, now: at(mins) }).catch((e: Rejected) => e) as Promise<Rejected>;
  const pass = (actor: string, surface = "repo") => ({ kind: "task", op: "verify", actor, task: "t-1", surface, pass: true }) as NewEvent;
  const fail = (actor: string, surface = "repo", evidence?: string) => ({ kind: "task", op: "verify", actor, task: "t-1", surface, pass: false, evidence }) as NewEvent;

  it("owner", async () => {
    const { s } = await ready();
    expect((await refusal(s, pass("dev"), 4)).message).toContain(PASS_ONLY_GATE);
    expect((await append(s, fail("dev", "repo", "自己看出来不对"), { human: HUMAN, now: at(5) })).id).toBeTruthy();
  });

  it("whoever wrote the criteria", async () => {
    const { s, put } = await ready();
    await put({ kind: "reading", actor: "pm", surface: "node", key: "pm:能力", value: ["R6"] }, 4);   // pm holds R6 and still may not
    expect((await refusal(s, pass("pm"), 5)).message).toContain(PASS_ONLY_GATE);
    expect((await append(s, fail("pm", "repo", "判据 1 没做到"), { human: HUMAN, now: at(6) })).id).toBeTruthy();
  });

  it("not an R6 holder — the one round one missed", async () => {
    const { s } = await ready();
    const r = await refusal(s, pass("frontend"), 4);
    expect(r.message).toContain("不持");
    expect(r.message).toContain(PASS_ONLY_GATE);
    expect(r.message).not.toContain("fail 不受此限");
    expect((await append(s, fail("frontend", "repo", "我看出来它坏了"), { human: HUMAN, now: at(5) })).id).toBeTruthy();
  });

  it("already passed on this surface", async () => {
    const { s, put } = await ready();
    await put({ kind: "reading", actor: "pd", surface: "node", key: "frontend:能力", value: ["R6"] }, 4);
    await put(pass("qa"), 5);
    expect((await refusal(s, pass("frontend"), 6)).message).toContain(PASS_ONLY_GATE);
    expect((await append(s, fail("frontend", "repo", "后来发现它坏了"), { human: HUMAN, now: at(7) })).id).toBeTruthy();
  });

  it("this round already failed here", async () => {
    // a fail with nothing passed yet sends the task to failed, and a failed task is not done — a different refusal.
    // The gate this is about needs the task still standing: passed somewhere else, then failed here.
    const { s, put } = await ready();
    await put({ kind: "reading", actor: "pd", surface: "node", key: "frontend:能力", value: ["R6"] }, 4);
    await put(pass("qa", "staging"), 5);
    await put(fail("dev", "repo", "在 repo 上不行"), 6);
    const r = await refusal(s, pass("frontend"), 7);
    expect(r.message).toContain("要等一次新的 done");
    expect(r.message).toContain(PASS_ONLY_GATE);
    expect((await append(s, fail("frontend", "repo", "我也判它不过"), { human: HUMAN, now: at(8) })).id).toBeTruthy();
  });

  it("an unresolved seam — qa 00:51's scene, still fixed", async () => {
    // both in flight at once: the other side claimed before this one was done, so neither stacks on the other
    const s = new MemoryStore();
    const put = (ne: NewEvent, mins: number) => append(s, ne, { human: HUMAN, now: at(mins) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "frontend"] }, 0);
    await put({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "一件", criteria: ["能用", "能看"] }, 1);
    await put({ kind: "task", op: "create", actor: "pm", task: "t-2", title: "另一件", criteria: ["能用"] }, 2);
    await put({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["packages/x/a.ts"] }, 3);
    await put({ kind: "task", op: "claim", actor: "frontend", task: "t-2", touches: ["packages/x/a.ts"] }, 4);
    await put({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: "abc1234: 做完了" }, 5);
    const r = await refusal(s, pass("qa"), 6);
    expect(r.message).toContain("unresolved seam");
    expect(r.message).toContain(PASS_ONLY_GATE);
    expect((await append(s, fail("qa", "repo", "它就是坏的，接缝不接缝都坏"), { human: HUMAN, now: at(7) })).id).toBeTruthy();
    expect(reduce(await s.read(), at(8)).tasks.get("t-1")!.status).toBe("failed");
  });
});
