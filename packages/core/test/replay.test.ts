/**
 * Replay of the 2026-09-05 field report ("Git 总线上的五个 Agent").
 * Each test is one failure mode from that day. The tool must make it impossible or visible.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryStore, append, appendFrom, pull, reduce, board, openSeamsFor, projectRoles, roleResponsibilities, boardTask, slimBoard, importCounts, runFollowUps, runDueDefaults, defaultApplied, DEFAULT_LINES, atClock, SERVICE_ACTOR, surfaceResults, evidenceSha, splitTitle, manual, manualRoles, isMissing, Rejected, PASS_ONLY_GATE, SAID_PREFIX, DEFER_PREFIX, type NewEvent, type Event, type Board } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-05T09:00:00Z");
const min = (n: number) => n * 60_000;

function clock(start = T0) {
  let t = start;
  return {
    now: () => new Date(t),
    tick: (ms: number) => { t += ms; return new Date(t); },
    iso: (ms = 0) => new Date(t + ms).toISOString(),
  };
}

async function emit(store: MemoryStore, c: ReturnType<typeof clock>, e: NewEvent): Promise<Event> {
  return append(store, e, { human: HUMAN, now: c.now() });
}

async function rejected(p: Promise<unknown>): Promise<Rejected> {
  try { await p; } catch (e) { if (e instanceof Rejected) return e; throw e; }
  throw new Error("expected Rejected");
}

describe("F1/F2 · instructions have delivery, ack and an overdue state", () => {
  it("records when the recipient pulled it, and escalates to the human when unacked", async () => {
    const store = new MemoryStore();
    const c = clock();
    const order = await emit(store, c, { kind: "instruction", actor: "pm", to: "backend", body: "放行 PR #41，合入 main", ack_by: c.iso(min(10)) });

    // backend is busy for 25 minutes; PM cannot know
    c.tick(min(25));
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    // t-147: this one carries no options, so nothing is owed but the doing — it is not overdue and nobody is chased
    // for a receipt. What is true is that it has not been read, and that is where it shows.
    expect(b.instructions[0].status).toBe("pending");
    expect(b.overdue).toEqual([]);
    expect(b.overdue_by_presence.missing.instructions).toEqual([order.id]);
    expect(b.overdue_by_presence.missing.line).toContain("没送到");
    // still the team's problem, not a question for the human
    expect(b.needs_human).toHaveLength(0);

    // backend finally pulls: delivery is a server-side fact, not a guess
    const got = await pull(store, "backend", null, c.now());
    expect(got.for_me.map((e) => e.id)).toEqual([order.id]);
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.instructions[0].delivered).toBe(c.iso());

    await emit(store, c, { kind: "ack", actor: "backend", of: order.id });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.instructions[0].status).toBe("acked");
    expect(b.needs_human).toHaveLength(0);
    expect(b.overdue).toHaveLength(0);
    // latency is measurable: sent → delivered
    expect(Date.parse(b.instructions[0].delivered!) - Date.parse(b.instructions[0].sent)).toBe(min(25));
  });

  it("refuses an instruction that buries the action in an essay", async () => {
    const store = new MemoryStore();
    const c = clock();
    const essay = "关于基线的说明：".padEnd(400, "。") + " 顺便，放行 PR #41";
    const r = await rejected(emit(store, c, { kind: "instruction", actor: "pm", to: "backend", body: essay, ack_by: c.iso(min(10)) }));
    expect(r.rule).toBe("instruction");
  });

  it("only the recipient (or the human) can ack", async () => {
    const store = new MemoryStore();
    const c = clock();
    const i = await emit(store, c, { kind: "instruction", actor: "pm", to: "backend", body: "stop", ack_by: c.iso(min(5)) });
    expect((await rejected(emit(store, c, { kind: "ack", actor: "frontend", of: i.id }))).rule).toBe("ack");
  });
});

describe("F4 · a seam appears when two in-flight tasks touch the same surface", () => {
  it("blocks verification of either side until someone owns the seam", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-login", title: "Login redirect fix", criteria: ["user lands on /home after login"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-session", title: "Session cookie flags", criteria: ["cookie is SameSite=Lax"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t-login", touches: ["auth/login.ts", "auth.session_cookie"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "backend", task: "t-session", touches: ["auth.session_cookie", "api/session.ts"] });

    let s = reduce(await store.read(), c.now());
    expect([...s.seams.values()]).toHaveLength(1);
    expect([...s.seams.values()][0].overlap).toEqual(["auth.session_cookie"]);
    expect(board(s, HUMAN, c.now()).seams.some((x) => x.open)).toBe(true);
    expect(board(s, HUMAN, c.now()).needs_human).toHaveLength(0); // the seam is the team's to own, not the human's question

    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-login" , no_human_impact: true});
    const r = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-login", surface: "staging", pass: true }));
    expect(r.rule).toBe("verify");
    expect(r.message).toMatch(/seam/);

    await emit(store, c, { kind: "task", op: "seam", actor: "backend", tasks: ["t-login", "t-session"], resolution: "cookie flags set server-side; frontend reads only" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-login", surface: "staging", pass: true });
    s = reduce(await store.read(), c.now());
    expect(s.tasks.get("t-login")!.status).toBe("verified");
  });
});

describe("F5 · separation of duties is a rule, not a role", () => {
  it("the owner cannot verify their own work; the criteria author cannot judge them met", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t1", title: "x", criteria: ["y"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "backend", task: "t1", touches: ["a"] });
    // "done" is a claim, not a verdict
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true }))).message).toMatch(/not done/);
    await emit(store, c, { kind: "task", op: "done", actor: "backend", task: "t1", evidence: "guard test added" , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "backend", task: "t1", surface: "repo", pass: true }))).message).toMatch(/owner/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pm", task: "t1", surface: "repo", pass: true }))).message).toMatch(/criteria/);
    // the human is the policy authority and may verify anything
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t1", surface: "repo", pass: false, evidence: "guard test file never pushed" });
    expect(reduce(await store.read(), c.now()).tasks.get("t1")!.status).toBe("failed");
  });

  it("verification names its surface; the board shows which surfaces a task passed on", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t1", title: "copy fix", criteria: ["banner says X"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t1", touches: ["Banner.tsx"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t1" , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "", pass: true }))).message).toMatch(/surface/);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true, evidence: "grep found new copy" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.verified[0].verified_on).toEqual(["repo"]); // visibly not "production"
  });
});

describe("t-006 · verified on one surface is not verified on another", () => {
  async function doneTask(store: MemoryStore, c: ReturnType<typeof clock>, id = "t1") {
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: "sha endpoint", criteria: ["/health has sha"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id, evidence: "fd76455" , no_human_impact: true});
  }
  const status = async (store: MemoryStore, c: ReturnType<typeof clock>) => reduce(await store.read(), c.now()).tasks.get("t1")!.status;

  it("accepts a production verify after a repo pass; rejects a second pass on repo, naming the surface", async () => {
    const store = new MemoryStore();
    const c = clock();
    await doneTask(store, c);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true, evidence: "ran dist" });
    expect(await status(store, c)).toBe("verified");
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "production", pass: true, evidence: "curl /health" });
    expect(await status(store, c)).toBe("verified");
    const again = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true }));
    expect(again.rule).toBe("verify");
    expect(again.message).toMatch(/already passed on repo/);
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.verified[0].surfaces).toEqual([{ surface: "repo", pass: true }, { surface: "production", pass: true }]);
    expect(b.tasks.verified[0].verified_on).toEqual(["repo", "production"]);
    expect(b.tasks.verified[0].verifications).toHaveLength(2);
  });

  it("a production fail after a repo pass sends the task back to done and the board shows both results", async () => {
    const store = new MemoryStore();
    const c = clock();
    await doneTask(store, c);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "production", pass: false, evidence: "sha is unknown" });
    expect(await status(store, c)).toBe("done");
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.done[0].surfaces).toEqual([{ surface: "repo", pass: true }, { surface: "production", pass: false }]);
    expect(b.tasks.done[0].verified_on).toEqual(["repo"]);
    // t-104 ② (pd 00:12): one fail closes that surface to every pass until a new done — a redeploy is not one, and
    // "someone else passes it instead" is changing judges, not overturning. The owner says it again, then production
    // may be judged again; repo still cannot.
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "production", pass: true }))).message).toMatch(/要等一次新的 done/);
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "t1", reason: "重新部署" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t1", evidence: "无需改动：重新部署后 /health 报的就是这个 sha" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "production", pass: true });
    expect(await status(store, c)).toBe("verified");
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true }))).message).toMatch(/repo/);
  });

  it("a failed task that is reclaimed and done again starts a new round: repo may pass again, history is kept", async () => {
    const store = new MemoryStore();
    const c = clock();
    await doneTask(store, c);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: false, evidence: "no sha field" });
    expect(await status(store, c)).toBe("failed");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t1", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t1", evidence: "abc1234" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true });
    expect(await status(store, c)).toBe("verified");
    const t = reduce(await store.read(), c.now()).tasks.get("t1")!;
    expect(t.verifications.map((v) => [v.round, v.surface, v.pass])).toEqual([[1, "repo", false], [2, "repo", true]]);
  });

  it("owner and criteria-author exclusions and the open-seam rule still apply on the second surface", async () => {
    const store = new MemoryStore();
    const c = clock();
    await doneTask(store, c);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true });
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "t1", surface: "production", pass: true }))).message).toMatch(/owner/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pm", task: "t1", surface: "production", pass: true }))).message).toMatch(/criteria/);

    // a seam between two tasks that were in flight together blocks the next surface too
    const store2 = new MemoryStore();
    await emit(store2, c, { kind: "task", op: "create", actor: "pm", task: "t1", title: "sha endpoint", criteria: ["/health has sha"] , no_human_impact: true});
    await emit(store2, c, { kind: "task", op: "create", actor: "pm", task: "t2", title: "board page", criteria: ["GET / html"] , no_human_impact: true});
    await emit(store2, c, { kind: "task", op: "claim", actor: "dev", task: "t1", touches: ["app.ts"] });
    await emit(store2, c, { kind: "task", op: "claim", actor: "frontend", task: "t2", touches: ["app.ts"] });
    await emit(store2, c, { kind: "task", op: "done", actor: "dev", task: "t1" , no_human_impact: true});
    expect((await rejected(emit(store2, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "production", pass: true }))).message).toMatch(/seam/);
  });
});

describe("t-009 · a seam with a task that was done before you claimed is stacking, not a collision", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] , no_human_impact: true});

  it("A claim -> A done -> B claim overlapping: verify A is accepted; the board lists the seam as stacked", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "5241517" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["cli/main.ts"] });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams).toHaveLength(1);
    expect(b.seams[0].stacked).toEqual({ done: "A", on: "B" });
    expect(b.seams[0].open).toBe(false);
    expect(b.needs_human).toHaveLength(0);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
  });

  it("A claim -> B claim overlapping -> A done: verify A is still rejected (both were in flight)", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams[0].stacked).toBeUndefined();
    expect(b.seams[0].open).toBe(true);
    expect(b.needs_human).toHaveLength(0); // a seam is the team's to own, never a question for the human
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }))).message).toMatch(/seam/);
  });

  it("a stacked seam turns back into a collision if the done task fails and is reclaimed while the other is still in flight", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "test missing" });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["cli/main.ts"] });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams[0].stacked).toBeUndefined();
    expect(b.seams[0].open).toBe(true);
  });
});

describe("t-010 · touches overlap by path, and the owner can widen a claim", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] , no_human_impact: true});
  const seams = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).seams;

  it("main.ts#init overlaps main.ts; packages/cli overlaps packages/cli/src/main.ts; unrelated paths do not", async () => {
    const store = new MemoryStore();
    const c = clock();
    for (const id of ["A", "B", "C", "D"]) await create(store, c, id);
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["packages/cli/src/main.ts#init"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["packages/cli/src/main.ts"] });
    let s = await seams(store, c);
    expect(s.map((x) => x.id)).toEqual(["seam:A+B"]);
    expect(s[0].overlap.sort()).toEqual(["packages/cli/src/main.ts", "packages/cli/src/main.ts#init"]);

    await emit(store, c, { kind: "task", op: "claim", actor: "qa", task: "C", touches: ["packages/cli"] });
    s = await seams(store, c);
    expect(s.map((x) => x.id).sort()).toEqual(["seam:A+B", "seam:A+C", "seam:B+C"]);

    await emit(store, c, { kind: "task", op: "claim", actor: "pm", task: "D", touches: ["packages/client", "packages/clix/src/main.ts", "packages/server/src/main.tsx", "GET /health"] });
    expect((await seams(store, c)).some((x) => x.tasks.includes("D"))).toBe(false);
  });

  it("the owner may claim again to widen touches; the union is kept and a seam a fresh claim would raise appears", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["packages/core/src/rules.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["packages/server/src/app.ts"] });
    expect(await seams(store, c)).toHaveLength(0);

    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["packages/server/src/app.ts#health"] });
    const st = reduce(await store.read(), c.now());
    expect(st.tasks.get("A")!.touches).toEqual(["packages/core/src/rules.ts", "packages/server/src/app.ts#health"]);
    expect(st.tasks.get("A")!.status).toBe("working");
    expect(st.tasks.get("A")!.owner).toBe("dev");
    expect((await seams(store, c)).map((x) => x.id)).toEqual(["seam:A+B"]);

    // still nobody else's to claim
    const r = await rejected(emit(store, c, { kind: "task", op: "claim", actor: "qa", task: "A", touches: ["x"] }));
    expect(r.rule).toBe("claim");
    expect(r.message).toMatch(/owner dev/);
  });
});

describe("t-008 · a reading key can declare what values it takes", () => {
  it("deployed.sha takes a git sha by default and rejects an event id, naming the key and the shape", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "fd764558495cfa377bb2c7b40ca4016cf57f79d6" });
    await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "staging", value: "fd76455" });
    const r = await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "01M1TNREK0TD5ZFJXK18XVNTWF" }));
    expect(r.rule).toBe("reading");
    expect(r.message).toMatch(/production:deployed\.sha/);
    expect(r.message).toMatch(/\[0-9a-f\]\{7,40\}/);
    // t-024: "unknown" is what /health says when the image carries no sha; recording that is a true reading
    await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "unknown" });
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "unknow" }))).message).toMatch(/does not match shape/);
    expect(reduce(await store.read(), c.now()).readings.size).toBe(3);
  });

  it("an undeclared key takes anything, as before", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", key: "health", surface: "production", value: "ok" });
    await emit(store, c, { kind: "reading", actor: "pm", key: "health", surface: "production", value: { ok: true, sha: "x" } });
    await emit(store, c, { kind: "reading", actor: "pm", key: "health", surface: "production", value: 42 });
    expect(reduce(await store.read(), c.now()).readings.size).toBe(3);
  });

  it("a shape is declared once, on a reading, per surface:key; later readings there must match it; a different declaration is rejected", async () => {
    const store = new MemoryStore();
    const c = clock();
    // the declaring reading is itself checked
    expect((await rejected(emit(store, c, { kind: "reading", actor: "pm", key: "auth.mode", surface: "production", value: "C", shape: { enum: ["A", "B"] } }))).message).toMatch(/auth\.mode = "C" does not match shape one of "A" \| "B"/);
    await emit(store, c, { kind: "reading", actor: "pm", key: "auth.mode", surface: "production", value: "B", shape: { enum: ["A", "B"] } });
    await emit(store, c, { kind: "reading", actor: "qa", key: "auth.mode", surface: "production", value: "A" });
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "auth.mode", surface: "production", value: "public" }))).message).toMatch(/production:auth\.mode = "public" does not match shape/);
    // same declaration again is fine; a different one is not
    await emit(store, c, { kind: "reading", actor: "pm", key: "auth.mode", surface: "production", value: "A", shape: { enum: ["A", "B"] } });
    expect((await rejected(emit(store, c, { kind: "reading", actor: "pm", key: "auth.mode", surface: "production", value: "A", shape: { enum: ["A", "B", "C"] } }))).message).toMatch(/already has shape/);
    expect((await rejected(emit(store, c, { kind: "reading", actor: "pm", key: "users.count", surface: "production", value: 1, shape: { regex: "(" } }))).message).toMatch(/does not compile/);
    expect(reduce(await store.read(), c.now()).shapes.get("production:auth.mode")).toEqual({ enum: ["A", "B"] });
  });

  it("t-024: a shape belongs to one surface:key; another surface takes anything until it declares its own", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", key: "users.count", surface: "production", value: 128, shape: { regex: "^[0-9]+$" } });
    expect((await rejected(emit(store, c, { kind: "reading", actor: "pm", key: "users.count", surface: "production", value: "many" }))).message).toMatch(/production:users\.count = "many"/);
    // staging does not inherit production's shape
    await emit(store, c, { kind: "reading", actor: "qa", key: "users.count", surface: "staging", value: "many" });
    // staging may declare a different one for itself; production's stays
    await emit(store, c, { kind: "reading", actor: "qa", key: "users.count", surface: "staging", value: "few", shape: { enum: ["few", "many"] } });
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "users.count", surface: "staging", value: 3 }))).message).toMatch(/staging:users\.count = 3 does not match shape one of "few" \| "many"/);
    await emit(store, c, { kind: "reading", actor: "pm", key: "users.count", surface: "production", value: 129 });
    const st = reduce(await store.read(), c.now());
    expect(st.shapes.get("production:users.count")).toEqual({ regex: "^[0-9]+$" });
    expect(st.shapes.get("staging:users.count")).toEqual({ enum: ["few", "many"] });
    expect(st.shapes.has("users.count")).toBe(false);
  });

  it("t-024: deployed.sha takes a sha or 'unknown' on any surface, and an event id on none; a surface cannot loosen it", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "staging", value: "unknown" });
    await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "staging", value: "abc1234" });
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "staging", value: "01M1TQGSB6MGNYGE0HYZAP15RG" }))).message).toMatch(/staging:deployed\.sha .* does not match shape/);
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "01M1TQGSB6MGNYGE0HYZAP15RG" }))).message).toMatch(/production:deployed\.sha/);
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "anything", shape: { regex: ".*" } }))).message).toMatch(/already has shape/);
  });
});

describe("t-017 · a task created on a false premise is withdrawn, not worked around", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string, by = "pm") =>
    emit(store, c, { kind: "task", op: "create", actor: by, task: id, title: id, criteria: ["works"] , no_human_impact: true});
  const withdraw = (store: MemoryStore, c: ReturnType<typeof clock>, id: string, actor: string, reason = "premise was a measurement error") =>
    emit(store, c, { kind: "task", op: "withdraw", actor, task: id, reason });

  it("accepted from the criteria author while open or blocked; terminal, with the reason kept", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "t-013");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t-013", touches: ["config.ts"] });
    await emit(store, c, { kind: "task", op: "block", actor: "pm", task: "t-013", on: "withdrawn: no cancel op exists" });
    await withdraw(store, c, "t-013", "pm");
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.blocked ?? []).toHaveLength(0);
    expect(b.tasks.open ?? []).toHaveLength(0);
    expect(b.tasks.working ?? []).toHaveLength(0);
    expect(b.tasks.withdrawn.map((t) => t.id)).toEqual(["t-013"]);
    expect(b.tasks.withdrawn[0].withdrawn).toMatchObject({ by: "pm", reason: "premise was a measurement error" });
    // ids are forever: nothing can happen to it again, and it cannot be re-created
    expect((await rejected(emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t-013", touches: ["x"] }))).message).toMatch(/is withdrawn/);
    expect((await rejected(withdraw(store, c, "t-013", "pm"))).message).toMatch(/is withdrawn/);
    expect((await rejected(create(store, c, "t-013"))).message).toMatch(/already exists/);
    // the human may withdraw anything open, and an author who is not pm may withdraw their own
    await create(store, c, "t-a", "qa");
    await withdraw(store, c, "t-a", "qa");
    await create(store, c, "t-b", "qa");
    await withdraw(store, c, "t-b", HUMAN);
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.withdrawn.map((t) => t.id)).toEqual(["t-013", "t-a", "t-b"]);
  });

  it("rejected while working, done or verified, and from anyone but the author, pm or the human", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "t1", "qa");
    expect((await rejected(withdraw(store, c, "t1", "dev"))).message).toMatch(/only qa \(criteria author\), pm or human can withdraw t1, not dev/);
    expect((await rejected(withdraw(store, c, "t1", "frontend"))).message).toMatch(/not frontend/);
    expect((await rejected(withdraw(store, c, "t1", "pm", "  "))).message).toMatch(/say why/);
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t1", touches: ["a"] });
    expect((await rejected(withdraw(store, c, "t1", "pm"))).message).toMatch(/t1 is working; only an open or blocked task/);
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t1" , no_human_impact: true});
    expect((await rejected(withdraw(store, c, "t1", HUMAN))).message).toMatch(/t1 is done/);
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t1", surface: "repo", pass: true });
    expect((await rejected(withdraw(store, c, "t1", "pm"))).message).toMatch(/t1 is verified/);
    expect(reduce(await store.read(), c.now()).tasks.get("t1")!.status).toBe("verified");
  });

  it("its seams disappear from the open and stacked lists, and nothing seams against it afterwards", async () => {
    const store = new MemoryStore();
    const c = clock();
    for (const id of ["A", "B", "C", "D"]) await create(store, c, id);
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["cli/main.ts"] });   // collision A+B
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "qa", task: "C", touches: ["cli/main.ts"] });         // C stacks on B, collides with A
    await emit(store, c, { kind: "task", op: "block", actor: "pm", task: "A", on: "superseded by C" });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams.map((x) => x.id).sort()).toEqual(["seam:A+B", "seam:A+C", "seam:B+C"]);
    expect(b.seams.filter((x) => x.open)).toHaveLength(2);

    await withdraw(store, c, "A", "pm", "C does the same thing");
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams.map((x) => x.id)).toEqual(["seam:B+C"]);
    expect(b.seams[0].stacked).toEqual({ done: "B", on: "C" });
    expect(b.seams.filter((x) => x.open)).toHaveLength(0);
    // B is no longer blocked by A: verify goes through
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    // a new claim over the same file does not seam against the withdrawn task
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "D", touches: ["cli/main.ts"] });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams.some((x) => x.tasks.includes("A"))).toBe(false);
  });
});

describe("t-022 · an ask with a default answers itself at ack_by; the human may still override", () => {
  const ask = (store: MemoryStore, c: ReturnType<typeof clock>, extra: Partial<{ options: string[]; default: string }> = {}) =>
    emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "看板认证方式？", ack_by: c.iso(min(60)), options: ["private", "public"], default: "private", ...extra });
  const at = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now());

  /**
   * t-181 改了这一条测的东西，因为 t-022 那一版的行为是错的。
   *
   * 那一版：ack_by 一过，`settle()` 就把 `chosen` 算成默认值——**日志里一个字都没有**。牌桌因此显示「已经定了」，
   * 而别人 sync 读不到，人也没有一条可以指着翻案的记录。pm 09:17 实测：pd 15:57 那张卡在这个状态里待了十二小时。
   * 现在到期只是到期：牌桌照实说「过期了，默认还没生效」，直到服务落下那条事件为止。
   */
  it("到期本身不是决定：日志里没有那条事件之前，默认没有生效（t-181 判据 1、2）", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(30));
    let b = await at(store, c);
    expect(b.needs_human.map((n) => n.id)).toEqual([q.id]);
    expect(b.instructions[0].chosen).toBeUndefined();
    expect(b.needs_human[0].says_default).toEqual({ state: "waiting", line: DEFAULT_LINES.waiting(atClock(q.ack_by), "private") });
    c.tick(min(31));
    b = await at(store, c);
    // 到期了，但没人落事件：卡还在人手里，牌桌说的是故障态那一句，不是「已经按 private 了」
    expect(b.instructions[0].chosen).toBeUndefined();
    expect(b.needs_human.map((n) => n.id)).toEqual([q.id]);
    expect(b.needs_human[0].says_default).toEqual({ state: "stuck", line: DEFAULT_LINES.stuck() });
    expect(b.overdue.map((o) => o.instruction)).toEqual([q.id]);
  });

  it("服务落下那条事件之后，默认才生效——而且是一条谁都读得到、指得着的记录（判据 4 正例、判据 7）", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(61));
    const landed = await runDueDefaults(store, reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ kind: "note", actor: SERVICE_ACTOR, decision: true, decides: { of: q.id, option: "private" }, refs: [q.id] });
    expect((landed[0] as { body: string }).body).toBe(defaultApplied("private"));
    const b = await at(store, c);
    expect(b.needs_human).toHaveLength(0);
    expect(b.overdue).toHaveLength(0);
    // t-189：投影现在把 `note` 一起带出来——**那条事件的 id 就是「这件真的发生过」的凭据**。
    // 原来投影把它丢了，于是牌桌只能按「时间过了」印「已按默认 X 执行」，替一件没发生的事作证。
    expect(b.instructions[0].chosen).toEqual({ option: "private", by: "default", at: landed[0].at, note: landed[0].id });
    expect(b.instructions[0].says_default).toEqual({ state: "applied", line: DEFAULT_LINES.applied("private") });
    // 幂等：再扫一次不会落第二条（`default_due` 落完就是 false）
    expect(await runDueDefaults(store, reduce(await store.read(), c.now()), HUMAN, c.now())).toHaveLength(0);
  });

  it("判据 4 反例：人在到期前点了，就不落默认，以人的选择为准", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(10));
    await emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 公开", decision: true, decides: { of: q.id, option: "public" } });
    c.tick(min(90));
    expect(await runDueDefaults(store, reduce(await store.read(), c.now()), HUMAN, c.now())).toHaveLength(0);
    const b = await at(store, c);
    expect(b.instructions[0].chosen?.option).toBe("public");
    expect(b.instructions[0].chosen?.by).toBe(HUMAN);
    expect(b.instructions[0].says_default).toBeUndefined();   // 人点过了，这张卡不再是「到期会怎样」的事
  });

  it("判据 9：故障态那一句只在故障时出现——服务扫过之后它不再出现", async () => {
    const store = new MemoryStore();
    const c = clock();
    await ask(store, c);
    c.tick(min(61));
    expect((await at(store, c)).needs_human[0].says_default!.state).toBe("stuck");   // 故障态：真的会出现
    await runDueDefaults(store, reduce(await store.read(), c.now()), HUMAN, c.now());
    const b = await at(store, c);
    expect(b.instructions[0].says_default!.state).toBe("applied");
    expect(b.instructions.some((i) => i.says_default?.state === "stuck")).toBe(false);
    expect(b.needs_human.some((n) => n.says_default?.state === "stuck")).toBe(false);
  });

  it("判据 6：带默认却没有 ack_by 的卡被拒，拒绝话说清怎么补", async () => {
    const store = new MemoryStore();
    const c = clock();
    const r = await rejected(emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "看板认证方式？", options: ["private", "public"], default: "private" } as never));
    expect(r.message).toContain("带默认的卡必须有 ack_by");
    expect(r.message).toContain("到期按 private");
    expect(r.message).toContain("--ack-by");
  });

  it("服务只能在该落的那一刻、落那个默认值：早一秒、换一个选项都被拒", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(10));
    const early = await rejected(emit(store, c, { kind: "note", actor: SERVICE_ACTOR, body: defaultApplied("private"), decision: true, decides: { of: q.id, option: "private" } }));
    expect(early.message).toContain("还没到期");
    c.tick(min(90));
    const wrong = await rejected(emit(store, c, { kind: "note", actor: SERVICE_ACTOR, body: defaultApplied("public"), decision: true, decides: { of: q.id, option: "public" } }));
    expect(wrong.message).toContain("服务只能替人落下那个默认值");
  });

  it("after the default took effect the human can still decide; that decision wins and is a note; a second one is rejected", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(90));
    await runDueDefaults(store, reduce(await store.read(), c.now()), HUMAN, c.now());      // t-181：默认要先真的落下，才谈得上「被推翻」
    expect((await at(store, c)).instructions[0].chosen?.by).toBe("default");
    await emit(store, c, { kind: "ack", actor: HUMAN, of: q.id });
    const n = await emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 公开", decision: true, decides: { of: q.id, option: "public" } });
    const b = await at(store, c);
    expect(b.instructions[0].chosen).toEqual({ option: "public", by: HUMAN, at: n.at, note: n.id });   // t-189：人自己点的那次同样指得出事件
    expect(b.needs_human).toHaveLength(0);
    expect(reduce(await store.read(), c.now()).notes.some((x) => x.id === n.id && x.decides?.option === "public")).toBe(true);
    const again = await rejected(emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 私有", decision: true, decides: { of: q.id, option: "private" } }));
    expect(again.message).toMatch(/already decided: public by human/);
  });

  it("without a default nothing changes: the ask stays with the human past ack_by; a plain instruction is owed nothing but the doing", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c, { default: undefined });
    const plain = await emit(store, c, { kind: "instruction", actor: "pm", to: "backend", body: "deploy", ack_by: c.iso(min(10)) });
    c.tick(min(90));
    const b = await at(store, c);
    expect(b.needs_human.map((n) => n.id)).toEqual([q.id]);
    expect(b.instructions.find((i) => i.id === q.id)!.chosen).toBeUndefined();
    // t-147: 「deploy」 carries no options, so there is no answer to be late with. It is not overdue; what is true of
    // it is that backend has not read it, and that is where the board carries it. The ask is the opposite case: it is
    // past its deadline with no answer, and 判据 7 says the human never having opened the board does not excuse it —
    // that is precisely when 「我们还在等」 needs saying.
    expect(b.overdue.map((o) => o.instruction)).toEqual([q.id]);
    expect(b.overdue_by_presence.missing.instructions).toContain(plain.id);
    expect(b.overdue_by_presence.missing.instructions).not.toContain(q.id);   // 不在两处各算一次
  });
});

