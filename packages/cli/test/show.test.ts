/**
 * `ateam task show <id>` (t-003): a session must be able to read a task's criteria, owner, evidence and
 * verifications from the CLI instead of curling the raw log.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, boardTask, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";

async function fixture() {
  const store = new MemoryStore();
  let t = Date.parse("2026-09-06T06:00:00Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-001", title: "Server reports which commit is deployed",
    criteria: ["GET /health returns {ok, sha}", "missing sha shows as 'unknown'", "qa records production:deployed.sha"] });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-002", title: "HTML board", criteria: ["GET / is html"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-001", touches: ["packages/server/src/app.ts", "GET /health"] });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-001", evidence: "fd76455: /health returns sha locally" });
  return { store, emit };
}

describe("t-003 · ateam task show", () => {
  it("prints title, status, owner, numbered criteria, touches and evidence for a created→claimed→done task", async () => {
    const { store } = await fixture();
    const b = board(reduce(await store.read()), HUMAN);
    const t = boardTask(b, "t-001")!;
    expect(t.status).toBe("done");
    const text = fmt.task(t, b.seams);
    expect(text).toContain("t-001  Server reports which commit is deployed");
    expect(text).toContain("status     done");
    expect(text).toContain("owner      dev");
    expect(text).toContain("criteria   (by pm)");
    expect(text).toContain("  1. GET /health returns {ok, sha}");
    expect(text).toContain("  2. missing sha shows as 'unknown'");
    expect(text).toContain("  3. qa records production:deployed.sha");
    expect(text).toContain("touches    packages/server/src/app.ts, GET /health");
    expect(text).toContain("evidence   fd76455: /health returns sha locally");
    expect(text).toContain("verifications\n  (none)");
    expect(text).toContain("seams\n  (none)");
  });

  it("shows an open seam on both sides, then its resolution and each verification with surface and pass/fail", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-002", touches: ["packages/server/src/app.ts"] });
    let b = board(reduce(await store.read()), HUMAN);
    expect(fmt.task(boardTask(b, "t-001")!, b.seams)).toContain("OPEN  with t-002: packages/server/src/app.ts");
    expect(fmt.task(boardTask(b, "t-002")!, b.seams)).toContain("OPEN  with t-001: packages/server/src/app.ts");

    await emit({ kind: "task", op: "seam", actor: "pm", tasks: ["t-001", "t-002"], resolution: "frontend adds routes below /health only" });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-001", surface: "repo", pass: true, evidence: "ran dist locally" });
    await emit({ kind: "task", op: "done", actor: "frontend", task: "t-002" });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-002", surface: "production", pass: false, evidence: "GET / is still json" });
    b = board(reduce(await store.read()), HUMAN);
    const text = fmt.task(boardTask(b, "t-001")!, b.seams);
    expect(text).toContain("status     verified");
    expect(text).toContain("✓ pass  repo  by qa");
    expect(text).toContain(": ran dist locally");
    expect(text).toContain("resolved by pm  with t-002: packages/server/src/app.ts");
    const failed = fmt.task(boardTask(b, "t-002")!, b.seams);
    expect(failed).toContain("status     failed");
    expect(failed).toContain("✗ fail  production  by qa");
    expect(failed).toContain("evidence   —");
  });

  it("degrades to placeholders when the server is older than this CLI and omits the new fields", () => {
    const old = { id: "t-old", title: "Old", owner: "dev", verified_on: [] } as unknown as Parameters<typeof fmt.task>[0];
    const text = fmt.task(old, []);
    expect(text).toContain("criteria   (not reported by this server; read them with ateam log)");
    expect(text).toContain("touches    —");
  });

  it("board --json carries criteria for every task, and an unknown id is not found", async () => {
    const { store } = await fixture();
    const b = board(reduce(await store.read()), HUMAN);
    const all = Object.values(b.tasks).flat();
    expect(all).toHaveLength(2);
    for (const t of all) expect(t.criteria.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(b)).tasks.open[0].criteria).toEqual(["GET / is html"]);
    expect(boardTask(b, "t-999")).toBeUndefined();
  });
});
