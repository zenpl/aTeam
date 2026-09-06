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
    const text = fmt.task(t, b.seams, b.omitted);
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

  it("shows a seam on both sides (stacked, since t-001 was done first), then its resolution and each verification", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-002", touches: ["packages/server/src/app.ts"] });
    let b = board(reduce(await store.read()), HUMAN);
    expect(fmt.task(boardTask(b, "t-001")!, b.seams, b.omitted)).toContain("stacked (t-002 on t-001, blocks nothing)  with t-002: packages/server/src/app.ts");
    expect(fmt.task(boardTask(b, "t-002")!, b.seams, b.omitted)).toContain("stacked (t-002 on t-001, blocks nothing)  with t-001: packages/server/src/app.ts");

    await emit({ kind: "task", op: "seam", actor: "pm", tasks: ["t-001", "t-002"], resolution: "frontend adds routes below /health only" });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-001", surface: "repo", pass: true, evidence: "ran dist locally" });
    await emit({ kind: "task", op: "done", actor: "frontend", task: "t-002" });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-002", surface: "production", pass: false, evidence: "GET / is still json" });
    b = board(reduce(await store.read()), HUMAN);
    const text = fmt.task(boardTask(b, "t-001")!, b.seams, b.omitted);
    expect(text).toContain("status     verified");
    expect(text).toContain("✓ pass  repo  by qa");
    expect(text).toContain(": ran dist locally");
    expect(text).toContain("resolved by pm  with t-002: packages/server/src/app.ts");
    const failed = fmt.task(boardTask(b, "t-002")!, b.seams, b.omitted);
    expect(failed).toContain("status     failed");
    expect(failed).toContain("✗ fail  production  by qa");
    expect(failed).toContain("evidence   —");
  });

  it("degrades to placeholders when the server is older than this CLI and omits the new fields", () => {
    const old = { id: "t-old", title: "Old", owner: "dev", verified_on: [] } as unknown as Parameters<typeof fmt.task>[0];
    const text = fmt.task(old, [], []); // an older server sends no omitted: the caller says "nothing", explicitly
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

describe("t-018 · task show lists attached notes and evidence updates", () => {
  it("prints notes in order with actor and time, and an 'evidence:' note right after the done evidence", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "note", actor: "qa", body: "concern: sha in evidence is not on the default branch", task: "t-001" });
    await emit({ kind: "note", actor: "dev", body: "evidence: fd76455 is now on the default branch too", task: "t-001" });
    await emit({ kind: "note", actor: "pm", body: "not attached" });
    const b = board(reduce(await store.read()), HUMAN);
    const text = fmt.task(boardTask(b, "t-001")!, b.seams, b.omitted);
    expect(text).toContain("evidence   fd76455: /health returns sha locally\n  + fd76455 is now on the default branch too  (dev 06:06)\nverifications");
    expect(text).toContain("notes\n  06:05 qa        concern: sha in evidence is not on the default branch\n  06:06 dev       evidence: fd76455 is now on the default branch too");
    expect(text).not.toContain("not attached");
    expect(fmt.task(boardTask(b, "t-002")!, b.seams, b.omitted)).toContain("notes\n  (none)");
    const ev = await emit({ kind: "note", actor: "qa", body: "one more", task: "t-002" });
    expect(fmt.event(ev, "pm")).toContain("note [t-002] one more");
  });
});

describe("t-057 · task show and the board say what superseded an obsolete task", () => {
  it("status line names the decision; the board lists it under obsolete", async () => {
    const { store, emit } = await fixture();
    const d = await emit({ kind: "note", actor: "pd", body: "决策：health 改走 /", decision: true });
    await emit({ kind: "task", op: "obsolete", actor: "pm", task: "t-001", decision: d.id, reason: "端点换了" });
    const b = board(reduce(await store.read()), HUMAN);
    const t = boardTask(b, "t-001")!;
    expect(t.status).toBe("obsolete");
    expect(fmt.task(t, b.seams, b.omitted)).toContain(`status     obsolete  已被 ${d.id} 取代（pm `);
    expect(fmt.task(t, b.seams, b.omitted)).toContain("：端点换了）");
    expect(fmt.board(b)).toContain(`obsolete  t-001          Server reports which commit is deployed  @dev  已被 ${d.id} 取代`);
  });
});

describe("t-064 · sync shows a withdrawal, and warns when I had already seen the instruction", () => {
  it("UNTELL line with the reason; the warning only when the pull says I had pulled it before", async () => {
    const { report } = await import("../src/loop.js");
    const i = { id: "01I", at: new Date().toISOString(), kind: "instruction", actor: "pm", to: "dev", body: "改 t-1", ack_by: new Date().toISOString() } as never;
    const u = { id: "01U", at: new Date().toISOString(), kind: "untell", actor: "pm", of: "01I", reason: "不用了" } as never;
    const together = report({ events: [i, u], for_me: [], cursor: "01U" }, "dev", null).join("\n");
    expect(together).toContain("UNTELL 01I  已撤回：不用了");
    expect(together).not.toContain("你已看过");
    const later = report({ events: [u], for_me: [], cursor: "01U", taken_back_seen: ["01I"] }, "dev", "01I").join("\n");
    expect(later).toContain("⇐ 你已看过的这条被撤回了（01I），不要照着做");
  });
});

describe("t-083 · the LIVE line says who and how long ago, in pd's words", () => {
  it("推的 for a push, 核对 (no 的) for a measurement, both with a relative time; neither when the source is unsaid", async () => {
    const store = new MemoryStore();
    let t = Date.parse("2026-09-06T06:00:00Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const line = async (method: string | undefined, value: string) => {
      await emit({ kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value, method, depends_on: ["production:deployed.sha"] });
      const b = board(reduce(await store.read(), new Date(t + 300_000)), HUMAN, new Date(t + 300_000));
      return fmt.board(b, "dev").split("\n").find((l) => l.startsWith("LIVE"))!;
    };
    expect(await line("ateam release --deploy 推到 production", "aaaaaaa")).toContain("(qa 5m前推的)");
    expect(await line("curl /health 读 sha", "bbbbbbb")).toContain("(qa 5m前核对)");
    expect(await line("curl /health 读 sha", "ccccccc")).not.toContain("核对的"); // pd 22:47: 核对 carries no 的
    const unsaid = await line(undefined, "ddddddd");
    expect(unsaid).toContain("ddddddd");
    expect(unsaid).not.toMatch(/推的|核对/);
  });
});