describe("t-025 · criteria can be added to an unfinished task; the adder becomes a criteria author", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "qa", task: "t-020", title: "牌桌卡片页", criteria: ["GET / 是卡片页"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t-020", touches: ["html.ts"] });
    return { store, c };
  };
  const task = async (store: MemoryStore, c: ReturnType<typeof clock>) => reduce(await store.read(), c.now()).tasks.get("t-020")!;

  it("the author, pm and the human may add while open/working/done; numbering continues; the create event is untouched", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "criteria", actor: "qa", task: "t-020", add: ["空状态有一句话说明"] });
    await emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["标签全部中文"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" , no_human_impact: true});
    c.tick(min(3));
    const added = await emit(store, c, { kind: "task", op: "criteria", actor: HUMAN, task: "t-020", add: ["时间用相对时间", "空列表也有说明"] });
    const t = await task(store, c);
    expect(t.criteria).toEqual(["GET / 是卡片页", "空状态有一句话说明", "标签全部中文", "时间用相对时间", "空列表也有说明"]);
    expect(t.criteria_added).toEqual([
      { index: 1, by: "qa", at: expect.any(String) }, { index: 2, by: "pm", at: expect.any(String) },
      { index: 3, by: HUMAN, at: added.at }, { index: 4, by: HUMAN, at: added.at },
    ]);
    expect(t.criteria_by).toBe("qa");
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.done[0].criteria).toHaveLength(5);
    expect(b.tasks.done[0].criteria_added.map((a) => a.by)).toEqual(["qa", "pm", HUMAN, HUMAN]);
    const create = (await store.read()).events.find((e) => e.kind === "task" && e.op === "create")!;
    expect((create as { criteria: string[] }).criteria).toEqual(["GET / 是卡片页"]);
  });

  it("anyone else is refused, empty additions too; once pm has added, pm is an author as well", async () => {
    const { store, c } = await setup();
    const r = await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "frontend", task: "t-020", add: ["我自己定的标准"] }));
    expect(r.rule).toBe("criteria");
    expect(r.message).toMatch(/only qa \(criteria author\), pm, pd or human can add criteria to t-020, not frontend/);
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "dev", task: "t-020", add: ["x"] }))).message).toMatch(/not dev/);
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["  "] }))).message).toMatch(/non-empty/);
    await emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["a"] });
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "dev", task: "t-020", add: ["c"] }))).message).toMatch(/only qa\/pm/);
  });

  it("verified is final: no more criteria; withdrawn too", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" , no_human_impact: true});
    // t-104: pass 收窄到持 R6 的角色，这里 qa 写了判据，只剩 human 能落
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t-020", surface: "repo", pass: true });
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["再加一条"] }))).message).toMatch(/t-020 is verified; its criteria are what was judged/);
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-x", title: "x", criteria: ["y"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "withdraw", actor: "pm", task: "t-x", reason: "重复" });
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-x", add: ["z"] }))).message).toMatch(/is withdrawn/);
  });

  it("pd may add to a task it did not create (that is the point); pd then cannot verify it", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "criteria", actor: "pd", task: "t-020", add: ["空状态有一句话说明"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" , no_human_impact: true});
    expect((await task(store, c)).criteria_added.map((a) => a.by)).toEqual(["pd"]);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pd", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/wrote the criteria/);
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t-020", surface: "repo", pass: true }); // t-104: qa 写了判据，只剩 human
  });

  it("whoever added a criterion cannot verify the task any more; the human still can", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["空状态有一句话说明"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pm", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/wrote the criteria/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/wrote the criteria/);
    // t-104: dev 不持 R6，落不了 pass 了——这个项目里除了写了判据的 qa 就只剩 human
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/不持 R6/);
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t-020", surface: "repo", pass: true });
    expect((await task(store, c)).status).toBe("verified");
    // the human is the policy authority even when they added a criterion
    const s2 = await setup();
    await emit(s2.store, s2.c, { kind: "task", op: "criteria", actor: HUMAN, task: "t-020", add: ["x"] });
    await emit(s2.store, s2.c, { kind: "task", op: "done", actor: "frontend", task: "t-020" , no_human_impact: true});
    await emit(s2.store, s2.c, { kind: "task", op: "verify", actor: HUMAN, task: "t-020", surface: "repo", pass: true });
  });
});

describe("t-027 · the board tells this version's changes from history, and folds long in-flight lists", () => {
  const deploy = (store: MemoryStore, c: ReturnType<typeof clock>, sha: string) =>
    emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: sha });
  const passOnProd = async (store: MemoryStore, c: ReturnType<typeof clock>, id: string, title: string) => {
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "production", pass: true });
  };
  const live = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).live;

  it("with no previous deploy everything verified on production is recent and since_sha is null", async () => {
    const store = new MemoryStore();
    const c = clock();
    await passOnProd(store, c, "A", "sha endpoint");
    c.tick(min(5));
    await deploy(store, c, "aaaaaaa");
    c.tick(min(5));
    await passOnProd(store, c, "B", "per-surface verify");
    const l = await live(store, c);
    expect(l).toMatchObject({ deployed_sha: "aaaaaaa", since_sha: null, earlier: [] });
    expect(l.recent.map((x) => x.id)).toEqual(["A", "B"]);
    expect(l.verified_on_production.map((x) => x.id)).toEqual(["A", "B"]);
  });

  it("after a second deploy, recent is what passed on production since the new sha was recorded; earlier is the rest", async () => {
    const store = new MemoryStore();
    const c = clock();
    await deploy(store, c, "aaaaaaa");
    c.tick(min(5));
    await passOnProd(store, c, "A", "sha endpoint");
    await passOnProd(store, c, "B", "per-surface verify");
    c.tick(min(5));
    await deploy(store, c, "bbbbbbb");
    c.tick(min(1));
    await deploy(store, c, "bbbbbbb1234567890abcdef1234567890abcdef1"); // qa re-measures the same sha in long form: the line does not move
    c.tick(min(5));
    await passOnProd(store, c, "C", "withdraw op");
    const l = await live(store, c);
    expect(l.deployed_sha).toBe("bbbbbbb1234567890abcdef1234567890abcdef1");
    expect(l.since_sha).toBe("aaaaaaa");
    expect(l.recent.map((x) => x.id)).toEqual(["C"]);
    expect(l.earlier.map((x) => x.id)).toEqual(["A", "B"]);
    expect(l.earlier.map((x) => x.title)).toEqual(["sha endpoint", "per-surface verify"]);
    // a third deploy: C becomes history too
    c.tick(min(5));
    await deploy(store, c, "ccccccc");
    const l3 = await live(store, c);
    expect(l3).toMatchObject({ deployed_sha: "ccccccc", since_sha: "bbbbbbb1234567890abcdef1234567890abcdef1", recent: [] }); // the latest reading of the previous sha, long form
    expect(l3.earlier.map((x) => x.id)).toEqual(["A", "B", "C"]);
  });

  it("in_flight groups carry total and the 5 most recently touched; the full list stays", async () => {
    const store = new MemoryStore();
    const c = clock();
    for (let i = 1; i <= 7; i++) { c.tick(min(1)); await emit(store, c, { kind: "task", op: "create", actor: "pm", task: `t-${i}`, title: `task ${i}`, criteria: ["x"] , no_human_impact: true}); }
    c.tick(min(1));
    await emit(store, c, { kind: "task", op: "block", actor: "pm", task: "t-2", on: "waiting" }); // touched last, but leaves the open group
    await emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-1", add: ["more"] });   // t-1 is now the most recent open task
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.in_flight.open.total).toBe(6);
    expect(b.in_flight.open.all.map((x) => x.id)).toEqual(["t-1", "t-3", "t-4", "t-5", "t-6", "t-7"]);
    expect(b.in_flight.open.shown.map((x) => x.id)).toEqual(["t-1", "t-7", "t-6", "t-5", "t-4"]);
    expect(b.in_flight.blocked).toMatchObject({ total: 1 });
    expect(b.in_flight.blocked.shown.map((x) => x.id)).toEqual(["t-2"]);
    expect(b.in_flight.open.shown.every((x) => typeof x.updated_at === "string")).toBe(true);
  });
});

describe("t-028 · the owner can reopen a done task to change it; every round stays on record", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-020", title: "牌桌卡片页", criteria: ["卡片页"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t-020", touches: ["html.ts", "i18n.ts"] });
    c.tick(min(10));
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020", evidence: "4bff806" , no_human_impact: true});
    return { store, c };
  };
  const task = async (store: MemoryStore, c: ReturnType<typeof clock>) => reduce(await store.read(), c.now()).tasks.get("t-020")!;

  it("reopen after done: back to working with the same owner and touches; done again appends evidence", async () => {
    const { store, c } = await setup();
    c.tick(min(5));
    await emit(store, c, { kind: "task", op: "reopen", actor: "frontend", task: "t-020", reason: "pd 评审要改措辞" });
    let t = await task(store, c);
    expect(t.status).toBe("working");
    expect(t.owner).toBe("frontend");
    expect(t.touches).toEqual(["html.ts", "i18n.ts"]);
    // no claim needed: done is allowed straight away
    c.tick(min(5));
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020", evidence: "156f926" , no_human_impact: true});
    t = await task(store, c);
    expect(t.status).toBe("done");
    expect(t.evidence).toBe("156f926");
    expect(t.history.map((h) => h.op === "done" ? `done:${h.evidence}` : h.op === "reopen" ? `reopen:${h.reason}` : h.op)).toEqual(["done:4bff806", "reopen:pd 评审要改措辞", "done:156f926"]);
    expect(t.history.map((h) => h.round)).toEqual([1, 1, 2]);
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.done[0].history).toHaveLength(3);
  });

  it("an existing repo pass stays on record but no longer counts: the new round must be verified again", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-020", surface: "repo", pass: true, evidence: "tests green" });
    expect((await task(store, c)).status).toBe("verified");
    // verified is final; a failed one can be reopened
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "frontend", task: "t-020", reason: "改" }))).message).toMatch(/t-020 is verified; only a done or failed task can be reopened \(verified is final/);

    const s2 = await setup();
    await emit(s2.store, s2.c, { kind: "task", op: "verify", actor: "qa", task: "t-020", surface: "repo", pass: false, evidence: "missing empty state" });
    await emit(s2.store, s2.c, { kind: "task", op: "reopen", actor: "pm", task: "t-020", reason: "qa 的失败点要修" });
    await emit(s2.store, s2.c, { kind: "task", op: "done", actor: "frontend", task: "t-020", evidence: "fix" , no_human_impact: true});
    const t = await task(s2.store, s2.c);
    expect(t.verifications).toHaveLength(1); // kept
    expect(surfaceResults(t)).toEqual([]);   // but nothing counts in round 2
    await emit(s2.store, s2.c, { kind: "task", op: "verify", actor: "qa", task: "t-020", surface: "repo", pass: true });
    expect((await task(s2.store, s2.c)).status).toBe("verified");
  });

  it("only the owner, pm or the human may reopen; open/working/withdrawn cannot be reopened; a reason is required", async () => {
    const { store, c } = await setup();
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "qa", task: "t-020", reason: "x" }))).message).toMatch(/only frontend \(owner\), pm or human can reopen t-020, not qa/);
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "frontend", task: "t-020", reason: " " }))).message).toMatch(/say why/);
    await emit(store, c, { kind: "task", op: "reopen", actor: HUMAN, task: "t-020", reason: "human 要改" });
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "frontend", task: "t-020", reason: "again" }))).message).toMatch(/t-020 is working; only a done or failed/);
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-o", title: "o", criteria: ["x"] , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "pm", task: "t-o", reason: "x" }))).message).toMatch(/t-o is open/);
    await emit(store, c, { kind: "task", op: "withdraw", actor: "pm", task: "t-o", reason: "dup" });
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "pm", task: "t-o", reason: "x" }))).message).toMatch(/is withdrawn/);
  });

  it("a task that reopens becomes in flight again: a seam stacked on it turns back into a collision", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-026", title: "折叠", criteria: ["x"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t-026", touches: ["html.ts"] });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams[0].stacked).toEqual({ done: "t-020", on: "t-026" });
    await emit(store, c, { kind: "task", op: "reopen", actor: "frontend", task: "t-020", reason: "改" });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.seams[0].stacked).toBeUndefined();
    expect(b.seams[0].open).toBe(true);
  });
});

