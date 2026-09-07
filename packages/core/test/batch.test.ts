/**
 * t-129: a batch is a reading that expires by itself, and its expiry says which of two kinds it is.
 *
 * The night this came from: pm froze be9b232 while production was eae0b22. Production became 7f31808, and nothing in
 * the log went stale — so the same dead sha was repeated in an instruction and in the focus, three times, and pushing
 * it would have taken t-080 and half of t-079 back off production. Nothing said so. Two different things had gone
 * wrong at once and both looked identical: "the batch is old".
 *
 * All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, batches, BATCH_LINES, deployedTasksFact, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);
const OLD = "eae0b22e1c645274e3cebdd1b569c26326b98aaf";
const NEW = "7f31808ae1c645274e3cebdd1b569c26326b98ab";

function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  const state = async (mins: number) => reduce(await s.read(), at(mins));
  return { s, put, state };
}
const deployed = (sha: string, mins: number, w: ReturnType<typeof world>) =>
  w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: sha, method: "ateam release --deploy", writes: ["production:deployed.sha"] }, mins);
const contains = (sha: string, contained: string[], not_contained: string[], mins: number, w: ReturnType<typeof world>) =>
  w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks", value: { sha, contained, not_contained, method: "git merge-base --is-ancestor 逐件" } }, mins);
const pack = (name: string, sha: string, base: string, list: string[], mins: number, w: ReturnType<typeof world>) =>
  w.put({ kind: "reading", actor: "release", surface: "repo", key: `batch.${name}`, value: { sha, base, contains: list }, method: "装配", depends_on: ["production:deployed.sha"] }, mins);
const seen = async (w: ReturnType<typeof world>, mins: number) => {
  const st = await w.state(mins);
  const b = board(st, HUMAN, at(mins));
  return { st, b, batch: (name: string) => b.batches.find((x) => x.name === name)! };
};

describe("t-129 · a batch expires by itself, and says which kind of expiry it is", () => {
  it("packed on where production is: nothing to say", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await contains(OLD, ["t-1"], ["t-2"], 1, w);
    await pack("8b", "be9b232", OLD, ["t-1", "t-2"], 2, w);
    const { batch } = await seen(w, 3);
    expect(batch("8b").state).toBe("current");
    expect(batch("8b").line).toBe("");
    expect(batch("8b").loses).toEqual([]);
  });

  it("production moved and the batch has everything it has: pack it again", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8b", "be9b232", OLD, ["t-1", "t-2", "t-3"], 1, w);
    await deployed(NEW, 2, w);
    await contains(NEW, ["t-1", "t-2"], ["t-3"], 3, w);
    const { st, batch } = await seen(w, 4);
    expect(batch("8b").state).toBe("stale");
    expect(batch("8b").loses).toEqual([]);
    expect(batch("8b").line).toBe(BATCH_LINES.stale(OLD, NEW));
    expect(batch("8b").line).toContain("重装一次即可");
    // the reading itself went stale on its own, because it said what it depends on — nobody had to remember
    const r = [...st.readings.values()].find((x) => x.reading.key === "batch.8b")!;
    expect(r.valid).toBe(false);
    expect(r.invalidated_by).toBeTruthy();
  });

  it("production carries work the batch does not: pushing it would take that work back, by name", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8b", "be9b232", OLD, ["t-079b", "t-081"], 1, w);
    await deployed(NEW, 2, w);                                        // the hotfix went out on its own
    await contains(NEW, ["t-080", "t-079a", "t-081"], ["t-079b"], 3, w);
    const { batch } = await seen(w, 4);
    expect(batch("8b").state).toBe("rollback");
    expect(batch("8b").loses).toEqual(["t-080", "t-079a"]);            // the two the night really lost
    expect(batch("8b").line).toBe(BATCH_LINES.rollback(OLD, NEW, ["t-080", "t-079a"]));
    expect(batch("8b").line).toContain("别推");
    expect(batch("8b").line).toContain("t-080、t-079a");
  });

  it("no containment fact for the current head: it says it cannot tell, and why, rather than guessing", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8b", "be9b232", OLD, ["t-1"], 1, w);
    await deployed(NEW, 2, w);                                        // nobody has run `ateam release` against NEW
    const { b, batch } = await seen(w, 3);
    expect(batch("8b").state).toBe("unknown");
    expect(batch("8b").loses).toEqual([]);
    expect(batch("8b").line).toBe(BATCH_LINES.unknown(b.release.basis));
    expect(batch("8b").line).not.toContain("重装一次即可");            // never an answer it does not have
    expect(batch("8b").line).not.toContain("别推");
    // a fact measured against the *old* head is not a fact about this one
    await contains(OLD, ["t-1"], [], 4, w);
    expect((await seen(w, 5)).batch("8b").state).toBe("unknown");
  });

  it("several batches, newest first, each judged on its own base", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8a", "aaaaaaa", OLD, ["t-1"], 1, w);
    await pack("8b", "bbbbbbb", OLD, ["t-1", "t-2"], 2, w);
    await deployed(NEW, 3, w);
    await contains(NEW, ["t-1", "t-2"], ["t-3"], 4, w);
    await pack("8c", "ccccccc", NEW, ["t-1", "t-2", "t-3"], 5, w);
    const { b } = await seen(w, 6);
    expect(b.batches.map((x) => [x.name, x.state])).toEqual([["8c", "current"], ["8b", "stale"], ["8a", "rollback"]]);
    expect(b.batches.find((x) => x.name === "8a")!.loses).toEqual(["t-2"]);
  });

  it("judged on the same basis the release split uses: the two can never disagree", async () => {
    const w = world();
    await deployed(NEW, 0, w);
    await pack("8c", "ccccccc", OLD, ["t-1"], 1, w);
    const { st, b } = await seen(w, 2);
    expect(deployedTasksFact(st)).toBeNull();
    expect(b.batches[0].line).toContain(b.release.basis);              // one reason, said once
    expect(batches(st, b.release.deployed_sha, b.release.basis, deployedTasksFact(st))[0].state).toBe("unknown");
  });
});
