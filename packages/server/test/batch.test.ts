/**
 * t-129, over the wire: a batch that no longer matches production says so on the board a person actually reads —
 * and says which of the two kinds it is, because they need opposite actions. On the slim board too: the batch a
 * person must not push is not something to leave out of the small response.
 *
 * Times relative to now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";
const OLD = "eae0b22e1c645274e3cebdd1b569c26326b98aaf";
const NEW = "7f31808ae1c645274e3cebdd1b569c26326b98ab";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>, base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
  return j;
};
const board = async (path = "/board?full=1") =>
  (await (await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json()) as Board;

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-129 · 批次在牌桌上说得出为什么过期与下一步", () => {
  it("两种过期各自的形态与文案，都到得了读牌桌的人手里", async () => {
    await post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: OLD, method: "ateam release --deploy", writes: ["production:deployed.sha"] });
    await post("release", { kind: "reading", surface: "repo", key: "batch.8a", value: { sha: "aaaaaaa", base: OLD, contains: ["t-079b", "t-081"] }, method: "装配", depends_on: ["production:deployed.sha"] });
    await post("release", { kind: "reading", surface: "repo", key: "batch.8b", value: { sha: "bbbbbbb", base: OLD, contains: ["t-080", "t-079a", "t-079b", "t-081"] }, method: "装配", depends_on: ["production:deployed.sha"] });
    expect((await board()).batches.map((x) => x.state)).toEqual(["current", "current"]);

    // the hotfix goes out on its own: production moves, and both batches go stale without anyone saying so
    await post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: NEW, method: "ateam release --deploy", writes: ["production:deployed.sha"] });
    await post("release", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: NEW, contained: ["t-080", "t-079a"], not_contained: ["t-079b", "t-081"], method: "git merge-base --is-ancestor 逐件" } });

    const b = await board();
    const a8 = b.batches.find((x) => x.name === "8a")!, b8 = b.batches.find((x) => x.name === "8b")!;
    // 8a is the one that really happened: pushing it takes t-080 and t-079a back off production
    expect(a8.state).toBe("rollback");
    expect(a8.loses).toEqual(["t-080", "t-079a"]);
    expect(a8.line).toContain("推它会把 t-080、t-079a 从生产上退回去");
    expect(a8.line).toContain("别推");
    // 8b carries everything production carries: it only needs packing again
    expect(b8.state).toBe("stale");
    expect(b8.loses).toEqual([]);
    expect(b8.line).toContain("重装一次即可");
    expect(b8.line).not.toContain("别推");
    // both name what they were packed on and where production actually is
    for (const x of [a8, b8]) { expect(x.line).toContain(OLD.slice(0, 7)); expect(x.line).toContain(NEW.slice(0, 7)); }
  });

  it("小板上一个字不少：不能推的那一批正是不该被裁掉的东西", async () => {
    const slim = await board("/board");
    expect(slim.batches.map((x) => [x.name, x.state, x.line])).toEqual((await board()).batches.map((x) => [x.name, x.state, x.line]));
    expect(slim.omitted.some((p) => p.startsWith("batches"))).toBe(false);
  });
});