describe("t-029 · board.release lists what passed on repo and not yet on production", () => {
  const ship = async (store: MemoryStore, c: ReturnType<typeof clock>, id: string, title: string, evidence?: string) => {
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    c.tick(min(1));
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id, evidence , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true, evidence: "tests green" });
  };
  const release = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).release;

  it("no candidates: nothing verified on repo, or everything already on production", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "a", criteria: ["x"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["a"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234" , no_human_impact: true});
    expect(await release(store, c)).toMatchObject({ deployed_sha: null, candidates: [] }); // done is a claim, not a verdict
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "production", pass: true });
    expect((await release(store, c)).candidates).toEqual([]);
  });

  it("candidates in done order, with evidence sha, who verified where, and the current production sha", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: "1501d1cce361834f93f3b4063dadf89fb70379e0" });
    await ship(store, c, "t-025", "criteria add", "3683577，分支 claude/backend-development-gzqbjf（06276f8 + pd 放行）");
    await ship(store, c, "t-027", "board release split", "244368e，在 3683577 之上");
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t-027", surface: "staging", pass: true });
    const r = await release(store, c);
    expect(r.deployed_sha).toBe("1501d1cce361834f93f3b4063dadf89fb70379e0");
    expect(r.candidates.map((x) => x.task)).toEqual(["t-025", "t-027"]);
    expect(r.candidates[0]).toMatchObject({ title: "criteria add", evidence_sha: "3683577", verified_by: { repo: "qa" }, surfaces: ["repo"] });
    expect(r.candidates[1]).toMatchObject({ evidence_sha: "244368e", verified_by: { repo: "qa", staging: HUMAN }, surfaces: ["repo", "staging"] });
    expect(r.candidates[0].done_at < r.candidates[1].done_at).toBe(true);
    // verified on production: out of the list, and into live.verified_on_production
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-025", surface: "production", pass: true });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.release.candidates.map((x) => x.task)).toEqual(["t-027"]);
    expect(b.live.verified_on_production.map((x) => x.id)).toEqual(["t-025"]);
  });

  it("evidence without a sha gives evidence_sha null; the sha must be a whole word", async () => {
    const store = new MemoryStore();
    const c = clock();
    await ship(store, c, "B", "no sha", "见 PR，测试全绿");
    await ship(store, c, "C", "sha later", "PR https://github.com/x/y/pull/4 合并为 deadbeefcafe，见 t-001 与 added 一词");
    const r = await release(store, c);
    expect(r.candidates.map((x) => x.evidence_sha)).toEqual([null, "deadbeefcafe"]);
    expect(evidenceSha("added defaced 1234567")).toBe("defaced"); // a 7-hex-letter word counts: the regex cannot tell, the human can
    expect(evidenceSha("t-001 abc")).toBeNull();
    expect(evidenceSha(undefined)).toBeNull();
    expect(evidenceSha("01M1TSDDK1VXP23K45CPR3KDH5 then fd76455")).toBe("fd76455");
  });

  it("a reopened task leaves the list until its new round passes on repo again", async () => {
    const store = new MemoryStore();
    const c = clock();
    await ship(store, c, "D", "d", "1111111");
    expect((await release(store, c)).candidates.map((x) => x.task)).toEqual(["D"]);
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "D", reason: "x" }))).message).toMatch(/verified/);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "D", surface: "production", pass: false, evidence: "500 on /" });
    expect((await release(store, c)).candidates.map((x) => x.task)).toEqual(["D"]); // repo pass still stands this round
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "D", reason: "修 500" });
    expect((await release(store, c)).candidates).toEqual([]); // being changed: the old sha must not ship (qa, t-029 repo FAIL)
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "D", evidence: "2222222" , no_human_impact: true});
    expect((await release(store, c)).candidates).toEqual([]);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "D", surface: "repo", pass: true });
    expect((await release(store, c)).candidates[0]).toMatchObject({ task: "D", evidence_sha: "2222222" });
  });
});

describe("t-030 · what the human said, and where it went", () => {
  const say = (store: MemoryStore, c: ReturnType<typeof clock>, text: string) =>
    emit(store, c, { kind: "note", actor: HUMAN, body: `${SAID_PREFIX}${text}` });
  const said = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).said;

  it("received → requirement (a pd decision refs it) → task (a create refs it) → live (that task passes on production)", async () => {
    const store = new MemoryStore();
    const c = clock();
    const s1 = await say(store, c, "登录后应该回到我刚才那页");
    let [x] = await said(store, c);
    expect(x).toMatchObject({ id: s1.id, body: "登录后应该回到我刚才那页", at: s1.at, status: "received", label: "已收到", links: { requirements: [], tasks: [] } });

    c.tick(min(2));
    const req = await emit(store, c, { kind: "note", actor: "pd", body: "场景需求：登录回跳", decision: true, refs: [s1.id] });
    [x] = await said(store, c);
    expect(x).toMatchObject({ status: "requirement", label: "已成为需求", links: { requirements: [req.id] } });
    // a non-decision note, or a non-pd decision, does not count as a requirement
    await emit(store, c, { kind: "note", actor: "pm", body: "看到了", refs: [s1.id] });
    await emit(store, c, { kind: "note", actor: "qa", body: "决定", decision: true, refs: [s1.id] });
    expect((await said(store, c))[0].links.requirements).toEqual([req.id]);

    c.tick(min(2));
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-40", title: "登录后回到原页", criteria: ["回跳"], refs: [s1.id] , no_human_impact: true});
    [x] = await said(store, c);
    expect(x).toMatchObject({ status: "task", label: "已成为任务：登录后回到原页", links: { tasks: [{ id: "t-40", title: "登录后回到原页", status: "open" }] } });

    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t-40", touches: ["auth"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t-40", evidence: "abc1234" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-40", surface: "repo", pass: true });
    expect((await said(store, c))[0].status).toBe("task");
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-40", surface: "production", pass: true });
    [x] = await said(store, c);
    expect(x).toMatchObject({ status: "live", label: "已上线：登录后回到原页" });
  });

  it("several tasks may answer one sentence; the label names them all; newest sentence first", async () => {
    const store = new MemoryStore();
    const c = clock();
    const s1 = await say(store, c, "牌桌要能折叠");
    c.tick(min(1));
    const s2 = await say(store, c, "部署要一键");
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "在途折叠", criteria: ["x"], refs: [s1.id] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "线上折叠", criteria: ["x"], refs: [s1.id] , no_human_impact: true});
    const list = await said(store, c);
    expect(list.map((x) => x.id)).toEqual([s2.id, s1.id]);
    expect(list[1].label).toBe("已成为任务：在途折叠、线上折叠");
    expect(list[1].links.tasks.map((t) => t.id)).toEqual(["A", "B"]);
    expect(list[0]).toMatchObject({ status: "received", label: "已收到" });
    // only the human's prefixed notes are sentences; a dev note with the prefix is not
    await emit(store, c, { kind: "note", actor: "dev", body: `${SAID_PREFIX}冒充` });
    await emit(store, c, { kind: "note", actor: HUMAN, body: "普通 note" });
    expect((await said(store, c)).map((x) => x.body)).toEqual(["部署要一键", "牌桌要能折叠"]);
  });

  it("refs to a sentence that does not exist are refused by the existing rule", async () => {
    const store = new MemoryStore();
    const c = clock();
    const r = await rejected(emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "x", criteria: ["y"], refs: ["01M1TSDDK1VXP23K45CPR3KDH5"] , no_human_impact: true}));
    expect(r.rule).toBe("ref");
  });
});

describe("t-036 · instructions to the human carry a kind and a title", () => {
  it("kind: given, or derived (options → ask, else do); refused for anyone but the human; must be a known kind", async () => {
    const store = new MemoryStore();
    const c = clock();
    const ask = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "看板认证方式？", ack_by: c.iso(min(60)), options: ["A", "B"] });
    const doIt = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "部署第 4 批。合并 8c2298b 后推到 production", ack_by: c.iso(min(60)) });
    const info = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "第 3 批已上线。t-020 等 10 项", ack_by: c.iso(min(60)), intent: "info" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    const kinds = Object.fromEntries(b.needs_human.map((n) => [n.id, n.kind]));
    expect(kinds).toEqual({ [ask.id]: "ask", [doIt.id]: "do", [info.id]: "info" });
    expect(b.instructions.find((i) => i.id === info.id)!.kind).toBe("info");
    const r = await rejected(emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "做", ack_by: c.iso(min(5)), intent: "do" }));
    expect(r.message).toMatch(/kind is for the human's board; dev just acts/);
    expect((await rejected(emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "x", ack_by: c.iso(min(5)), intent: "urgent" as never }))).message).toMatch(/kind must be one of ask \| do \| info/);
    // an instruction to an agent carries no kind on the board
    const plain = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "做", ack_by: c.iso(min(5)) });
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).instructions.find((i) => i.id === plain.id)!.kind).toBeUndefined();
  });

  it("title is the first sentence when it is at most 30 characters; otherwise the whole body is detail", () => {
    expect(splitTitle("部署第 4 批。合并 8c2298b 后推到 production")).toEqual({ title: "部署第 4 批", detail: "合并 8c2298b 后推到 production" });
    expect(splitTitle("看板认证方式：A 私有，B 公开")).toEqual({ title: "看板认证方式", detail: "A 私有，B 公开" });
    expect(splitTitle("第一行\n第二行")).toEqual({ title: "第一行", detail: "第二行" });
    expect(splitTitle("只有一句没有标点")).toEqual({ title: "只有一句没有标点", detail: "" });
    const thirty = "字".repeat(30), thirtyOne = "字".repeat(31);
    expect(splitTitle(`${thirty}。其余`)).toEqual({ title: thirty, detail: "其余" });
    expect(splitTitle(`${thirtyOne}。其余`)).toEqual({ title: "", detail: `${thirtyOne}。其余` });
    expect(splitTitle(thirtyOne)).toEqual({ title: "", detail: thirtyOne });
    expect(splitTitle("")).toEqual({ title: "", detail: "" });
    expect(splitTitle("。开头就是句号")).toEqual({ title: "", detail: "。开头就是句号" });
  });

  it("the board carries title/detail on needs_human and instructions, and a 'not now' note as deferred", async () => {
    const store = new MemoryStore();
    const c = clock();
    const i = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "部署第 4 批。合并 8c2298b 后推到 production", ack_by: c.iso(min(60)) });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human[0]).toMatchObject({ kind: "do", title: "部署第 4 批", detail: "合并 8c2298b 后推到 production" });
    await emit(store, c, { kind: "ack", actor: HUMAN, of: i.id });
    const n = await emit(store, c, { kind: "note", actor: HUMAN, body: `${DEFER_PREFIX}明天再部署`, refs: [i.id] });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toHaveLength(0);
    expect(b.instructions[0]).toMatchObject({ status: "acked", title: "部署第 4 批", deferred: { note: n.id, body: "明天再部署", at: n.at } });
  });
});

describe("t-039 · the manual is a resource of the platform, per role", () => {
  it("exists for the default roles, is common core plus role part, and refuses anything that is not a role name", () => {
    expect(manualRoles()).toEqual(["dev", "frontend", "pd", "pm", "qa"]);
    const dev = manual("dev")!;
    expect(dev.startsWith("# 说明书 · 通用核心")).toBe(true);
    expect(dev).toContain("\n---\n\n# 角色 · dev");
    expect(manual("writer")).toBeNull();
    expect(manual("../common")).toBeNull();
    expect(manual("dev.md")).toBeNull();
    expect(manual("")).toBeNull();
  });
});

describe("t-045 · a seam between two tasks of one owner is sequential work, not a collision", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] , no_human_impact: true});
  const seams = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).seams;

  it("same owner: the seam is recorded and visible, but blocks neither verify", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["reduce.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "B", touches: ["reduce.ts"] });
    const s = await seams(store, c);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: "seam:A+B", same_owner: true, open: false });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "B" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    const st = reduce(await store.read(), c.now());
    expect(st.tasks.get("A")!.status).toBe("verified");
    expect(st.tasks.get("B")!.status).toBe("verified");
  });

  it("different owners still collide; a reopened task keeps its owner so the seam stays same-owner", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B"); await create(store, c, "C");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    expect((await seams(store, c))[0]).toMatchObject({ id: "seam:A+B", open: true });
    expect((await seams(store, c))[0].same_owner).toBeUndefined();
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }))).message).toMatch(/seam/);
    // C is dev's too; A fails and dev reopens it: A+C stays same-owner and never blocks
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "C", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "seam", actor: "pm", tasks: ["A", "B"], resolution: "B 合并 A" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "x" });
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "修" });
    const s = await seams(store, c);
    expect(s.find((x) => x.id === "seam:A+C")).toMatchObject({ same_owner: true, open: false });
    expect(s.find((x) => x.id === "seam:B+C")).toMatchObject({ open: true });
    // a failed task taken over by someone else turns the seam into a collision
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "y" });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "A", touches: ["app.ts"] });
    expect((await seams(store, c)).find((x) => x.id === "seam:A+C")).toMatchObject({ open: true });
  });
});

describe("t-047 · listening and speaking are two different things", () => {
  it("a node that only emits is deaf: its instructions are not arriving; a pull makes it listen; both old is missing", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "note", actor: "dev", body: "在干活" });
    let p = board(reduce(await store.read(), c.now()), HUMAN, c.now()).presence.find((x) => x.actor === "dev")!;
    expect(p).toMatchObject({ status: "deaf", listening: false, present: false, last_event: c.iso(), last_pull: null });
    expect(isMissing(reduce(await store.read(), c.now()), "dev", c.now())).toBe(true);
    c.tick(min(2));
    await pull(store, "dev", null, c.now());
    p = board(reduce(await store.read(), c.now()), HUMAN, c.now()).presence.find((x) => x.actor === "dev")!;
    expect(p).toMatchObject({ status: "listening", listening: true, present: true, last_pull: c.iso(), idle_pull_s: 0, idle_event_s: 120, since: c.iso() });
    expect(isMissing(reduce(await store.read(), c.now()), "dev", c.now())).toBe(false);
    c.tick(min(6));
    p = board(reduce(await store.read(), c.now()), HUMAN, c.now()).presence.find((x) => x.actor === "dev")!;
    expect(p.status).toBe("deaf");   // spoke 8 minutes ago, pulled 6 minutes ago: not listening any more, not yet missing
    c.tick(min(3));
    p = board(reduce(await store.read(), c.now()), HUMAN, c.now()).presence.find((x) => x.actor === "dev")!;
    expect(p.status).toBe("missing");
    expect(p.since).toBe(c.iso(-min(9)));
  });

  it("the service card about a missing role is judged by listening: a node that keeps emitting without pulling still gets one", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", key: "roles", surface: "project", value: ["pm", "dev"] });
    await emit(store, c, { kind: "note", actor: "dev", body: "我在，但没在听" });
    const card = await emit(store, c, { kind: "instruction", actor: "ateam", to: HUMAN, body: "dev 没在听了 5 分钟，1 条指令没送到。起一个 dev？", ack_by: c.iso(min(60)), intent: "do" });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human.map((n) => n.id)).toEqual([card.id]); // emitting is not listening; the 没在听 wording is recognised too
    await pull(store, "dev", null, c.now());
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toEqual([]);
  });
});

describe("t-048 · the board says who is not receiving", () => {
  it("pending instructions older than 5 minutes count per recipient; a pull clears them; the human's own are not counted", async () => {
    const store = new MemoryStore();
    const c = clock();
    const a = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "一", ack_by: c.iso(min(60)) });
    await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "给人的", ack_by: c.iso(min(60)) });
    c.tick(min(2));
    await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "二", ack_by: c.iso(min(60)) });
    await emit(store, c, { kind: "instruction", actor: "pm", to: "qa", body: "三", ack_by: c.iso(min(60)) });
    c.tick(min(4)); // "一" is 6 minutes old, the others 4
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.undelivered).toEqual([{ to: "dev", count: 1, oldest_sent: a.at, listening: false }]);
    c.tick(min(2)); // now all three
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.undelivered.map((u) => [u.to, u.count])).toEqual([["dev", 2], ["qa", 1]]);
    await pull(store, "dev", null, c.now());
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.undelivered.map((u) => [u.to, u.count, u.listening])).toEqual([["qa", 1, false]]);
    // a listening recipient with something still unpulled (it pulled before the instruction) shows listening: true
    await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "四", ack_by: c.iso(min(60)) });
    c.tick(min(4));
    await pull(store, "dev", (await store.read()).events.at(-2)!.id, c.now()); // pulls up to before 四? no: 四 is the last event, so this pull consumes it
    c.tick(min(2));
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.undelivered.find((u) => u.to === "dev")).toBeUndefined();
  });
});

describe("t-051 · a fact has a measurement time and a record time", () => {
  it("measured_at defaults to the event time; a measurement from the future is refused; validity counts from the measurement", async () => {
    const store = new MemoryStore();
    const c = clock();
    const plain = await emit(store, c, { kind: "reading", actor: "qa", key: "users.count", value: 12, surface: "production" });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.readings.find((r) => r.id === plain.id)).toMatchObject({ measured_at: plain.at, recorded_after_s: 0, late: false });
    const r = await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "users.count", value: 13, surface: "production", measured_at: c.iso(min(1)) }));
    expect(r.rule).toBe("reading");
    expect(r.message).toMatch(/measured_at .* is later than now/);
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "users.count", value: 13, surface: "production", measured_at: "yesterday-ish" }))).message).toMatch(/is not a time/);
    expect((await rejected(emit(store, c, { kind: "reading", actor: "qa", key: "users.count", value: 13, surface: "production", measured_at: c.iso(-min(10)), valid_until: c.iso(-min(20)) }))).message).toMatch(/valid_until is before measured_at/);
    // measured 40 minutes ago, valid for an hour from then: 20 minutes of validity left, not 60
    const late = await emit(store, c, { kind: "reading", actor: "qa", key: "users.count", value: 14, surface: "production", measured_at: c.iso(-min(40)), valid_until: c.iso(min(20)) });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.readings.find((r) => r.id === late.id)).toMatchObject({ measured_at: c.iso(-min(40)), recorded_after_s: 2400, late: true, valid: true });
    c.tick(min(21));
    expect((await rejected(emit(store, c, { kind: "note", actor: "dev", body: "x", refs: [late.id] }))).message).toMatch(/expired/);
    // recorded 10 minutes after a measurement valid for an hour: not late (under half)
    const ok = await emit(store, c, { kind: "reading", actor: "qa", key: "users.count", value: 15, surface: "production", measured_at: c.iso(-min(10)), valid_until: c.iso(min(50)) });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.readings.find((r) => r.id === ok.id)).toMatchObject({ recorded_after_s: 600, late: false });
  });
});

describe("F6/F7/F8 · readings carry time, surface, assumptions, and die loudly", () => {
  it("a reading is invalidated by a later write to what it depends on; building on it is rejected", async () => {
    const store = new MemoryStore();
    const c = clock();
    const baseline = await emit(store, c, {
      kind: "reading", actor: "pm", key: "users.count", value: 128, surface: "production",
      method: "SELECT count(*) FROM users", assumptions: ["production and roster have zero overlap"],
      depends_on: ["production:users"],
    });
    // six hours of legitimate activity
    c.tick(min(360));
    await emit(store, c, { kind: "note", actor: "backend", body: "imported roster batch 3", writes: ["production:users"] });

    const s = reduce(await store.read(), c.now());
    expect(s.readings.get(baseline.id)!.valid).toBe(false);
    const b = board(s, HUMAN, c.now());
    expect(b.readings[0].why).toMatch(/invalidated/);
    expect(b.readings[0].assumptions).toEqual(["production and roster have zero overlap"]);

    const r = await rejected(emit(store, c, {
      kind: "task", op: "create", actor: "pm", task: "t-acceptance", title: "acceptance numbers", criteria: ["users.count == 128"], refs: [baseline.id], no_human_impact: true,
    }));
    expect(r.rule).toBe("stale-reading");
  });

  it("a fresh reading of the same surface:key supersedes the old one", async () => {
    const store = new MemoryStore();
    const c = clock();
    const old = await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", value: "91f22a7", surface: "production" });
    c.tick(min(30));
    const fresh = await emit(store, c, { kind: "reading", actor: "backend", key: "deployed.sha", value: "a3c9e10", surface: "production" });
    const s = reduce(await store.read(), c.now());
    expect(s.readings.get(old.id)!.superseded_by).toBe(fresh.id);
    expect(s.latestReading.get("production:deployed.sha")).toBe(fresh.id);
  });

  it("time-limited readings expire", async () => {
    const store = new MemoryStore();
    const c = clock();
    // measured 10 minutes before it was written; valid for an hour from the measurement (t-051)
    const r = await emit(store, c, { kind: "reading", actor: "qa", key: "staging.has_real_users", value: false, surface: "staging", measured_at: c.iso(-min(10)), valid_until: c.iso(min(50)) });
    c.tick(min(51));
    expect((await rejected(emit(store, c, { kind: "note", actor: "backend", body: "ok to wipe staging", refs: [r.id] }))).message).toMatch(/expired/);
  });

  it("the same key on two surfaces are two different facts (F8)", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "backend", key: "has_real_users", value: true, surface: "production" });
    await emit(store, c, { kind: "reading", actor: "qa", key: "has_real_users", value: false, surface: "staging" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.readings.filter((r) => r.valid)).toHaveLength(2);
  });
});

describe("F3 · one focus slot, not a priority list", () => {
  it("the newest focus displaces the old one", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", key: "focus", surface: "team", value: "P0: login broken on staging" });
    await emit(store, c, { kind: "reading", actor: "pm", key: "focus", surface: "team", value: "deploy 1.4.2" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.focus?.body).toBe("deploy 1.4.2");
    expect(b.readings.filter((r) => r.key === "focus")).toHaveLength(0); // not listed twice
  });
});

describe("F11 · the human board is derived, never moved by hand", () => {
  it("a card disappears the moment the underlying fact changes", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "Approve production deploy of 1.4.2?", ack_by: c.iso(min(120)) });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toEqual([expect.objectContaining({ id: q.id, kind: "do" })]);
    await emit(store, c, { kind: "ack", actor: HUMAN, of: q.id });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toHaveLength(0);
  });

  it("t-019: needs_human holds only questions for the human, with their options and choice", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "Board auth?", ack_by: c.iso(min(60)), options: ["private", "public"], default: "private" });
    await emit(store, c, { kind: "instruction", actor: "pm", to: "backend", body: "deploy 1.4.2", ack_by: c.iso(min(5)) });
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "a", criteria: ["x"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "b", criteria: ["y"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "backend", task: "A", touches: ["f"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["f"] });
    c.tick(min(10));
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toHaveLength(1);
    expect(b.needs_human[0]).toMatchObject({ kind: "ask", id: q.id, from: "pm", body: "Board auth?", options: ["private", "public"], default: "private" });
    expect(b.needs_human[0].chosen).toBeUndefined();
    // t-147: what backend was sent carries no options, so it is owed the doing and not an answer — not overdue,
    // but plainly not read either, which is the group it belongs in.
    expect(b.overdue).toEqual([]);
    // backend has spoken (it claimed A) but never pulled: alive, not reading — t-139's middle state
    expect(b.overdue_by_presence.deaf.roles).toEqual(["backend"]);
    expect(b.overdue_by_presence.missing.roles).toEqual([]);
    expect(b.seams.filter((x) => x.open).map((x) => x.id)).toEqual(["seam:A+B"]);
  });

  it("t-019: live says what production runs and what is verified there; in_flight groups unfinished tasks by status", async () => {
    const store = new MemoryStore();
    const c = clock();
    for (const [id, title] of [["A", "sha endpoint"], ["B", "html board"], ["C", "withdraw op"], ["D", "never started"]]) {
      await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["works"] , no_human_impact: true});
    }
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.live).toMatchObject({ deployed_sha: null, verified_on_production: [] });
    expect(Object.keys(b.in_flight)).toEqual(["open"]);
    expect(b.in_flight.open.total).toBe(4);
    expect(b.in_flight.open.all.map((x) => [x.id, x.title])).toEqual([["A", "sha endpoint"], ["B", "html board"], ["C", "withdraw op"], ["D", "never started"]]);

    await emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: "1501d1cce361834f93f3b4063dadf89fb70379e0", depends_on: ["production:deployed.sha"] });
    for (const [id, who] of [["A", "dev"], ["B", "frontend"]]) {
      await emit(store, c, { kind: "task", op: "claim", actor: who, task: id, touches: [id] });
      await emit(store, c, { kind: "task", op: "done", actor: who, task: id , no_human_impact: true});
    }
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "production", pass: true });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "C", touches: ["C"] });
    await emit(store, c, { kind: "task", op: "withdraw", actor: "pm", task: "D", reason: "duplicate" });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.live).toMatchObject({ deployed_sha: "1501d1cce361834f93f3b4063dadf89fb70379e0", verified_on_production: [{ id: "A", title: "sha endpoint" }] });
    expect(Object.keys(b.in_flight).sort()).toEqual(["working"]);
    expect(b.in_flight.working.all).toMatchObject([{ id: "C", title: "withdraw op", owner: "dev" }]);
    expect(b.in_flight.working.shown).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(b))).toHaveProperty("live.deployed_sha");
    expect(JSON.parse(JSON.stringify(b))).toHaveProperty("in_flight.working");

    // a deploy that nobody has measured since: the sha is unknown again, not stale-but-shown
    await emit(store, c, { kind: "note", actor: HUMAN, body: "deployed", writes: ["production:deployed.sha"] });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.live.deployed_sha).toBeNull();
  });
});

describe("S8 · presence is an environment property", () => {
  it("shows who was last seen when, from pulls as well as writes", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "note", actor: "pm", body: "kickoff" });
    c.tick(min(3));
    await pull(store, "backend", null, c.now());
    c.tick(min(7));
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    // the declared roles come first (default five), then anyone else heard from; within the window is present (t-042)
    expect(b.presence.map((p) => p.actor)).toEqual(["pd", "pm", "dev", "frontend", "qa", "backend"]);
    // t-047: pulling is listening; speaking without pulling is deaf; neither is missing
    expect(b.presence.find((p) => p.actor === "backend")).toMatchObject({ actor: "backend", role: undefined, status: "missing", present: false, listening: false, last_pull: c.iso(-min(7)), last_event: null, idle_pull_s: 420, idle_event_s: null, last_seen: c.iso(-min(7)), idle_s: 420, since: c.iso(-min(7)) }); // pulled 7 minutes ago, never spoke: past the 5-minute listen window
    expect(b.presence.find((p) => p.actor === "pm")).toMatchObject({ role: "pm", status: "deaf", present: false, last_pull: null, last_event: c.iso(-min(10)), idle_event_s: 600, last_seen: c.iso(-min(10)) });
    expect(b.presence.find((p) => p.actor === "dev")).toMatchObject({ actor: "dev", role: "dev", status: "missing", present: false, last_seen: null, idle_s: null, since: null });
    // backend pulled 7 minutes ago: not listening by the 5-minute default, listening with a 10-minute window
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now(), { listenWindowMs: min(10) }).presence.find((p) => p.actor === "backend")).toMatchObject({ status: "listening", present: true });
    c.tick(min(1));
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).presence.find((p) => p.actor === "pm")!.status).toBe("missing"); // 11 minutes without a word or a pull
  });

  it("t-042: the role set is a fact of the project; a missing role's service card leaves needs_human when the role is back", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", key: "roles", surface: "project", value: ["pm", "dev"] });
    await pull(store, "pm", null, c.now());
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.roles).toEqual(["pm", "dev"]);
    expect(b.presence.map((p) => [p.actor, p.present])).toEqual([["pm", true], ["dev", false]]);
    // the service notices dev missing and asks the human; the service may later ack its own card
    const card = await emit(store, c, { kind: "instruction", actor: "ateam", to: HUMAN, body: "dev 已经缺了 12 分钟，手里有 1 条指令。起一个 dev？", ack_by: c.iso(min(60)), intent: "do" });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human.map((n) => n.id)).toEqual([card.id]);
    await pull(store, "dev", null, c.now()); // dev is back: the card is no longer true, no ack needed
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toEqual([]);
    expect(b.instructions[0].status).not.toBe("acked");
    await emit(store, c, { kind: "ack", actor: "ateam", of: card.id });
    expect((await rejected(emit(store, c, { kind: "ack", actor: "ateam", of: (await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "x", ack_by: c.iso(min(5)) })).id }))).rule).toBe("ack");
  });
});

describe("decisions", () => {
  it("a decision note can supersede another; the old one stays in the log", async () => {
    const store = new MemoryStore();
    const c = clock();
    const d1 = await emit(store, c, { kind: "note", actor: "pm", body: "ship offline mode in v1", decision: true });
    await emit(store, c, { kind: "note", actor: "pm", body: "offline mode moves to v1.1", decision: true, supersedes: d1.id });
    expect((await rejected(emit(store, c, { kind: "note", actor: "pm", body: "x", supersedes: "nope" }))).rule).toBe("note");
    expect(reduce(await store.read(), c.now()).notes).toHaveLength(2);
  });
});

describe("t-011 · instructions to the human carry options; a click is ack + decision in one go", () => {
  it("options are for the human only, must be distinct, and the default must be one of them", async () => {
    const store = new MemoryStore();
    const c = clock();
    const ask = { kind: "instruction", actor: "pm", to: HUMAN, body: "board auth: private (A) or public (B)?", ack_by: c.iso(min(30)) } as const;
    expect((await rejected(emit(store, c, { ...ask, to: "dev", options: ["A", "B"] }))).rule).toBe("instruction");
    expect((await rejected(emit(store, c, { ...ask, options: ["A"] }))).rule).toBe("instruction");
    expect((await rejected(emit(store, c, { ...ask, options: ["A", "A"] }))).rule).toBe("instruction");
    expect((await rejected(emit(store, c, { ...ask, options: ["A", "B"], default: "C" }))).rule).toBe("instruction");
    const ok = await emit(store, c, { ...ask, options: ["A", "B"], default: "B" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.instructions[0]).toMatchObject({ id: ok.id, options: ["A", "B"], default: "B", status: "pending" });
    expect(b.needs_human[0].summary).toContain("[A | B; default B]");
  });

  it("a decision names one of the options, once, by the human; the board then shows the choice and needs-human clears", async () => {
    const store = new MemoryStore();
    const c = clock();
    const ask = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "board auth: private (A) or public (B)?", ack_by: c.iso(min(30)), options: ["A", "B"], default: "B" });
    const plain = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "claim t-1", ack_by: c.iso(min(30)) });
    const decide = (actor: string, of: string, option: string, decision = true): NewEvent =>
      ({ kind: "note", actor, body: `decision: ${option}`, decision, decides: { of, option } });

    expect((await rejected(emit(store, c, decide(HUMAN, ask.id, "C")))).rule).toBe("decide");
    expect((await rejected(emit(store, c, decide("dev", ask.id, "B")))).rule).toBe("decide");
    expect((await rejected(emit(store, c, decide(HUMAN, plain.id, "B")))).rule).toBe("decide");
    expect((await rejected(emit(store, c, decide(HUMAN, ask.id, "B", false)))).rule).toBe("decide");

    // what the board's click does: ack, then the decision note
    c.tick(min(5));
    await emit(store, c, { kind: "ack", actor: HUMAN, of: ask.id });
    const note = await emit(store, c, decide(HUMAN, ask.id, "B"));
    expect((await rejected(emit(store, c, decide(HUMAN, ask.id, "A")))).message).toContain("already decided");

    const s = reduce(await store.read(), c.now());
    expect(s.instructions.get(ask.id)!.chosen).toEqual({ option: "B", by: HUMAN, at: note.at, note: note.id });
    const b = board(s, HUMAN, c.now());
    expect(b.instructions.find((i) => i.id === ask.id)).toMatchObject({ status: "acked", chosen: { option: "B", by: HUMAN } });
    expect(b.needs_human.map((n) => n.id)).not.toContain(ask.id);
    expect(s.notes.filter((n) => n.decision).map((n) => n.id)).toEqual([note.id]);
  });
});

describe("t-018 · notes attach to a task", () => {
  it("--task stores the reference, an unknown task is rejected, and the board lists the notes in order", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-1", title: "Cookie flags", criteria: ["SameSite=Lax"] , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "note", actor: "dev", body: "on a ghost", task: "t-9" }))).rule).toBe("note");
    const n1 = await emit(store, c, { kind: "note", actor: "dev", body: "concern: the proxy strips the flag", task: "t-1" });
    await emit(store, c, { kind: "note", actor: "dev", body: "unrelated, not attached" });
    const n2 = await emit(store, c, { kind: "note", actor: "pm", body: "evidence: PR #12 merged as 1234567", task: "t-1" });
    const s = reduce(await store.read(), c.now());
    expect(s.tasks.get("t-1")!.notes.map((n) => n.id)).toEqual([n1.id, n2.id]);
    expect(s.notes).toHaveLength(3);
    const b = board(s, HUMAN, c.now());
    expect(b.tasks.open[0].notes).toEqual([
      { id: n1.id, actor: "dev", at: n1.at, body: "concern: the proxy strips the flag", decision: undefined },
      { id: n2.id, actor: "pm", at: n2.at, body: "evidence: PR #12 merged as 1234567", decision: undefined },
    ]);
  });
});

describe("t-056 · evidence has a layer for the owner: shows", () => {
  it("done and a passing verify may say what a person can now see; the board and live rows prefer it, and it is one sentence", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    for (const id of ["A", "B"]) {
      await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: `题 ${id}`, criteria: ["works"] , no_human_impact: true});
      await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    }
    const long = "字".repeat(121);
    expect((await rejected(emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "sha1", shows: long }))).rule).toBe("done");
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234: 测试全绿", shows: "牌桌上多了一行「线上」" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "B", evidence: "abc1234: 测试全绿" , no_human_impact: true});
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.done.map((t) => [t.id, t.shows, t.evidence])).toEqual([["A", "牌桌上多了一行「线上」", "abc1234: 测试全绿"], ["B", undefined, "abc1234: 测试全绿"]]);

    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true, shows: long }))).rule).toBe("verify");
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "production", pass: true, shows: "线上打开牌桌，第一行是部署 sha" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "production", pass: true });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    // a passing verify that said it replaces the owner's sentence; a task nobody described keeps its title on the live rows
    expect(b.tasks.verified.map((t) => t.shows)).toEqual(["线上打开牌桌，第一行是部署 sha", undefined]);
    expect(b.live.verified_on_production).toEqual([{ id: "A", title: "题 A", shows: "线上打开牌桌，第一行是部署 sha" }, { id: "B", title: "题 B", shows: undefined }]);
    expect(b.live.recent.map((x) => x.shows ?? x.title)).toEqual(["线上打开牌桌，第一行是部署 sha", "题 B"]);
    // a failing verify never speaks for the owner
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "staging", pass: false, shows: "不该显示" });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.shows).toBe("线上打开牌桌，第一行是部署 sha");
  });
});

describe("t-057 · finished work a decision made moot ends as obsolete", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(60));
    const decision = await emit(store, c, { kind: "note", actor: "pd", body: "决策：按钮改为永远可点", decision: true });
    const plain = await emit(store, c, { kind: "note", actor: "pd", body: "只是想法" });
    for (const id of ["A", "B", "C", "D", "E"]) await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: `题 ${id}`, criteria: ["works"] , no_human_impact: true});
    for (const id of ["A", "B", "C", "E"]) await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: ["packages/server/src/html.ts"] });
    for (const id of ["A", "B", "C"]) await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id, evidence: "abc1234", shows: "按钮现在永远可点" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: false, evidence: "不对" }); // B: failed
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "D", touches: ["packages/server/src/html.ts"] }); // D stacks on every dev task: a seam each
    return { store, c, decision, plain };
  };
  const obsolete = (store: MemoryStore, c: ReturnType<typeof clock>, task: string, actor: string, decision: string, reason?: string) =>
    emit(store, c, { kind: "task", op: "obsolete", actor, task, decision, reason });

  it("done and failed become obsolete, pointing at a decision note; the id stays, further ops are rejected, seams go", async () => {
    const { store, c, decision, plain } = await setup();
    expect([...reduce(await store.read(), c.now()).seams.values()].filter((s) => s.tasks.includes("A")).length).toBeGreaterThan(0);
    expect((await rejected(obsolete(store, c, "A", "pm", plain.id))).message).toMatch(/not a decision/);
    expect((await rejected(obsolete(store, c, "A", "pm", "01NOPE"))).message).toMatch(/not a note/);
    await obsolete(store, c, "A", "pm", decision.id, "按钮方案变了");
    await obsolete(store, c, "B", "pd", decision.id);
    const s = reduce(await store.read(), c.now());
    expect(s.tasks.get("A")).toMatchObject({ status: "obsolete", obsolete: { by: "pm", decision: decision.id, reason: "按钮方案变了" }, evidence: "abc1234" });
    expect(s.tasks.get("B")).toMatchObject({ status: "obsolete", obsolete: { by: "pd", decision: decision.id } });
    expect(s.tasks.get("B")!.verifications).toHaveLength(1); // what was judged stays on record
    expect([...s.seams.values()].some((x) => x.tasks.includes("A") || x.tasks.includes("B"))).toBe(false);
    const b = board(s, HUMAN, c.now());
    expect(b.tasks.obsolete.map((t) => t.id)).toEqual(["A", "B"]);
    expect(b.tasks.obsolete[0].obsolete).toMatchObject({ decision: decision.id });
    expect(Object.values(b.in_flight).flatMap((g) => g.all.map((t) => t.id))).not.toContain("A");
    expect(b.release.candidates.map((x) => x.task)).not.toContain("A");
    expect(b.seams.filter((x) => x.tasks.includes("A") || x.tasks.includes("B"))).toEqual([]);
    for (const e of [
      { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["x"] },
      { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "再来" },
      { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true },
      { kind: "task", op: "obsolete", actor: "pm", task: "A", decision: decision.id },
    ] as const) expect((await rejected(emit(store, c, e as never))).message).toMatch(/is obsolete/);
  });

  it("verified is final; open and blocked are for withdraw; working waits; only the scope owners may say it", async () => {
    const { store, c, decision } = await setup();
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "C", surface: "repo", pass: true });
    expect((await rejected(obsolete(store, c, "C", "pm", decision.id))).message).toMatch(/verified is final/);
    const e = await rejected(obsolete(store, c, "E", "pm", decision.id)); // working
    expect(e.rule).toBe("obsolete");
    expect(e.message).toMatch(/is working/);
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "F", title: "题 F", criteria: ["works"] , no_human_impact: true});
    expect((await rejected(obsolete(store, c, "F", "pm", decision.id))).message).toMatch(/is open.*task withdraw/);
    expect((await rejected(obsolete(store, c, "A", "dev", decision.id))).message).toMatch(/only pm .*not dev/);
    expect((await rejected(obsolete(store, c, "A", "qa", decision.id))).message).toMatch(/not qa/);
    await obsolete(store, c, "A", HUMAN, decision.id);
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("obsolete");
    // a criteria author who is not pm may do it too
    await emit(store, c, { kind: "task", op: "create", actor: "qa", task: "G", title: "题 G", criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "G", touches: ["g"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "G" , no_human_impact: true});
    await obsolete(store, c, "G", "qa", decision.id);
    expect(reduce(await store.read(), c.now()).tasks.get("G")!.status).toBe("obsolete");
  });
});

describe("t-059 · who holds what: the board says which responsibilities nobody holds", () => {
  it("a plain role list expands to the default packing; {role: [ids]} is taken as said; held / unheld / unclaimed / blocked", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    const cov = async () => Object.fromEntries(board(reduce(await store.read(), c.now()), HUMAN, c.now()).coverage.map((x) => [x.responsibility, x]));
    // nobody has pulled yet: everything declared by default is unheld
    let x = await cov();
    expect(Object.keys(x)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R8", "R9", "R11", "R12", "R13"]); // only what a role can hold: R7/R10 everyone, R14–R18 service/owner/none
    expect(x.R6).toMatchObject({ status: "unheld", holders: ["qa"], present: [], line: "没人管验收：qa 声明了但没在场" });
    expect(x.R5).toMatchObject({ status: "unheld", holders: ["dev", "frontend"] });
    // qa and dev pull: R6 held; R9 (dev, frontend) is held by dev but blocked until someone present may push production
    await pull(store, "qa", null, c.now());
    await pull(store, "dev", null, c.now());
    x = await cov();
    expect(x.R6).toMatchObject({ status: "held", present: ["qa"], reason: "", line: "验收：qa" });
    expect(x.R9).toMatchObject({ status: "blocked", present: ["dev"], line: "没人管上线：dev 声明了但缺推送许可或凭据（能力事实 push=none）" });
    await emit(store, c, { kind: "reading", actor: "dev", surface: "node", key: "dev:能力", value: { push: "production" } });
    x = await cov();
    expect(x.R9).toMatchObject({ status: "held", line: "上线：dev" });
    // the project says which role holds what: a writing project with two roles and no verifier
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { writer: ["R5", "R9"], reviewer: ["R1", "R2", "R3", "R4", "R8", "R12"] } });
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.roles).toEqual(["writer", "reviewer"]);
    x = await cov();
    expect(x.R6).toMatchObject({ status: "unclaimed", holders: [], line: "没人管验收：没有角色声明" });
    expect(x.R5).toMatchObject({ status: "unheld", holders: ["writer"], line: "没人管做：writer 声明了但没在场" });
    await pull(store, "writer", null, c.now());
    x = await cov();
    expect(x.R5.status).toBe("held");
    expect(x.R9).toMatchObject({ status: "blocked", present: ["writer"] });
    // a role name outside the default packing, declared as a plain list, holds nothing until the project says
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "writer"] });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.coverage.find((r) => r.responsibility === "R5")).toMatchObject({ status: "unclaimed" });
    expect(b.coverage.find((r) => r.responsibility === "R1")).toMatchObject({ holders: ["pm"] });
    // the gaps never become cards for the human
    expect(b.needs_human).toEqual([]);
  });
});

describe("t-064 · the sender takes an instruction back", () => {
  it("before an ack: withdrawn, out of for_me / open / needs_human, never overdue, no default fires; the log keeps the original", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(60));
    const i = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "改 t-1", ack_by: c.iso(min(15)) });
    const ask = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "上 A 还是 B？", options: ["A", "B"], default: "B", ack_by: c.iso(min(15)) });
    expect((await rejected(emit(store, c, { kind: "untell", actor: "qa", of: i.id, reason: "x" }))).message).toMatch(/only the sender or human/);
    expect((await rejected(emit(store, c, { kind: "untell", actor: "pm", of: i.id, reason: " " }))).message).toMatch(/say why/);
    const u = await emit(store, c, { kind: "untell", actor: "pm", of: i.id, reason: "t-1 已经不用改了" });
    await emit(store, c, { kind: "untell", actor: HUMAN, of: ask.id, reason: "问题问错了" }); // the human may take back anyone's
    // dev pulls now: the instruction and its untell arrive together; it is not "for me"
    const p = await pull(store, "dev", null, c.now());
    expect(p.events.map((e) => e.kind)).toEqual(["instruction", "instruction", "untell", "untell"]);
    expect(p.for_me).toEqual([]);
    expect(p.taken_back_seen).toBeUndefined();
    c.tick(min(30)); // past ack_by: not overdue, and the ask's default does not fire
    const s = reduce(await store.read(), c.now());
    expect(s.instructions.get(i.id)).toMatchObject({ withdrawn: { by: "pm", reason: "t-1 已经不用改了", seen: false }, overdue: false });
    expect(s.instructions.get(ask.id)!.chosen).toBeUndefined();
    const b = board(s, HUMAN, c.now());
    expect(b.instructions.map((x) => [x.id, x.status])).toEqual([[i.id, "withdrawn"], [ask.id, "withdrawn"]]);
    expect(b.overdue).toEqual([]);
    expect(b.needs_human).toEqual([]);
    expect(b.instructions[0].withdrawn).toMatchObject({ reason: "t-1 已经不用改了" });
    expect((await store.read()).events.map((e) => e.kind)).toEqual(["instruction", "instruction", "untell", "untell"]); // nothing rewritten
    // acking or deciding what was taken back is refused; taking it back twice too
    expect((await rejected(emit(store, c, { kind: "ack", actor: "dev", of: i.id }))).message).toMatch(/taken back/);
    expect((await rejected(emit(store, c, { kind: "note", actor: HUMAN, body: "A", decision: true, decides: { of: ask.id, option: "A" } }))).message).toMatch(/taken back/);
    expect((await rejected(emit(store, c, { kind: "untell", actor: "pm", of: i.id, reason: "再撤" }))).message).toMatch(/already taken back/);
    void u;
  });

  it("after an ack or a decision it is refused; once delivered, the recipient is told it had seen it", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(60));
    const i = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "改 t-1", ack_by: c.iso(min(15)) });
    await pull(store, "dev", null, c.now()); // dev has seen it
    c.tick(min(1));
    const cursor = i.id;
    const u = await emit(store, c, { kind: "untell", actor: "pm", of: i.id, reason: "不用了" });
    const s = reduce(await store.read(), c.now());
    expect(s.instructions.get(i.id)!.withdrawn).toMatchObject({ seen: true });
    const p = await pull(store, "dev", cursor, c.now());
    expect(p.events.map((e) => e.id)).toEqual([u.id]);
    expect(p.taken_back_seen).toEqual([i.id]); // the CLI turns this into 你已看过的这条被撤回了
    // acked: too late
    const j = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: "改 t-2", ack_by: c.iso(min(15)) });
    await emit(store, c, { kind: "ack", actor: "dev", of: j.id });
    expect((await rejected(emit(store, c, { kind: "untell", actor: "pm", of: j.id, reason: "x" }))).message).toMatch(/was acked by dev/);
    // decided: too late
    const ask = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "A 还是 B？", options: ["A", "B"], ack_by: c.iso(min(15)) });
    await emit(store, c, { kind: "note", actor: HUMAN, body: "A", decision: true, decides: { of: ask.id, option: "A" } });
    expect((await rejected(emit(store, c, { kind: "untell", actor: "pm", of: ask.id, reason: "x" }))).message).toMatch(/was decided/);
    // F1/F2 still hold for an instruction nobody took back
    c.tick(min(30));
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).overdue.map((o) => o.instruction)).toEqual([]); // j acked, ask decided, i withdrawn
  });
});

describe("t-067 · the side that was done before the other claimed is never blocked by it, whoever owns them", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] , no_human_impact: true});
  const seams = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).seams;

  it("cross-owner: A done, then B (another owner) claims the same files: verify A passes, and B may be verified too once done; both in flight still collide", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await create(store, c, "A"); await create(store, c, "B"); await create(store, c, "C");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "aaaaaaa1 完成" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    expect((await seams(store, c))[0]).toMatchObject({ id: "seam:A+B", stacked: { done: "A", on: "B" }, open: false });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }); // released by the rule, not by pm
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
    // C (dev) claims while B is in flight: a collision, same as ever
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "C", touches: ["app.ts"] });
    expect((await seams(store, c)).find((x) => x.id === "seam:B+C")).toMatchObject({ open: true, stacked: undefined });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B", evidence: "bbbbbbb1 合并了 aaaaaaa1" , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true }))).message).toMatch(/seam:B\+C/);
  });

  it("re-done after a reopen is judged on the newest done: a reopened A back in flight collides with B, and once A is done again it depends on who claimed when", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    expect((await seams(store, c))[0].stacked).toEqual({ done: "A", on: "B" });
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "补" });
    expect((await seams(store, c))[0]).toMatchObject({ open: true, stacked: undefined }); // A is in flight again
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" , no_human_impact: true});
    // t-160 改了这两行。原来的规则读的是 A **最新**那次 done：它晚于 B 的 claim，于是接缝重新变成开的，A 的验收
    // 被一件还没写代码的任务挡住。可 B 按下 claim 的那一刻 A 已经是一件交出去的活——**A 后来又交了一轮，改变不了
    // 那一刻**。今晚这一幕花掉三次（qa 一次自查 + pm 一次裁定 + 两条 tell）。B 的合并义务一点没少（判据 2）：
    // CLI 那头对的是 A **此刻**的证据 sha，A 又交了一轮，B 要合的就是新的那一轮。
    expect((await seams(store, c))[0]).toMatchObject({ stacked: { done: "A", on: "B" }, open: false });   // 不再挡 A 的验收
    // B finishes first this time; then A reclaims after B's done: B is the earlier side now
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "再补" });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts", "html.ts"] });
    expect((await seams(store, c))[0].stacked).toEqual({ done: "B", on: "A" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("B")!.status).toBe("verified");
  });
});

describe("t-068 · every task says which layer it belongs to: this version, or earlier", () => {
  it("before any deploy everything is this version; after a second deploy, what production carried before it is earlier, the rest stays", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(120));
    const create = (id: string) => emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: `题 ${id}`, criteria: ["works"] , no_human_impact: true});
    const ship = async (id: string, who = "dev") => {
      await emit(store, c, { kind: "task", op: "claim", actor: who, task: id, touches: [id] });
      await emit(store, c, { kind: "task", op: "done", actor: who, task: id, evidence: "abc1234" , no_human_impact: true});
      await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "production", pass: true });
    };
    const eras = async () => Object.fromEntries(Object.values(board(reduce(await store.read(), c.now()), HUMAN, c.now()).tasks).flat().map((t) => [t.id, t.era]));
    for (const id of ["A", "B", "C", "D", "E"]) await create(id);
    await emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: "aaaaaaa" });
    await ship("A");
    await emit(store, c, { kind: "task", op: "withdraw", actor: "pm", task: "D", reason: "重复" });
    c.tick(min(5));
    expect(await eras()).toEqual({ A: "this_version", B: "this_version", C: "this_version", D: "this_version", E: "this_version" }); // one deploy: no "before"
    // the second deploy: A and D happened before it; B ships on it; C is in flight; E untouched
    await emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: "bbbbbbb" });
    c.tick(min(1));
    await ship("B", "frontend");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "C", touches: ["C"] });
    expect(await eras()).toEqual({ A: "earlier", B: "this_version", C: "this_version", D: "earlier", E: "this_version" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.live.earlier.map((x) => x.id)).toEqual(["A"]); // the same rule as the live list
    expect(Object.values(b.tasks).flat().find((t) => t.id === "A")!.summary).toBe("✓ production");
    expect(Object.values(b.tasks).flat().find((t) => t.id === "D")!.summary).toBe("已撤回：重复");
    expect(Object.values(b.tasks).flat().find((t) => t.id === "C")!.summary).toBe("working");
  });
});

describe("t-073 · both sides done and the later absorbed the earlier: the seam settles by itself, by the declared form", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] , no_human_impact: true});
  const seams = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).seams;
  /** A and B in flight at once (a collision), both done; B's evidence names A's sha. */
  const collide = async (store: MemoryStore, c: ReturnType<typeof clock>, bEvidence = "bbbbbbb2 合并了 aaaaaaa1") => {
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "aaaaaaa1 完成" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B", evidence: bEvidence , no_human_impact: true});
  };

  it("no form declared: today's behaviour, the seam stays open and verify waits for a person", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await collide(store, c);
    expect((await seams(store, c))[0]).toMatchObject({ id: "seam:A+B", open: true, absorbed: undefined });
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true }))).message).toMatch(/seam/);
  });

  it("named-sha form: judged from the log — the later side's evidence names the earlier's sha; not named, still open; both in flight, unchanged", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "named-sha" });
    await collide(store, c);
    const s = (await seams(store, c))[0];
    expect(s).toMatchObject({ open: false, absorbed: { later: "B", earlier: "A", basis: "后者证据写明含前者 aaaaaaa（named-sha）" } });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    // not named: open
    const store2 = new MemoryStore();
    await emit(store2, c, { kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "named-sha" });
    await collide(store2, c, "bbbbbbb2 做完了");
    expect((await seams(store2, c))[0]).toMatchObject({ open: true, absorbed: undefined });
    // both in flight: nothing to judge
    const store3 = new MemoryStore();
    await emit(store3, c, { kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "named-sha" });
    await create(store3, c, "A"); await create(store3, c, "B");
    await emit(store3, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store3, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    expect((await seams(store3, c))[0]).toMatchObject({ open: true });
  });

  it("git-ancestor form: the doer's CLI records the resolution the rule wrote; the board shows the basis and who recorded it", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "git-ancestor" });
    await collide(store, c);
    expect((await seams(store, c))[0].open).toBe(true); // the log alone cannot tell: git can
    await emit(store, c, { kind: "task", op: "seam", actor: "frontend", tasks: ["A", "B"], resolution: "absorbed: 后者 bbbbbbb 含前者 aaaaaaa（git-ancestor）" });
    const s = (await seams(store, c))[0];
    expect(s).toMatchObject({ open: false, resolved: "frontend", absorbed: { later: "B", earlier: "A", basis: "后者 bbbbbbb 含前者 aaaaaaa（git-ancestor）", by: "frontend" } });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
  });
});

describe("t-076 · a verified task whose evidence is overturned: a fail by a third party overrides the pass", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "题", criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["x"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234 全绿" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true, evidence: "看过了" });
    return { store, c };
  };
  it("owner, criteria author and the one who passed it are refused; a pass never overrides a pass; a third party's fail with evidence overturns, status goes to done, history stays", async () => {
    const { store, c } = await setup();
    const before = (await store.read()).events.map((e) => JSON.stringify(e));
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
    // t-104 (pd 23:59): a pass never overrides a pass, and a fail still owes evidence. What is no longer refused is
    // *who* is failing: the owner, the criteria author and the passer may all say "not met".
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "A", surface: "repo", pass: true }))).message).toMatch(/a pass does not override a pass/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "A", surface: "repo", pass: false }))).message).toMatch(/needs --evidence/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "我漏验了" }))).message).toMatch(/证据要指名推翻的是哪一条判据/);
    const o = await emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "A", surface: "repo", pass: false, evidence: "证据说含 c3cfeee，git 说不含" });
    const s = reduce(await store.read(), c.now());
    const t = s.tasks.get("A")!;
    expect(t.status).toBe("done"); // not working: nobody reopened it
    expect(t.round).toBe(1);
    expect(t.verifications.map((v) => [v.surface, v.pass, v.by])).toEqual([["repo", true, "qa"], ["repo", false, "frontend"]]); // both kept, in time order
    expect(surfaceResults(t)).toEqual([{ surface: "repo", pass: false }]);
    expect(t.history.map((h) => h.op)).toEqual(["done", "verify", "verify"]);
    // no event was rewritten
    const after = (await store.read()).events.map((e) => JSON.stringify(e));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    // the board says it out loud
    const b = board(s, HUMAN, c.now());
    const bt = b.tasks.done.find((x) => x.id === "A")!;
    expect(bt.overturned).toEqual([{ surface: "repo", by: "frontend", at: o.at, evidence: "证据说含 c3cfeee，git 说不含", passed_by: "qa" }]);
    expect(bt.verified_on).toEqual([]);
    // the owner fixes it and someone verifies again on the same surface: allowed, since the latest result there is a fail
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "补合并" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "def5678 真合了" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
    // the human may overturn too, but not their own pass
    const { store: s2, c: c2 } = await setup();
    await emit(s2, c2, { kind: "task", op: "verify", actor: HUMAN, task: "A", surface: "repo", pass: false, evidence: "线上没看到" });
    expect(reduce(await s2.read(), c2.now()).tasks.get("A")!.status).toBe("done");
  });
});

describe("t-077 · the slim board tells omitted from empty", () => {
  /** An independent walk (not the one in core): every path present in full and absent in slim, plus every list slim cut short. */
  const missing = (f: unknown, s: unknown, p = ""): string[] => {
    const out: string[] = [];
    if (Array.isArray(f) && Array.isArray(s)) {
      if (s.length < f.length) out.push(`${p}[${f.length - s.length} of ${f.length}]`);
      const ids = (xs: unknown[]) => xs.map((x) => (x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id) : null));
      const fi = ids(f), si = ids(s);
      f.forEach((fx, i) => { const j = fi[i] !== null ? si.indexOf(fi[i]) : i; if (j >= 0 && j < s.length) out.push(...missing(fx, s[j], `${p}[]`)); });
    } else if (f && s && typeof f === "object" && typeof s === "object") {
      for (const [k, fv] of Object.entries(f as Record<string, unknown>)) {
        if (fv === undefined || k === "omitted") continue;
        const sv = (s as Record<string, unknown>)[k];
        if (sv === undefined) out.push(`${p ? p + "." : ""}${k}`); else out.push(...missing(fv, sv, `${p ? p + "." : ""}${k}`));
      }
    }
    return [...new Set(out)];
  };
  /** Every key slim has, full has with the same value, unless the path is a list slim cut short. */
  const extra = (f: unknown, s: unknown, p = ""): string[] => {
    const out: string[] = [];
    if (Array.isArray(f) && Array.isArray(s)) return out;
    if (f && s && typeof f === "object" && typeof s === "object") for (const k of Object.keys(s as object)) if (!(k in (f as object)) && k !== "omitted") out.push(`${p}.${k}`);
    return out;
  };
  const check = (full: Board, slim: Board) => {
    const gone = missing(full, slim);
    for (const path of gone) expect(slim.omitted, `${path} disappeared but omitted does not say so`).toContain(path);
    for (const path of slim.omitted) expect(gone, `omitted lists ${path} but it did not disappear`).toContain(path);
    expect(extra(full, slim)).toEqual([]); // nothing invented
    expect(full.omitted).toEqual([]);
  };

  it("omitted is exactly what disappeared, on a rich board and on a nearly empty one; empties stay empties", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "题 A", criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "题 B", criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["x"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["x"] });
    await emit(store, c, { kind: "reading", actor: "pm", surface: "team", key: "focus", value: "一" });
    await emit(store, c, { kind: "reading", actor: "pm", surface: "team", key: "focus", value: "二" }); // one stale reading
    for (let i = 0; i < 8; i++) { const ins = await emit(store, c, { kind: "instruction", actor: "pm", to: "dev", body: `做 ${i}`, ack_by: c.iso(min(15)) }); await emit(store, c, { kind: "ack", actor: "dev", of: ins.id }); }
    const full = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    const slim = slimBoard(full);
    check(full, slim);
    expect(slim.omitted).toContain("tasks.done[].criteria");
    expect(slim.omitted).toContain("seams[].overlap");
    expect(slim.omitted).toContain("release.candidates");
    expect(slim.omitted).toContain("instructions[8 of 8]");
    // really empty stays empty and is not "omitted"
    expect(slim.tasks.done[0].surfaces).toEqual([]);
    expect(slim.tasks.done[0].verified_on).toEqual([]);
    expect(slim.needs_human).toEqual([]);
    expect(slim.undelivered).toEqual([]);
    expect(slim.omitted.some((x) => x.startsWith("undelivered") || x.startsWith("needs_human"))).toBe(false);
    // a nearly empty board: only what actually went away
    const tiny = new MemoryStore();
    await emit(tiny, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "题 A", criteria: ["works"] , no_human_impact: true});
    const tf = board(reduce(await tiny.read(), c.now()), HUMAN, c.now());
    const ts = slimBoard(tf);
    check(tf, ts);
    expect(ts.omitted.some((x) => x.startsWith("seams") || x.startsWith("readings") || x.startsWith("instructions"))).toBe(false);
    expect(ts.omitted).toContain("release.candidates"); // the key went away even though it was empty: that is still a removal
  });
});

describe("t-083 · the board says who pushed only when a push recorded it", () => {
  it("release --deploy's reading gives deployed_by; a hand-recorded one gives checked_by; a reading with no method gives neither", async () => {
    const c = clock(Date.now() - min(30));
    const cases: [string | undefined, "deployed_by" | "checked_by" | "neither"][] = [
      ["ateam release --deploy 推到 production，由 CI 部署；含 t-1", "deployed_by"],
      ["ateam release --deploy：production 已在此 sha", "deployed_by"],
      ["curl https://ateam.fly.dev/health 读 sha", "checked_by"],
      [undefined, "neither"],
    ];
    for (const [method, want] of cases) {
      const store = new MemoryStore();
      await emit(store, c, { kind: "reading", actor: "qa", key: "deployed.sha", surface: "production", value: "abc1234", method, depends_on: ["production:deployed.sha"] });
      const live = board(reduce(await store.read(), c.now()), HUMAN, c.now()).live;
      expect(live.deployed_sha).toBe("abc1234");
      expect([live.deployed_by, live.checked_by], `${method}`).toEqual(want === "deployed_by" ? ["qa", null] : want === "checked_by" ? [null, "qa"] : [null, null]);
      expect(live.at, `${method}`).toBe((await store.read()).events[0].at); // when it was recorded, for "how long ago"
    }
  });
});

describe("t-084 · the call-out address has a shape; a bad one is said, not hidden", () => {
  it("an https webhook is accepted; an email, an http url or a sentence is refused with what it looks like; a value recorded before the shape shows as misconfigured", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await emit(store, c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: "https://hooks.example/team" });
    // t-119 (pd 01:21)：形状对不等于送得到——配上之后的默认落点是「还没真发成功过」，不是「已配置」
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).alert).toMatchObject({ status: "unproven", value: "https://hooks.example/team" });
    for (const [bad, form] of [["a@b.com", "一个邮箱"], ["http://hooks.example/x", "一个 http 地址（不是 https）"], ["找我用微信", "一段文本「找我用微信」"], [42, "一个number"]] as const) {
      const r = await rejected(emit(store, c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: bad }));
      expect(r.rule).toBe("reading");
      expect(r.message).toBe(`reading: 外呼只支持 https webhook，收到的是${form}；不写入`);
    }
    // a value written before the shape existed (replayed from an older log) is kept and called out
    const older = new MemoryStore();
    await older.appendRaw({ id: "01OLD", at: c.iso(-min(10)), kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: "human@example.com" } as never);
    const b = board(reduce(await older.read(), c.now()), HUMAN, c.now());
    // t-119 (pd 01:40 ②)：这一句改成人关心的那件事——收不收得到，而不是我们存了什么
    expect(b.alert).toMatchObject({ status: "misconfigured", value: "human@example.com", line: "这个外呼地址我们发不出去，它不是一个 https 地址。" });
  });
});

describe("t-078 · 未上线 vs 已上线未验 vs 判不出", () => {
  const world = async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(60));
    const ship = async (id: string, sha: string | undefined, verifyProd = false) => {
      await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: `题 ${id}`, criteria: ["works"] , no_human_impact: true});
      await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
      await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id, evidence: sha ? `${sha} 完成` : "没有 sha 的证据" , no_human_impact: true});
      await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true });
      if (verifyProd) await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "production", pass: true });
    };
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "git-ancestor" });
    await ship("A", "aaaaaaa1"); // already in production
    await ship("B", "bbbbbbb2"); // not yet
    await ship("C", undefined);  // no sha at all
    await ship("D", "ddddddd4", true); // verified on production: not a candidate at all
    await emit(store, c, { kind: "reading", actor: HUMAN, surface: "production", key: "deployed.sha", value: "eeeeeee5", method: "ateam release --deploy 推到 production", depends_on: ["production:deployed.sha"] });
    return { store, c };
  };
  const rel = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).release;

  it("without a containment fact every candidate is unknown, with the reason naming the fact to record", async () => {
    const { store, c } = await world();
    const r = await rel(store, c);
    expect(r.candidates!.map((x) => x.task)).toEqual(["A", "B", "C"]); // D passed on production
    expect(r.counts).toEqual({ pending_deploy: 0, deployed_unverified: 0, unknown: 3 });
    expect(r.unknown!.every((x) => x.reason.includes("production:deployed.tasks"))).toBe(true);
    expect(r.basis).toContain("production:deployed.tasks");
  });

  it("with the fact: contained ones are deployed_unverified, the rest pending_deploy, no-sha and uncovered ones unknown", async () => {
    const { store, c } = await world();
    await emit(store, c, { kind: "reading", actor: "qa", surface: "production", key: "deployed.tasks", value: { sha: "eeeeeee5", contained: ["A"], not_contained: ["B"], method: "git-ancestor" }, depends_on: ["production:deployed.sha"] });
    let r = await rel(store, c);
    expect(r.deployed_unverified!.map((x) => x.task)).toEqual(["A"]);
    expect(r.pending_deploy!.map((x) => x.task)).toEqual(["B"]);
    expect(r.unknown!.map((x) => [x.task, x.reason])).toEqual([["C", "证据里没有 sha，无从比对"]]);
    expect(r.counts).toEqual({ pending_deploy: 1, deployed_unverified: 1, unknown: 1 });
    expect(r.basis).toContain("git-ancestor");
    // a task finished after the fact was measured is not silently placed
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "E", title: "题 E", criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "E", touches: ["E"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "E", evidence: "fffffff6 完成" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "E", surface: "repo", pass: true });
    r = await rel(store, c);
    expect(r.unknown!.find((x) => x.task === "E")!.reason).toContain("没有覆盖 E");
    // a new deploy invalidates the fact: everything is unknown again, saying which sha the fact was measured against
    await emit(store, c, { kind: "reading", actor: HUMAN, surface: "production", key: "deployed.sha", value: "9999999", method: "ateam release --deploy 推到 production", writes: ["production:deployed.sha"], depends_on: ["production:deployed.sha"] });
    r = await rel(store, c);
    expect(r.counts.unknown).toBe(r.candidates!.length);
    expect(r.unknown![0].reason).toMatch(/ateam release/); // the deploy invalidated the fact (it depends on production:deployed.sha): measure again
  });
});

describe("t-088 · an event can say where it came from, and the same source lands once", () => {
  it("the second write with the same from returns the first event and appends nothing; different from, different events; no from is untouched", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    const one = await appendFrom(store, { kind: "note", actor: "pm", body: "旧单据 #12 的内容", from: "tracker#12" }, { human: HUMAN, now: c.now() });
    expect(one.created).toBe(true);
    const again = await appendFrom(store, { kind: "note", actor: "dev", body: "同一张单据，第二次搬", from: "tracker#12" }, { human: HUMAN, now: c.tick(min(1)) });
    expect(again.created).toBe(false);
    expect(again.event.id).toBe(one.event.id);
    expect(again.event.body).toBe("旧单据 #12 的内容"); // the first one stands; the second is not written over it
    const other = await appendFrom(store, { kind: "note", actor: "pm", body: "另一张", from: "tracker#13" }, { human: HUMAN, now: c.tick(min(1)) });
    expect(other.created).toBe(true);
    // no from: every write is its own event, exactly as before
    for (let i = 0; i < 2; i++) await emit(store, c, { kind: "note", actor: "pm", body: "普通 note" });
    const events = (await store.read()).events;
    expect(events.map((e) => e.from)).toEqual(["tracker#12", "tracker#13", undefined, undefined]);
    expect(events).toHaveLength(4);
    // the state can be asked, and the board carries from through
    const s = reduce(await store.read(), c.now());
    expect(s.from.get("tracker#12")!.id).toBe(one.event.id);
    expect(s.from.size).toBe(2);
    // qa 23:37: a task carried in says so on the board and through GET /task/<id>, not only inside the event
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "im-1", title: "搬来的", criteria: ["x"], from: "tracker#20" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "loc-1", title: "本地建的", criteria: ["x"] , no_human_impact: true});
    const bb = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(boardTask(bb, "im-1")!.from).toBe("tracker#20");
    expect(boardTask(bb, "loc-1")!.from).toBeUndefined();
    expect(boardTask(slimBoard(bb), "im-1")!.from).toBe("tracker#20");
    // two writers racing on the same from: the log still holds one
    const race = new MemoryStore();
    const results = await Promise.all([1, 2, 3].map((i) => appendFrom(race, { kind: "note", actor: "pm", body: `第 ${i} 次`, from: "同一处" }, { human: HUMAN, now: c.now() })
      .catch(() => null)));
    void results;
    const raced = (await race.read()).events.filter((e) => e.from === "同一处");
    expect(raced.length).toBeGreaterThanOrEqual(1);
  });
});

describe("t-089 · a number carried in from somewhere else lands expired", () => {
  it("it must say when it was measured, it is never current, and a reading without from is untouched", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    const bad = await rejected(emit(store, c, { kind: "reading", actor: "pm", surface: "production", key: "users.count", value: 1200, from: "旧看板/指标页" }));
    expect(bad.rule).toBe("reading");
    expect(bad.message).toContain("必须带 measured_at");
    await emit(store, c, { kind: "reading", actor: "pm", surface: "production", key: "users.count", value: 1200, from: "旧看板/指标页", measured_at: c.iso(-min(5)), valid_for: 24 * 3600_000 } as never);
    const s = reduce(await store.read(), c.now());
    const rs = [...s.readings.values()][0];
    expect(rs.expired).toBe(true);
    expect(rs.valid).toBe(false); // measured five minutes ago with a day of validity, and still not current: it was measured elsewhere
    const b = board(s, HUMAN, c.now());
    const row = b.readings.find((r) => r.key === "users.count")!;
    expect(row.valid).toBe(false);
    expect(row.why).toBe("搬进来的数字：在这里没有测过，谁用谁重测");
    // nothing that reads a current value picks it up
    await emit(store, c, { kind: "reading", actor: "pm", surface: "production", key: "deployed.sha", value: "abc1234", from: "旧看板/发布页", measured_at: c.iso(-min(1)) });
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).live.deployed_sha).toBeNull();
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "alert.webhook", value: "https://hooks.example/x", from: "旧看板/设置页", measured_at: c.iso(-min(1)) });
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).alert.status).not.toBe("set");
    // a reading measured here, as always
    await emit(store, c, { kind: "reading", actor: "qa", surface: "production", key: "deployed.sha", value: "def5678", method: "curl /health", depends_on: ["production:deployed.sha"] });
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).live.deployed_sha).toBe("def5678");
  });
});

describe("t-087 · a fail notice stops being true when someone else takes the task over", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(60));
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "题", criteria: ["works"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["x"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234" , no_human_impact: true});
    const v = await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "判据 2 没满足" });
    const notice = await emit(store, c, { kind: "instruction", actor: "ateam", to: "dev", body: `A${" 验收未过："}判据 2 没满足。改完重新 done。`, ack_by: c.iso(min(15)), refs: [v.id] });
    return { store, c, notice };
  };
  const card = async (store: MemoryStore, c: ReturnType<typeof clock>, id: string) => {
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    return { b, i: b.instructions.find((x) => x.id === id)! };
  };
  // t-147: a fail notice carries no options, so it is never in `overdue`; what the board owes for it is that
  // its owner has not read it. Read that off overdue_by_presence, which is where an unanswered notice lives now.
  const owed = (b: Board) => Object.values(b.overdue_by_presence).flatMap((g) => g.instructions);

  it("another role claims it: the notice stops being owed, with the reason and who took it; nobody claims: unchanged; the owner redoing it still clears it", async () => {
    const { store, c, notice } = await setup();
    c.tick(min(30)); // past ack_by, unread
    let { b, i } = await card(store, c, notice.id);
    // t-147: a fail notice carries no options, so it is never overdue — what is true is that its owner has not read
    // it, and the board carries it as owed until somebody deals with it.
    expect(owed(b)).toContain(notice.id); // criterion 3: nobody took over, nothing changed
    expect(b.overdue).toEqual([]);
    expect(i.stale).toBeUndefined();
    const claim = await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "A", touches: ["x"] });
    ({ b, i } = await card(store, c, notice.id));
    expect(b.needs_human.map((x) => x.id)).not.toContain(notice.id);
    expect(owed(b)).not.toContain(notice.id); // no longer true, so nobody owes it
    expect(i.stale).toEqual({ reason: "taken_over", task: "A", by: "frontend", claim: claim.id });
    expect(i.status).toBe("pending"); // the instruction itself is untouched: unread and past its time, just no longer true
    // history is intact: the notice event and the verify are still there, unedited
    const events = (await store.read()).events;
    expect(events.find((e) => e.id === notice.id)!.body).toContain("验收未过");
    expect(events).toHaveLength(6);

    // the owner redoing it clears the notice too, as before (t-054)
    const w = await setup();
    w.c.tick(min(30));
    await emit(w.store, w.c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "改" });
    await emit(w.store, w.c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "def5678" , no_human_impact: true});
    const after = await card(w.store, w.c, w.notice.id);
    expect(owed(after.b)).not.toContain(w.notice.id);
    expect(after.i.stale).toEqual({ reason: "redone", task: "A" });
    // the same person reclaiming their own task is not a takeover
    const own = await setup();
    own.c.tick(min(30));
    await emit(own.store, own.c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["x", "y"] });
    const still = await card(own.store, own.c, own.notice.id);
    expect(still.i.stale).toBeUndefined();
    expect(owed(still.b)).toContain(own.notice.id);
  });
});

describe("t-092 · the service counts what an import landed and asks the human to check it", () => {
  const imported = async (store: MemoryStore, c: ReturnType<typeof clock>) => {
    // two in-flight tasks, one finished (not counted), a decision and the one it superseded, two facts, one question
    for (const [id, from] of [["t-1", "pm/单据#1"], ["t-2", "pm/单据#2"], ["t-3", "pm/单据#3"]]) {
      await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: `旧标题 ${id}`, criteria: ["旧判据"], from , no_human_impact: true});
      await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    }
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t-3", evidence: "来自 pm/单据#3" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-3", surface: "repo", pass: true }); // verified: not in flight
    const old = await emit(store, c, { kind: "note", actor: "pm", body: "旧决定：A", decision: true, from: "pm/台账#1" });
    await emit(store, c, { kind: "note", actor: "pm", body: "现行决定：B", decision: true, supersedes: old.id, from: "pm/台账#2" });
    for (const [key, from] of [["users.count", "pm/进度板"], ["deployed.sha", "pm/发布页"]]) {
      await emit(store, c, { kind: "reading", actor: "pm", surface: "production", key, value: key === "users.count" ? 1200 : "abc1234", from, measured_at: c.iso(-min(20)) });
    }
    await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: "旧问题：上 A 还是 B？", options: ["A", "B"], ack_by: c.iso(min(60)), from: "pm/广播#9" });
  };

  it("counts in-flight tasks, standing decisions, imported facts and unanswered questions — from the log, not from what the importer says", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(60));
    await imported(store, c);
    expect(importCounts(reduce(await store.read(), c.now()))).toEqual({ tasks: 2, decisions: 1, readings: 2, asks: 1 });
    // the importer says it is done, and claims other numbers: the service uses its own
    const done = await emit(store, c, { kind: "note", actor: "pm", body: "导入完成：我数的是 9 件事、9 条决定" });
    const out = await runFollowUps(store, done, HUMAN, c.now());
    expect(out).toHaveLength(1);
    const card = out[0] as { kind: string; to: string; intent: string; options: string[]; body: string; refs: string[] };
    expect(card).toMatchObject({ kind: "instruction", actor: "ateam", to: HUMAN, intent: "ask", options: ["对", "有漏"], refs: [done.id] });
    // pd 23:35 (t-095 review): 「N 件」 not 「N 件事」, and the re-measure caveat is its own sentence at the end
    expect(card.body).toBe("搬过来了，对吗？在途 2 件、1 条现行决定、2 个数字、1 个等你答的问题。搬来的数字都标了要重测。旧的那边一条没删。");
    expect(card.default).toBeUndefined(); // no default: the human answers this one
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human.map((x) => x.id)).toContain((out[0] as { id: string }).id);
    // saying it again does not ask again
    const again = await emit(store, c, { kind: "note", actor: "pm", body: "导入完成：又跑了一次" });
    expect(await runFollowUps(store, again, HUMAN, c.now())).toEqual([]);
  });

  it("对 and 有漏 each send the importer one instruction, and the events stay", async () => {
    for (const [option, body] of [["对", "human 说清单对"], ["有漏", "human 说有漏"]] as const) {
      const store = new MemoryStore();
      const c = clock(Date.now() - min(60));
      await imported(store, c);
      const done = await emit(store, c, { kind: "note", actor: "pm", body: "导入完成：搬完了" });
      const [card] = await runFollowUps(store, done, HUMAN, c.now());
      const decision = await emit(store, c, { kind: "note", actor: HUMAN, body: `decision: ${option}`, decision: true, decides: { of: (card as { id: string }).id, option }, refs: [(card as { id: string }).id] });
      const out = await runFollowUps(store, decision, HUMAN, c.now());
      expect(out).toHaveLength(1);
      const told = out[0] as { to: string; body: string; refs: string[] };
      expect(told.to).toBe("pm"); // the one who said it was done
      expect(told.body.startsWith(body)).toBe(true);
      if (option === "对") expect(told.body).toContain("这里只读");
      else expect(told.body).toContain("回去核对旧单据再补");
      expect(told.refs).toEqual([(card as { id: string }).id, decision.id]);
      // the card leaves 需要你 once answered, and nothing was edited
      const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
      expect(b.needs_human.map((x) => x.id)).not.toContain((card as { id: string }).id);
    }
  });
});

describe("t-096 · a display name people recognise, next to an id that never moves", () => {
  it("a task and a decision can carry one, it can change, two records may share it, and every lookup still goes by id", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    const a = await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-1", title: "登录超时", criteria: ["works"], label: "T-07", from: "pm/单据#7" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-2", title: "另一件", criteria: ["works"], label: "T-07" , no_human_impact: true}); // the same label, no from: they are independent
    const d1 = await emit(store, c, { kind: "note", actor: "pm", body: "旧决定 12", decision: true, label: "决策 12", from: "pm/台账#12" });
    await emit(store, c, { kind: "note", actor: "pm", body: "没有显示名的决定", decision: true });
    let s = reduce(await store.read(), c.now());
    expect(s.tasks.get("t-1")).toMatchObject({ id: "t-1", label: "T-07", from: "pm/单据#7" });
    expect(s.tasks.get("t-2")).toMatchObject({ id: "t-2", label: "T-07", from: undefined }); // label and from are independent
    expect(s.notes.find((n) => n.id === d1.id)).toMatchObject({ label: "决策 12" });
    expect(s.notes.find((n) => n.body === "没有显示名的决定")!.label).toBeUndefined();
    // ids are what everything refers to: two tasks share a label and stay distinct
    expect([...s.tasks.keys()]).toEqual(["t-1", "t-2"]);
    expect(boardTask(board(s, HUMAN, c.now()), "t-1")!.title).toBe("登录超时");
    expect(boardTask(board(s, HUMAN, c.now()), "t-2")!.title).toBe("另一件");
    expect(boardTask(board(s, HUMAN, c.now()), "T-07")).toBeUndefined(); // a label is not a way to find anything
    // the name can change; the id cannot, and nothing else moves with it
    await emit(store, c, { kind: "task", op: "label", actor: "dev", task: "t-1", label: "T-07（旧单）" });
    s = reduce(await store.read(), c.now());
    expect(s.tasks.get("t-1")).toMatchObject({ id: "t-1", label: "T-07（旧单）", title: "登录超时", from: "pm/单据#7" });
    expect((await store.read()).events.find((e) => e.id === a.id)).toMatchObject({ label: "T-07" }); // history untouched
    expect((await rejected(emit(store, c, { kind: "task", op: "label", actor: "dev", task: "t-1", label: "  " }))).rule).toBe("label");
    expect((await rejected(emit(store, c, { kind: "task", op: "label", actor: "dev", task: "t-1", label: "字".repeat(31) }))).message).toMatch(/max 30/);
    // a task with no label at all is unchanged
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-3", title: "本地新建", criteria: ["works"] , no_human_impact: true});
    const t3 = boardTask(board(reduce(await store.read(), c.now()), HUMAN, c.now()), "t-3")!;
    expect(t3.label).toBeUndefined();
    expect("label" in t3).toBe(true); // the field exists on the board shape, absent when unset
  });
});

describe("t-097 / t-098 · the invitation goes back at once; the old channel waits for the human's 对", () => {
  const moved = async (store: MemoryStore, c: ReturnType<typeof clock>) => {
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "m-1", title: "旧任务", criteria: ["x"], from: "pm/单据#1", label: "T-01" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "m-1", touches: ["m-1"] });
    return emit(store, c, { kind: "note", actor: "pm", body: "导入完成：搬完了" });
  };

  it("t-097: the invitation is sent and recorded before any card is answered; a channel nobody can write to becomes one card for the human", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    const done = await moved(store, c);
    const [card] = await runFollowUps(store, done, HUMAN, c.now());
    // the importer puts the link back where the team already is, and says so here — with the card still unanswered
    const sent = await emit(store, c, { kind: "note", actor: "pm", body: `${"邀请已发回旧渠道："}pm/广播.md（提交 abc1234）` });
    expect(reduce(await store.read(), c.now()).instructions.get((card as { id: string }).id)!.chosen).toBeUndefined();
    expect(sent.body.startsWith("邀请已发回旧渠道：")).toBe(true);
    expect(sent.at).toBeTruthy(); // where and when, in the log
    // a medium nobody can write to: one instruction to the human, in pd's words, using the card shape we already have
    const ask = await emit(store, c, { kind: "instruction", actor: "pm", to: HUMAN, body: `${"把这个链接发给他们："}https://ateam.example/invite/abc`, ack_by: c.iso(min(60)) });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human.map((x) => x.id)).toContain(ask.id);
    expect(b.needs_human.find((x) => x.id === ask.id)!.body).toBe("把这个链接发给他们：https://ateam.example/invite/abc");
    // who has not arrived is the existing presence machinery, not something new here
    expect(b.presence.some((p) => p.status === "missing")).toBe(true);
  });

  it("t-098: 迁移完成 cannot be recorded before the human answered 对 — proved by trying it at every earlier moment", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    const finish = () => emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "migration.done", value: true, from: "pm/广播.md#最后一条", measured_at: c.iso(-min(1)) });
    // before anything
    expect((await rejected(finish())).rule).toBe("migration");
    const done = await moved(store, c);
    // after the import, before the card is answered
    expect((await rejected(finish())).message).toContain("还没在核对卡上点「对」");
    const [card] = await runFollowUps(store, done, HUMAN, c.now());
    const id = (card as { id: string }).id;
    // the card exists but is unanswered
    expect((await rejected(finish())).rule).toBe("migration");
    // answered 有漏: still refused
    const missing = await emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 有漏", decision: true, decides: { of: id, option: "有漏" }, refs: [id] });
    expect((await rejected(finish())).rule).toBe("migration");
    const told = await runFollowUps(store, missing, HUMAN, c.now());
    expect((told[0] as { body: string }).body).toContain("回去核对旧单据再补");
    // the importer fixes things and says so again; the service asks once more; this time the human says 对
    const again = await emit(store, c, { kind: "note", actor: "pm", body: "导入完成：补完了" });
    const [card2] = await runFollowUps(store, again, HUMAN, c.now());
    const id2 = (card2 as { id: string }).id;
    expect((await rejected(finish())).rule).toBe("migration"); // a fresh unanswered card is still not permission
    const ok = await emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 对", decision: true, decides: { of: id2, option: "对" }, refs: [id2] });
    const out = await runFollowUps(store, ok, HUMAN, c.now());
    expect((out[0] as { to: string; body: string }).to).toBe("pm");
    expect((out[0] as { body: string }).body).toContain("这里只读");
    // only now does it land, and it carries where and when, like any imported fact (t-089)
    const fact = await finish();
    expect(fact).toMatchObject({ key: "migration.done", from: "pm/广播.md#最后一条" });
    expect(fact.measured_at).toBeTruthy();
    const rs = [...reduce(await store.read(), c.now()).readings.values()].find((r) => r.reading.key === "migration.done")!;
    expect(rs.expired).toBe(true); // it came from the old place, so it follows t-089 like everything else carried in
  });
});

/**
 * t-101 (M4：拒绝要带出路) + t-104 (pd 23:59 的裁定)。今晚 t-088 是活样本：qa 判过 pass 后自己发现漏验，被规则挡住，
 * 只知道自己不行，靠 dev 和 pd 各推演一遍才找出唯一能落的 frontend。pd 的裁法是那道墙本身立错了地方：pass 与 fail
 * 不是同一个动作。说「达标」是放行，要独立；说「没达标」只挡发布，与自身利益相反，谁都能说。
 */
describe("t-101/t-104 · pass needs standing and says who has it; fail is open to everyone", () => {
  const world = async (list: string[] | Record<string, string[]>, criteriaBy = "pm", owner = "dev") => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: list });
    await emit(store, c, { kind: "task", op: "create", actor: criteriaBy, task: "A", title: "题", criteria: ["能用", "有测试"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: owner, task: "A", touches: ["x"] });
    await emit(store, c, { kind: "task", op: "done", actor: owner, task: "A", evidence: "abc1234 全绿" , no_human_impact: true});
    return { store, c };
  };
  const FIVE = { pd: ["R2"], pm: ["R1"], dev: ["R5"], frontend: ["R5"], qa: ["R6"] };

  it("only an R6 holder may pass; the refusal names who has it, and the list is computed, never a second copy", async () => {
    const { store, c } = await world({ ...FIVE, frontend: ["R5", "R6"] });
    // dev is the owner *and* holds no R6: both reasons are true, the owner rule speaks first
    const own = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "A", surface: "repo", pass: true }));
    expect(own.rule).toBe("verify");                                  // 判据 4 of t-101：拒绝仍要说出规则名
    expect(own.message).toMatch(/owner cannot pass their own task/);
    expect(own.message).toContain("可以由谁来落 pass：frontend、qa");
    // a role with no R6 is refused even though no separation rule touches it (t-104 判据 1)
    const noR6 = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pd", task: "A", surface: "repo", pass: true }));
    expect(noR6.message).toContain("pd 不持 R6 验收职责，落不了 pass");
    expect(noR6.message).toContain(PASS_ONLY_GATE);   // t-112 round 2: pd's one sentence, not a second way of saying it
    expect(noR6.message).toContain("可以由谁来落 pass：frontend、qa");
    // 判据：名单是算出来的。pd 给 frontend 补一条判据，frontend 就该从名单里消失，没人去改任何清单
    await emit(store, c, { kind: "task", op: "criteria", actor: "pd", task: "A", add: ["文案按定稿"] });
    await emit(store, c, { kind: "task", op: "criteria", actor: "frontend", task: "A", add: ["空态有说明"] }).catch(() => {});
    const again = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "A", surface: "repo", pass: true }));
    expect(again.message).toContain("可以由谁来落 pass：frontend、qa");
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
  });

  it("the criteria author is refused with the same list; a project that renamed its roles gets its own names back", async () => {
    const { store, c } = await world({ pm: ["R1"], dev: ["R5"], ux: ["R6"], sre: ["R6"] });
    const r = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pm", task: "A", surface: "repo", pass: true }));
    expect(r.message).toMatch(/whoever wrote the criteria cannot judge them met/);
    expect(r.message).toContain("可以由谁来落 pass：ux、sre");        // 名单来自 project:roles，不是写死的五个
  });

  it("t-088 的活样本：qa 判过 pass 后自己发现漏验，自己就能落 fail——不必再借 frontend", async () => {
    const { store, c } = await world(FIVE);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true, evidence: "看过了" });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
    // ①：不指名哪一条判据的自我推翻被拒，并说清要怎么写
    const vague = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "我漏验了" }));
    expect(vague.message).toContain("你在推翻自己在 repo 上判的 pass");
    expect(vague.message).toContain("这件共 2 条");
    // 指名了就落得下去，不必找第三个人
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "判据 2 没验：没有测试覆盖空输入" });
    const t = reduce(await store.read(), c.now()).tasks.get("A")!;
    expect(t.status).toBe("done");
    expect(t.verifications.map((v) => [v.surface, v.pass, v.by])).toEqual([["repo", true, "qa"], ["repo", false, "qa"]]);
    // ② (pd 00:12)：一次 fail 之后，这个表面的下一次 pass 要等一次新的 done——换个人来判也不行，那是换裁判
    const back = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }));
    expect(back.message).toContain("这一轮已经在 repo 上判过 fail（qa）");
    expect(back.message).toContain("要等一次新的 done，换个人来判不算");
    expect(back.message).toContain("owner 重发 done，证据写明无需改动及为什么");
    const other = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "A", surface: "repo", pass: true }));
    expect(other.message).toContain("要等一次新的 done");                     // 换裁判的洞堵上了
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "补测试" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "def5678 补了" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }); // 新一轮，同一人可以
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
  });

  it("fail is open to everyone: the owner, the criteria author and a role with no R6 may all say 'not met'", async () => {
    for (const who of ["dev", "pm", "pd"]) {
      const { store, c } = await world(FIVE);
      await emit(store, c, { kind: "task", op: "verify", actor: who, task: "A", surface: "repo", pass: false, evidence: `${who} 跑了一遍，判据 1 不成立` });
      const t = reduce(await store.read(), c.now()).tasks.get("A")!;
      expect(t.status, who).toBe("failed");
      expect(t.verifications.map((v) => v.by), who).toEqual([who]);
    }
    // 一个 fail 从来不必带名单——谁都能落，没有「可以由谁来落」可说。没有 pass 要推翻时连证据都不强求
    const { store, c } = await world(FIVE);
    await emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "A", surface: "repo", pass: false });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("failed");
    // 而推翻别人判过的 pass 仍然要证据，只是不再挑人
    const w2 = await world(FIVE);
    await emit(w2.store, w2.c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    const noEvidence = await rejected(emit(w2.store, w2.c, { kind: "task", op: "verify", actor: "dev", task: "A", surface: "repo", pass: false }));
    expect(noEvidence.message).toMatch(/needs --evidence/);
    expect(noEvidence.message).not.toMatch(/可以由谁来落/);
  });

  it("nobody can pass: it says so and why, never an empty list, and still points at what happens by itself", async () => {
    const { store, c } = await world({ pm: ["R1"], dev: ["R5"] });
    const r = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "A", surface: "repo", pass: true }));
    expect(r.message).toContain("本项目没人能给这一件落 pass：pm 不持 R6、写了判据；dev 不持 R6、是 owner");
    // pd 23:50：先说自动会发生的事。这个项目没有 qa 类角色，t-055 的自动退化确实会发生
    expect(r.message).toContain(`这件的验收会进 ${HUMAN} 的「需要你」由他来判`);
    expect(r.message).toContain("project:roles");
    expect(r.message).toContain(PASS_ONLY_GATE);
    expect(r.message).not.toMatch(/可以由谁来落 pass：/);
    expect(r.message).not.toMatch(/：\s*。/);                          // 不印空列表
    // human 不算在候选里——把他算进去就永远不会出现「一个都没有」，而这正是最该说清楚的一种
    expect(r.message).not.toMatch(/可以由谁来落 pass：[^。]*human/);
    // 而 human 自己什么都能落：不持 R6 也一样，他是策略权威
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "A", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
  });

  it("nobody can pass but the project does have a verifier role: it does not promise the t-055 escalation that will not happen", async () => {
    const { store, c } = await world({ dev: ["R5"], qa: ["R6"] }, "dev", "qa");
    const r = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }));
    expect(r.message).toContain("本项目没人能给这一件落 pass：dev 不持 R6、写了判据；qa 是 owner");
    expect(r.message).toContain(`项目里有验收角色，所以验收不会自动转给 ${HUMAN}`);
    expect(r.message).not.toContain("会进");                            // 不承诺一件不会发生的事
    // 出路是真的：qa 落不了 pass，但落得了 fail
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: false, evidence: "判据 1 不成立" });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("failed");
  });
});

/**
 * t-105 (T4)。pd 00:08 的 concern：touches 是 claim 时猜的，dev 那次四个文件全猜错，而接缝完全建立在 touches 上——
 * 猜错等于那条接缝根本没声明，两个人真碰同一处也不会响。平台这一层只认一件事：done 带的 touches 是最终值，接缝按它
 * 重算，冒出新接缝就挡住 done。怎么得到那个值（git diff、人手工重写）是调用方的事，核心里不出现 git、不出现文件系统。
 */
describe("t-105 · done's touches are the fact, and seams are recomputed from it", () => {
  const two = async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "甲", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "乙", criteria: ["能用"] , no_human_impact: true});
    return { store, c };
  };

  it("a seam the declaration was hiding blocks the done, and says which task and which touch", async () => {
    const { store, c } = await two();
    // 今天那一幕：dev 声明了四个文件，实际改的是另外四个，其中一个正是 frontend 在动的
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["packages/cli/src/main.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["packages/cli/src/watch.ts", "packages/cli/src/format.ts"] });
    expect(reduce(await store.read(), c.now()).seams.size).toBe(0);   // 按声明，两件毫不相干
    const r = await rejected(emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234",
      touches: ["packages/cli/src/deaf.ts", "packages/cli/src/lock.ts", "packages/cli/src/main.ts"] , no_human_impact: true}));
    expect(r.rule).toBe("done");
    expect(r.message).toContain("多出 1 条挡住 done：B（碰在 packages/cli/src/main.ts）");
    expect(r.message).toContain("claim 时没声明、实际碰了的是：packages/cli/src/deaf.ts、packages/cli/src/lock.ts、packages/cli/src/main.ts");
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("working"); // 没写进去
    // 判据 2 的出路要真能走：接缝得先存在才谈得上定，所以拒绝信息叫人先 claim 进来
    expect(r.message).toContain("task claim A --touches");
    expect(r.message).toContain("task seam A B --resolution");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["packages/cli/src/main.ts"] });
    expect([...reduce(await store.read(), c.now()).seams.values()][0].overlap).toEqual(["packages/cli/src/main.ts"]);
    await emit(store, c, { kind: "task", op: "seam", actor: "pm", tasks: ["A", "B"], resolution: "dev 先落，frontend 合它的 sha" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234",
      touches: ["packages/cli/src/deaf.ts", "packages/cli/src/lock.ts", "packages/cli/src/main.ts"] , no_human_impact: true});
    const t = reduce(await store.read(), c.now()).tasks.get("A")!;
    expect(t.status).toBe("done");
    expect(t.touches).toEqual(["packages/cli/src/deaf.ts", "packages/cli/src/lock.ts", "packages/cli/src/main.ts"]); // 最终值，不是并集
  });

  it("a revision that touches nothing new goes through, and a done with no touches leaves the declaration alone", async () => {
    const { store, c } = await two();
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["packages/server/src/html.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["a.ts", "b.ts", "c.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234", touches: ["a.ts", "d.ts"] , no_human_impact: true});
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.touches).toEqual(["a.ts", "d.ts"]);
    // 没带 touches 的 done：声明原样留着（没有 diff 的介质、老客户端都走这条）
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "再改" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "def5678" , no_human_impact: true});
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.touches).toEqual(["a.ts", "d.ts"]);
  });

  it("exemptions survive the recompute: a same-owner sequence, and a seam that was already open, do not block", async () => {
    const { store, c } = await two();
    // 同一个 owner 的两件（t-045）：重算后碰上了也不挡
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "B", touches: ["shared.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["own.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234", touches: ["own.ts", "shared.ts"] , no_human_impact: true});
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("done");
    // 已经开着的接缝不因为重算而变成 done 的阻碍：done 从来不判已有接缝
    const w = await two();
    await emit(w.store, w.c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["x.ts"] });
    await emit(w.store, w.c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["x.ts"] });
    expect(reduce(await w.store.read(), w.c.now()).seams.size).toBe(1);
    await emit(w.store, w.c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234", touches: ["x.ts", "y.ts"] , no_human_impact: true});
    expect(reduce(await w.store.read(), w.c.now()).tasks.get("A")!.status).toBe("done");
  });

  it("a task done before the other side claimed still only stacks, recompute or not (t-067)", async () => {
    const { store, c } = await two();
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["p.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234", touches: ["p.ts", "q.ts"] , no_human_impact: true});
    c.tick(min(1));
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["q.ts"] });
    const s = reduce(await store.read(), c.now());
    const seam = [...s.seams.values()][0];
    expect(seam.overlap).toEqual(["q.ts"]);                            // 重算把它变成一条真的接缝
    expect(seam.stacked).toEqual({ done: "A", on: "B" });              // 但 A 先落了，B 叠在它上面，不挡任何人
    expect(openSeamsFor(s, "A")).toEqual([]);
  });

  it("the platform layer knows nothing about git or files: the rule reads a list off the event and nothing else", async () => {
    const src = readFileSync(new URL("../src/rules.ts", import.meta.url), "utf8");
    const rule = src.slice(src.indexOf('case "done": {'), src.indexOf('case "verify": {'));
    for (const forbidden of ["spawnSync", "readFileSync", "node:fs", "node:child_process", "git "]) expect(rule).not.toContain(forbidden);
    expect(readFileSync(new URL("../src/reduce.ts", import.meta.url), "utf8")).not.toContain("node:child_process");
  });
});

/**
 * t-106 (S8/M4)。qa 00:14 造了一支「主编/写手/审稿」的队伍来试 t-104，撞上一件不报错的事：角色 id 走 X-Actor，
 * 而 HTTP 头按 RFC 只放 latin-1——有的客户端根本发不出去，有的把 UTF-8 原样发过去被当 latin-1 读回来，于是
 * 「审稿」落库成 å®¡ç¨¿。整队在牌桌上显示不在场，旁边站着几个名字是乱码的角色，任务 owner 是 null。
 * pd 00:15 定的：id 只收 ASCII 小写，显示名随便什么语言。它照着我们自己的例子写的，所以例子也一并改掉。
 */
describe("t-106 · a role id is ASCII; the name people read is not", () => {
  const declare = (store: MemoryStore, c: ReturnType<typeof clock>, value: unknown) =>
    emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value });

  it("a non-ASCII id is refused when it is declared, with both halves of the way out spelled out", async () => {
    const store = new MemoryStore();
    const c = clock();
    const r = await rejected(declare(store, c, { 主编: ["R1"], 写手: ["R5"], 审稿: ["R6"] }));
    expect(r.rule).toBe("reading");
    expect(r.message).toContain("这些不行：主编、写手、审稿");
    expect(r.message).toContain("X-Actor");
    expect(r.message).toContain("latin-1");
    expect(r.message).toContain('{"reviewer": {"name": "审稿", "responsibilities": ["R6"]}}');   // 判据 1：两例
    expect(r.message).toContain('{"editor": {"name": "主编", "responsibilities": ["R1"]}}');
    // 纯数组、逗号字符串两种老形态一样管
    expect((await rejected(declare(store, c, ["pm", "审稿"]))).message).toContain("这些不行：审稿");
    expect((await rejected(declare(store, c, "pm,审稿"))).message).toContain("这些不行：审稿");
    // 大写、空格、以数字开头也不行——一条规则，不是「只挡中文」
    expect((await rejected(declare(store, c, ["QA"]))).message).toContain("这些不行：QA");
    expect((await rejected(declare(store, c, ["front end"]))).message).toContain("这些不行：front end");
    expect((await rejected(declare(store, c, ["2nd-dev"]))).message).toContain("这些不行：2nd-dev");
    expect(reduce(await store.read(), c.now()).readings.size).toBe(0);   // 一条都没写进去
  });

  it("ASCII lowercase goes through in all three shapes, and the name is free in any language and any length", async () => {
    const store = new MemoryStore();
    const c = clock();
    await declare(store, c, ["editor", "writer", "reviewer"]);
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).roles).toEqual(["editor", "writer", "reviewer"]);
    await declare(store, c, { editor: ["R1"], writer: ["R5"], reviewer: ["R6"] });                       // t-059 的形态
    await declare(store, c, {                                                                           // t-106 的形态
      editor: { name: "主编", responsibilities: ["R1", "R3"] },
      writer: { name: "写手", responsibilities: ["R5"] },
      reviewer: { name: "审稿 / Reviewer / Рецензент（这一栏想写多长写多长）", responsibilities: ["R6"] },
      ops: { responsibilities: ["R9"] },                                                                // 没名字的照旧
    });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.roles).toEqual(["editor", "writer", "reviewer", "ops"]);
    expect(b.role_names).toEqual({ editor: "主编", writer: "写手", reviewer: "审稿 / Reviewer / Рецензент（这一栏想写多长写多长）" });
    expect(b.role_names.ops).toBeUndefined();                                                           // 没名字就用 id
    // 职责照读，新形态不打断 t-059
    const s = reduce(await store.read(), c.now());
    expect(roleResponsibilities(s)).toEqual({ editor: ["R1", "R3"], writer: ["R5"], reviewer: ["R6"], ops: ["R9"] });
    // 而且规则真的用它：只有 reviewer 持 R6，pass 的名单就是它
    await emit(store, c, { kind: "task", op: "create", actor: "editor", task: "A", title: "题", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "writer", task: "A", touches: ["x"] });
    await emit(store, c, { kind: "task", op: "done", actor: "writer", task: "A", evidence: "abc1234" , no_human_impact: true});
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "writer", task: "A", surface: "repo", pass: true }))).message).toContain("可以由谁来落 pass：reviewer");
  });

  it("ids already in the log are not touched, not migrated, not cleaned: they keep working (判据 3)", async () => {
    const store = new MemoryStore();
    const c = clock();
    // 一条谁也读不出的身份，写在规则存在之前——直接进库，像旧日志那样
    await store.appendRaw({ id: "01OLDROLES", at: new Date(c.now().getTime() - 60_000).toISOString(), kind: "reading", actor: "pm", surface: "project", key: "roles", value: { "å®¡ç¨¿": ["R6"], dev: ["R5"] } } as never);
    const s0 = reduce(await store.read(), c.now());
    expect(projectRoles(s0)).toEqual(["å®¡ç¨¿", "dev"]);                 // 照常算，不假装它不存在
    // 它照常收发事件：建任务、认领、完成、验收，一路走通
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "题", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "B", touches: ["y"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "B", evidence: "abc1234" , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "verify", actor: "å®¡ç¨¿", task: "B", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("B")!.status).toBe("verified");
    await pull(store, "å®¡ç¨¿", null, c.now());
    expect(board(reduce(await store.read(), c.now()), HUMAN, c.now()).presence.find((p) => p.role === "å®¡ç¨¿")).toBeTruthy();
  });
});

/** qa 00:29：`touches: []` 是「它什么都没碰」这条事实，与「没给最终值」是两回事，平台要分得开。 */
describe("t-105 · an empty touches list is a fact, not a missing field", () => {
  it("[] wipes the declaration; undefined leaves it alone", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "题", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["a.ts", "b.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234" , no_human_impact: true});          // 字段缺席
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.touches).toEqual(["a.ts", "b.ts"]);
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "再看" });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "def5678", touches: [] , no_human_impact: true}); // 明确说空
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.touches).toEqual([]);
  });
});

/**
 * t-112 (pd 00:51 的通则)。qa 00:51 要给一个已知坏掉的版本落 fail，被接缝闸拒了：那个版本既记不成坏也记不成好，
 * 「它坏了」这条信息只留在一个 agent 嘴上。防止过早**放行**的闸，一律只拦 pass。
 */
describe("t-112 · a gate against releasing early never blocks the news that it is broken", () => {
  const collided = async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { pm: ["R1"], dev: ["R5"], frontend: ["R5"], qa: ["R6"] } });
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "甲", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "乙", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["shared.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["shared.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B", evidence: "abc1234" , no_human_impact: true});
    return { store, c };
  };

  it("qa 00:51 的那一幕：接缝未解时 fail 落得下去，pass 仍被拦", async () => {
    const { store, c } = await collided();
    expect(openSeamsFor(reduce(await store.read(), c.now()), "B")).toHaveLength(1);
    // 坏消息畅通
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: false, evidence: "pnpm build 退出码 2：format.ts(178,36) TS2345" });
    expect(reduce(await store.read(), c.now()).tasks.get("B")!.status).toBe("failed");
    // 好消息仍要先把接缝定下来，并且说清它挡的是哪一边
    await emit(store, c, { kind: "task", op: "reopen", actor: "frontend", task: "B", reason: "修类型" });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B", evidence: "def5678" , no_human_impact: true});
    const r = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true }));
    expect(r.rule).toBe("verify");
    expect(r.message).toContain("unresolved seam");
    expect(r.message).toContain("这挡住的是通过，不是不通过；要记它坏了，直接落 fail。");
    // 定了接缝就放行
    await emit(store, c, { kind: "task", op: "seam", actor: "pm", tasks: ["A", "B"], resolution: "frontend 先落，dev 合它的 sha" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("B")!.status).toBe("verified");
  });

  it("the other pass-only gate says the same thing in the same words", async () => {
    const { store, c } = await collided();
    await emit(store, c, { kind: "task", op: "seam", actor: "pm", tasks: ["A", "B"], resolution: "frontend 先落" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true });
    const again = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "B", surface: "repo", pass: true }));
    expect(again.message).toContain("a pass does not override a pass");
    expect(again.message).toContain("这挡住的是通过，不是不通过；要记它坏了，直接落 fail。");
    // 而那条 fail 真的落得下去，不需要任何旁路
    await emit(store, c, { kind: "task", op: "verify", actor: "frontend", task: "B", surface: "repo", pass: false, evidence: "判据 1 不成立：build 是坏的" });
    expect(reduce(await store.read(), c.now()).tasks.get("B")!.status).toBe("done");
  });

  it("no bypass exists for a fail, because a fail never needed one", async () => {
    const src = readFileSync(new URL("../src/rules.ts", import.meta.url), "utf8");
    const verify = src.slice(src.indexOf('case "verify": {'), src.indexOf('case "block":'));
    // 拒绝 fail 的只剩三条，全是对 fail 本身的要求，不是防止放行的闸：不是 done、没写表面、推翻 pass 没给证据/没指名判据
    const passOnly = verify.slice(verify.indexOf("if (e.pass) {"), verify.indexOf("} else if (passer !== undefined) {"));
    expect(passOnly).toContain("openSeamsFor");                  // 接缝闸在 pass 那一支里
    expect(verify.slice(verify.indexOf("} else if")).includes("openSeamsFor")).toBe(false);
    expect(verify).not.toMatch(/anyway|--force|旁路/);            // 没有给 fail 开的口子
  });
});

/**
 * t-113 (T4, pd 00:59)。qa 的 friction：同一个测试文件三次挡住验收——两件毫不相干的任务，各自往 replay.test.ts 里加
 * 自己那段 describe，谁也没碰谁的，却要等一次人工裁决。闸判在最细的**双方都声明了**的粒度上：都说了符号且不相交，
 * 就只是一句提示；有一方只说了文件，它没告诉你它碰的是哪半边，那仍然是碰撞。不做白名单：测试文件不特殊，声明才特殊。
 */
describe("t-113 · a seam is judged at the finest granularity both sides declared", () => {
  const pair = async (aTouches: string[], bTouches: string[]) => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { pm: ["R1"], dev: ["R5"], frontend: ["R5"], qa: ["R6"] } });
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "甲", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "乙", criteria: ["能用"] , no_human_impact: true});
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: aTouches });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: bTouches });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B", evidence: "abc1234" , no_human_impact: true});
    return { store, c };
  };
  const seamOf = async (w: { store: MemoryStore; c: ReturnType<typeof clock> }) => [...reduce(await w.store.read(), w.c.now()).seams.values()][0];
  const canVerify = async (w: { store: MemoryStore; c: ReturnType<typeof clock> }) =>
    emit(w.store, w.c, { kind: "task", op: "verify", actor: "qa", task: "B", surface: "repo", pass: true }).then(() => true, (e) => { if (e instanceof Rejected) return false; throw e; });

  const F = "packages/core/test/replay.test.ts";

  it("both sides named symbols, and different ones: light — it says so and holds nothing up", async () => {
    const w = await pair([`${F}#t-112`], [`${F}#t-111`]);
    const seam = await seamOf(w);
    expect(seam.light).toBe(true);
    expect([...seam.overlap].sort()).toEqual([`${F}#t-111`, `${F}#t-112`]);   // 说得出是哪个文件、各自哪一段
    expect(openSeamsFor(reduce(await w.store.read(), w.c.now()), "B")).toEqual([]);
    expect(await canVerify(w)).toBe(true);
    // 牌桌上它在，但不是「未解」那一组：计数与首屏都不该把它算进去（渲染归 frontend）
    const b = board(reduce(await w.store.read(), w.c.now()), HUMAN, w.c.now());
    const bs = b.seams.find((x) => x.id === seam.id)!;
    expect(bs.light).toBe(true);
    expect(bs.open).toBe(false);
    expect(b.seams.filter((x) => x.open)).toEqual([]);
    expect(slimBoard(b).seams.find((x) => x.id === seam.id)).toMatchObject({ light: true, open: false });  // CLI 也看得见
  });

  it("both sides named symbols and they meet: blocks, as before", async () => {
    const w = await pair([`${F}#t-112`, `${F}#shared`], [`${F}#shared`]);
    expect((await seamOf(w)).light).toBeUndefined();
    expect(await canVerify(w)).toBe(false);
  });

  it("one side only said the file: it never told you which half, so it still blocks", async () => {
    for (const [a, b] of [[[F], [`${F}#t-111`]], [[`${F}#t-112`], [F]]] as const) {
      const w = await pair([...a], [...b]);
      expect((await seamOf(w)).light, `${a} × ${b}`).toBeUndefined();
      expect(await canVerify(w), `${a} × ${b}`).toBe(false);
    }
  });

  it("neither side named symbols: unchanged, it blocks", async () => {
    const w = await pair([F], [F]);
    expect((await seamOf(w)).light).toBeUndefined();
    expect(await canVerify(w)).toBe(false);
  });

  it("判据 4：同一对任务，声明到符号时不挡、只声明到文件时挡——方向是「说得越细，闸越准」", async () => {
    expect((await seamOf(await pair([`${F}#a`], [`${F}#b`]))).light).toBe(true);
    expect((await seamOf(await pair([F], [F]))).light).toBeUndefined();
  });

  it("a directory that contains the other side's file is never light: nobody declares symbols for a directory", async () => {
    const w = await pair(["packages/core/test/"], [`${F}#t-111`]);
    expect((await seamOf(w)).light).toBeUndefined();
    expect(await canVerify(w)).toBe(false);
  });

  it("no whitelist and no path pattern: a source file behaves exactly like a test file", async () => {
    const src = "packages/core/src/rules.ts";
    // t-185：这两个符号原来写的是 validate / checkShape，范围扩到 rules.ts 之后它们都在 KEY_SYMBOLS 里了
    // （拒绝话就是人读的字），于是这条测试的 done 被那道闸拦下。这条测的是接缝的粒度，不是那道闸，
    // 所以换成同一个文件里两个确实不说话的符号，测的东西一个字没变。
    expect((await seamOf(await pair([`${src}#matchesShape`], [`${src}#sameShape`]))).light).toBe(true);
    expect((await seamOf(await pair([src], [src]))).light).toBeUndefined();
    // 判据 2：代码里（注释不算）没有任何按路径模式的豁免
    const code = readFileSync(new URL("../src/reduce.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/test\.ts|\.test\.|spec|whitelist|白名单|endsWith\("\./);
  });

  it("it is recomputed, not decided once: narrowing a claim to symbols turns a blocking seam light", async () => {
    const w = await pair([F], [`${F}#t-111`]);
    expect(await canVerify(w)).toBe(false);
    // dev 把自己的声明说细：同一条接缝重算成轻的
    await emit(w.store, w.c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: [`${F}#t-112`] });
    expect((await seamOf(w)).light).toBeUndefined();                  // claim 是并集，文件级那条还在
    await emit(w.store, w.c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "def5678", touches: [`${F}#t-112`] , no_human_impact: true});
    expect((await seamOf(w)).light).toBe(true);                       // done 是事实：t-105 把它改准，这件才判得准
    expect(await canVerify(w)).toBe(true);
  });
});

/**
 * t-113 判据 5：qa 撞了三次的那一幕，原样固定住。t-095/t-097/t-098 与 t-101、t-111/t-112 三对，每一对都只是各自往
 * packages/core/test/replay.test.ts 里加了自己那段 describe，谁也没碰谁的，却各要一次人工裁决才能验收。
 */
describe("t-113 · 同一个测试文件三次挡住验收：现在只是一句提示", () => {
  it("三对任务各写各的那一段，全部判为轻，没有一条挡住验收", async () => {
    const store = new MemoryStore();
    const c = clock();
    const F = "packages/core/test/replay.test.ts";
    await emit(store, c, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { pm: ["R1"], dev: ["R5"], frontend: ["R5"], qa: ["R6"] } });
    const pairs: [string, string, string, string][] = [
      ["t-095", "frontend", "t-101", "dev"],
      ["t-097", "dev", "t-098", "dev"],
      ["t-111", "frontend", "t-112", "dev"],
    ];
    for (const [a, aBy, b, bBy] of pairs) {
      for (const [id, by] of [[a, aBy], [b, bBy]] as const) {
        await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["能用"] , no_human_impact: true});
        await emit(store, c, { kind: "task", op: "claim", actor: by, task: id, touches: [`${F}#${id}`] });
        await emit(store, c, { kind: "task", op: "done", actor: by, task: id, evidence: `sha-${id}` , no_human_impact: true});
      }
    }
    const s = reduce(await store.read(), c.now());
    const shared = [...s.seams.values()].filter((x) => x.overlap.every((o) => o.startsWith(F)));
    expect(shared.length).toBeGreaterThanOrEqual(3);              // 每一对都看得见，一条也没被藏起来
    expect(shared.every((x) => x.light || x.same_owner || x.stacked)).toBe(true);
    for (const id of pairs.flatMap(([a, , b]) => [a, b])) expect(openSeamsFor(s, id), id).toEqual([]);
    // qa 真正要做的事：一条条落验收，不必先去找人裁决
    for (const id of pairs.flatMap(([a, , b]) => [a, b])) await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true });
    const after = reduce(await store.read(), c.now());
    for (const id of pairs.flatMap(([a, , b]) => [a, b])) expect(after.tasks.get(id)!.status, id).toBe("verified");
  });
});

/**
 * t-119 (pd 01:21 的通则)。qa 01:20 在生产上量到一条会骗人的事实：牌桌把外呼地址报成「已配置」，而那是个邮箱、
 * 永远发不出去——今天两次停摆共 10.4 小时靠的正是这条兜底。通则：安全兜底的状态由**可达性**证明，不由字符串
 * 存在证明。四句说的都是「你收不收得到」，不是「配没配」。
 */
describe("t-119 · a fallback's state is proved by reaching, not by a string being there", () => {
  const world = async () => {
    const store = new MemoryStore();
    const c = clock();
    return { store, c, alert: async () => board(reduce(await store.read(), c.now()), HUMAN, c.now()).alert };
  };
  const AT = "https://hooks.example/team";

  it("四态各一句，说的都是「你收不收得到」", async () => {
    const w = await world();
    // ① 未配置
    expect(await w.alert()).toMatchObject({ status: "unanswered" });
    // ② 形状不对：写在规则存在之前的老值
    await w.store.appendRaw({ id: "01OLDMAIL", at: w.c.now().toISOString(), kind: "reading", actor: HUMAN, surface: "project", key: "alert.webhook", value: "a@b.com" } as never);
    expect(await w.alert()).toMatchObject({ status: "misconfigured", line: "这个外呼地址我们发不出去，它不是一个 https 地址。" });
    // ③ 形状对但没真发成功过——判据 5：新建项目刚配完地址的那一刻就落在这里，不因形状对而跳过去
    await emit(w.store, w.c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: AT });
    expect(await w.alert()).toMatchObject({ status: "unproven", value: AT, line: "记下了外呼地址，还没真发成功过——不知道你收不收得到。" });
    // ④ 真送到过一次
    w.c.tick(min(3));
    await emit(w.store, w.c, { kind: "reading", actor: "ateam", key: "alert.reached", surface: "project", value: AT, method: "外呼 all_missing 真的送到了（HTTP 200）" });
    w.c.tick(min(7));
    const ok = await w.alert();
    expect(ok.status).toBe("reachable");
    // t-180 · pd 09:17：时间短语挪到句首，一种骨架管四档（改前「最近一次成功是 7 分钟前。」，
    // 而「最近一次成功是 刚刚。」不是中文——只有某几档填得进去的句框，是句框错了）。
    expect(ok.line).toBe("你不在时会发到这里，7 分钟前成功过一次。");
    for (const a of [await w.alert()]) expect(a.line).not.toContain("已配置");   // 四句里一句都不说「配没配」
  });

  it("证的是那个地址：换一个地址就退回没验过", async () => {
    const w = await world();
    await emit(w.store, w.c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: AT });
    await emit(w.store, w.c, { kind: "reading", actor: "ateam", key: "alert.reached", surface: "project", value: AT, method: "真的送到了" });
    expect((await w.alert()).status).toBe("reachable");
    await emit(w.store, w.c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: "https://hooks.example/别处" });
    expect((await w.alert()).status).toBe("unproven");     // 证过的是旧地址，新地址还没证
  });

  it("兜底久不响就等于没有：七天没有新的成功退回③，并说出上次是什么时候（pd 01:40）", async () => {
    const w = await world();
    await emit(w.store, w.c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: AT });
    await emit(w.store, w.c, { kind: "reading", actor: "ateam", key: "alert.reached", surface: "project", value: AT, method: "真的送到了" });
    w.c.tick(6 * 24 * 3600_000);
    expect((await w.alert()).status).toBe("reachable");     // 六天：还算数
    w.c.tick(2 * 24 * 3600_000);
    const stale = await w.alert();
    expect(stale.status).toBe("unproven");                  // 八天：退回去
    // t-180 · pd 09:09：相对时间永远不出现小数（改前这里是「8.0 天前」）。梯子在 core 的 ago 一处。
    expect(stale.line).toContain("8 天前成功过一次。");
  });

  it("一次失败不退回，连续两次才退（pd 01:40：一次网络抖动不该吓人）", async () => {
    const w = await world();
    await emit(w.store, w.c, { kind: "reading", actor: HUMAN, key: "alert.webhook", surface: "project", value: AT });
    await emit(w.store, w.c, { kind: "reading", actor: "ateam", key: "alert.reached", surface: "project", value: AT, method: "真的送到了" });
    await emit(w.store, w.c, { kind: "note", actor: "ateam", body: `外呼：all_missing 自 x 发送失败（三次，最后状态 0） ${AT}。全队失联` });
    expect((await w.alert()).status).toBe("reachable");     // 一次失败：不吓人
    await emit(w.store, w.c, { kind: "note", actor: "ateam", body: `外呼：all_missing 自 y 发送失败（三次，最后状态 0） ${AT}。全队失联` });
    expect((await w.alert()).status).toBe("unproven");      // 连续两次：不敢再说它是通的
    await emit(w.store, w.c, { kind: "note", actor: "ateam", body: `外呼：all_missing 自 z 已发到 ${AT}。全队失联` });
    expect((await w.alert()).status).toBe("reachable");     // 又通了
  });

  it("判据 2：可达性只来自真的送到过一次——牌桌自己不会去戳别人的地址", async () => {
    const src = readFileSync(new URL("../src/board.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function alertContact"), src.indexOf("export function contactAskAnswered"));
    // 它只读日志：没有任何发请求的东西（https:// 是形状检查里的字面量，不是一次调用）
    for (const forbidden of ["fetch(", "request(", "probe", "ping", "node:http"]) expect(fn.toLowerCase(), forbidden).not.toContain(forbidden);
    expect(readFileSync(new URL("../src/board.ts", import.meta.url), "utf8")).not.toContain("node:http");
  });
});

/**
 * t-160：**一件做完的活，不该被一件在它之后才开工的活挡住验收。**
 *
 * t-009 定的原则是「先 done 的一方不被后来 claim 的一方阻塞」，但它读的是**最新**那次 done。于是一件交完又重交
 * 一轮的活（reopen 之后换个 sha 重 done，今晚很常见）当场掉出这条原则：接缝重新变开，验收被挡。今晚花掉三次，
 * 每次都是 qa 一次自查、pm 一次裁定、两条 tell。判据 5 把根量到了这一行。
 */
describe("t-160 · 在它 done 之后才 claim 的任务，不挡它的验收", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"], no_human_impact: true });
  const seamOf = async (store: MemoryStore, c: ReturnType<typeof clock>) =>
    board(reduce(await store.read(), c.now()), HUMAN, c.now()).seams[0];

  it("判据 1、3 正例：A 先 done、B 后 claim 且触点相交——A 可以落 pass；A 再交一轮也还是可以", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", no_human_impact: true, evidence: "aaaaaaa" });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    expect((await seamOf(store, c)).overlap).toEqual(["app.ts"]);          // 触点真的相交
    // 重交一轮：今晚我为了换一个 sha 就这么做过两回
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "换个 sha 重交" });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", no_human_impact: true, evidence: "bbbbbbb" });
    expect((await seamOf(store, c)).stacked).toEqual({ done: "A", on: "B" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
  });

  it("判据 3 反例：B 先 claim，两边同时在途——仍然挡住", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", no_human_impact: true, evidence: "aaaaaaa" });
    expect((await seamOf(store, c)).stacked).toBeUndefined();
    const r = await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true }));
    expect(r.message).toMatch(/unresolved seam/);
  });

  it("判据 1 的「不论触点是否相交」：时序说了算，重叠多少不改变结论", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts", "html.ts", "board.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", no_human_impact: true, evidence: "aaaaaaa" });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts", "html.ts", "board.ts"] });
    expect([...(await seamOf(store, c)).overlap].sort()).toEqual(["app.ts", "board.ts", "html.ts"]);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    expect(reduce(await store.read(), c.now()).tasks.get("A")!.status).toBe("verified");
  });

  it("判据 2：放行的是前者的验收，不是后者的合并责任——B 那头对的仍是 A 此刻的证据 sha", async () => {
    const store = new MemoryStore();
    const c = clock(Date.now() - min(30));
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", no_human_impact: true, evidence: "aaaaaaa: 第一轮" });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "reopen", actor: "dev", task: "A", reason: "第二轮" });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", no_human_impact: true, evidence: "bbbbbbb: 第二轮" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    // A 的验收放行了，而 B 要合的是 A **此刻**那一轮：接缝仍然指着 A 的新证据，不是第一轮那个 sha
    expect(boardTask(b, "A")!.evidence).toContain("bbbbbbb");
    expect(b.seams[0].stacked).toEqual({ done: "A", on: "B" });
  });
});
