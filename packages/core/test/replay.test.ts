/**
 * Replay of the 2026-09-05 field report ("Git 总线上的五个 Agent").
 * Each test is one failure mode from that day. The tool must make it impossible or visible.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, pull, reduce, board, surfaceResults, evidenceSha, splitTitle, manual, manualRoles, isMissing, Rejected, SAID_PREFIX, DEFER_PREFIX, type NewEvent, type Event } from "../src/index.js";

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
    expect(b.instructions[0].status).toBe("overdue");
    // overdue is the team's problem, not a question for the human
    expect(b.overdue.map((x) => x.instruction)).toEqual([order.id]);
    expect(b.overdue[0]).toMatchObject({ to: "backend", from: "pm", age_s: min(15) / 1000 });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-login", title: "Login redirect fix", criteria: ["user lands on /home after login"] });
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-session", title: "Session cookie flags", criteria: ["cookie is SameSite=Lax"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t-login", touches: ["auth/login.ts", "auth.session_cookie"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "backend", task: "t-session", touches: ["auth.session_cookie", "api/session.ts"] });

    let s = reduce(await store.read(), c.now());
    expect([...s.seams.values()]).toHaveLength(1);
    expect([...s.seams.values()][0].overlap).toEqual(["auth.session_cookie"]);
    expect(board(s, HUMAN, c.now()).seams.some((x) => x.open)).toBe(true);
    expect(board(s, HUMAN, c.now()).needs_human).toHaveLength(0); // the seam is the team's to own, not the human's question

    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-login" });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t1", title: "x", criteria: ["y"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "backend", task: "t1", touches: ["a"] });
    // "done" is a claim, not a verdict
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true }))).message).toMatch(/not done/);
    await emit(store, c, { kind: "task", op: "done", actor: "backend", task: "t1", evidence: "guard test added" });
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "backend", task: "t1", surface: "repo", pass: true }))).message).toMatch(/owner/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pm", task: "t1", surface: "repo", pass: true }))).message).toMatch(/criteria/);
    // the human is the policy authority and may verify anything
    await emit(store, c, { kind: "task", op: "verify", actor: HUMAN, task: "t1", surface: "repo", pass: false, evidence: "guard test file never pushed" });
    expect(reduce(await store.read(), c.now()).tasks.get("t1")!.status).toBe("failed");
  });

  it("verification names its surface; the board shows which surfaces a task passed on", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t1", title: "copy fix", criteria: ["banner says X"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t1", touches: ["Banner.tsx"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t1" });
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "", pass: true }))).message).toMatch(/surface/);
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "repo", pass: true, evidence: "grep found new copy" });
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.tasks.verified[0].verified_on).toEqual(["repo"]); // visibly not "production"
  });
});

describe("t-006 · verified on one surface is not verified on another", () => {
  async function doneTask(store: MemoryStore, c: ReturnType<typeof clock>, id = "t1") {
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: "sha endpoint", criteria: ["/health has sha"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: ["app.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id, evidence: "fd76455" });
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
    // after a redeploy, production can be judged again; repo still cannot
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t1", evidence: "abc1234" });
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
    await emit(store2, c, { kind: "task", op: "create", actor: "pm", task: "t1", title: "sha endpoint", criteria: ["/health has sha"] });
    await emit(store2, c, { kind: "task", op: "create", actor: "pm", task: "t2", title: "board page", criteria: ["GET / html"] });
    await emit(store2, c, { kind: "task", op: "claim", actor: "dev", task: "t1", touches: ["app.ts"] });
    await emit(store2, c, { kind: "task", op: "claim", actor: "frontend", task: "t2", touches: ["app.ts"] });
    await emit(store2, c, { kind: "task", op: "done", actor: "dev", task: "t1" });
    expect((await rejected(emit(store2, c, { kind: "task", op: "verify", actor: "qa", task: "t1", surface: "production", pass: true }))).message).toMatch(/seam/);
  });
});

describe("t-009 · a seam with a task that was done before you claimed is stacking, not a collision", () => {
  const create = (store: MemoryStore, c: ReturnType<typeof clock>, id: string) =>
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] });

  it("A claim -> A done -> B claim overlapping: verify A is accepted; the board lists the seam as stacked", async () => {
    const store = new MemoryStore();
    const c = clock();
    await create(store, c, "A"); await create(store, c, "B");
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["cli/main.ts"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "5241517" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" });
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
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] });
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
    emit(store, c, { kind: "task", op: "create", actor: by, task: id, title: id, criteria: ["works"] });
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t1" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "B" });
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

  it("before ack_by it is a question for the human; after, it is decided by default and leaves needs_human", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(30));
    let b = await at(store, c);
    expect(b.needs_human.map((n) => n.id)).toEqual([q.id]);
    expect(b.instructions[0].chosen).toBeUndefined();
    c.tick(min(31));
    b = await at(store, c);
    expect(b.needs_human).toHaveLength(0);
    expect(b.overdue).toHaveLength(0);
    expect(b.instructions[0].chosen).toEqual({ option: "private", by: "default", at: q.ack_by });
  });

  it("after the default took effect the human can still decide; that decision wins and is a note; a second one is rejected", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c);
    c.tick(min(90));
    expect((await at(store, c)).instructions[0].chosen?.by).toBe("default");
    await emit(store, c, { kind: "ack", actor: HUMAN, of: q.id });
    const n = await emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 公开", decision: true, decides: { of: q.id, option: "public" } });
    const b = await at(store, c);
    expect(b.instructions[0].chosen).toEqual({ option: "public", by: HUMAN, at: n.at });
    expect(b.needs_human).toHaveLength(0);
    expect(reduce(await store.read(), c.now()).notes.some((x) => x.id === n.id && x.decides?.option === "public")).toBe(true);
    const again = await rejected(emit(store, c, { kind: "note", actor: HUMAN, body: "decision: 私有", decision: true, decides: { of: q.id, option: "private" } }));
    expect(again.message).toMatch(/already decided: public by human/);
  });

  it("without a default nothing changes: the ask stays with the human past ack_by; plain instructions still go overdue", async () => {
    const store = new MemoryStore();
    const c = clock();
    const q = await ask(store, c, { default: undefined });
    const plain = await emit(store, c, { kind: "instruction", actor: "pm", to: "backend", body: "deploy", ack_by: c.iso(min(10)) });
    c.tick(min(90));
    const b = await at(store, c);
    expect(b.needs_human.map((n) => n.id)).toEqual([q.id]);
    expect(b.instructions.find((i) => i.id === q.id)!.chosen).toBeUndefined();
    expect(b.overdue.map((o) => o.instruction)).toEqual([plain.id]);
  });
});

describe("t-025 · criteria can be added to an unfinished task; the adder becomes a criteria author", () => {
  const setup = async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "qa", task: "t-020", title: "牌桌卡片页", criteria: ["GET / 是卡片页"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t-020", touches: ["html.ts"] });
    return { store, c };
  };
  const task = async (store: MemoryStore, c: ReturnType<typeof clock>) => reduce(await store.read(), c.now()).tasks.get("t-020")!;

  it("the author, pm and the human may add while open/working/done; numbering continues; the create event is untouched", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "criteria", actor: "qa", task: "t-020", add: ["空状态有一句话说明"] });
    await emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["标签全部中文"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" });
    await emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "t-020", surface: "repo", pass: true });
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["再加一条"] }))).message).toMatch(/t-020 is verified; its criteria are what was judged/);
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-x", title: "x", criteria: ["y"] });
    await emit(store, c, { kind: "task", op: "withdraw", actor: "pm", task: "t-x", reason: "重复" });
    expect((await rejected(emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-x", add: ["z"] }))).message).toMatch(/is withdrawn/);
  });

  it("pd may add to a task it did not create (that is the point); pd then cannot verify it", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "criteria", actor: "pd", task: "t-020", add: ["空状态有一句话说明"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" });
    expect((await task(store, c)).criteria_added.map((a) => a.by)).toEqual(["pd"]);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pd", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/wrote the criteria/);
    await emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "t-020", surface: "repo", pass: true });
  });

  it("whoever added a criterion cannot verify the task any more; the human still can", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "criteria", actor: "pm", task: "t-020", add: ["空状态有一句话说明"] });
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020" });
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "pm", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/wrote the criteria/);
    expect((await rejected(emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "t-020", surface: "repo", pass: true }))).message).toMatch(/wrote the criteria/);
    await emit(store, c, { kind: "task", op: "verify", actor: "dev", task: "t-020", surface: "repo", pass: true });
    expect((await task(store, c)).status).toBe("verified");
    // the human is the policy authority even when they added a criterion
    const s2 = await setup();
    await emit(s2.store, s2.c, { kind: "task", op: "criteria", actor: HUMAN, task: "t-020", add: ["x"] });
    await emit(s2.store, s2.c, { kind: "task", op: "done", actor: "frontend", task: "t-020" });
    await emit(s2.store, s2.c, { kind: "task", op: "verify", actor: HUMAN, task: "t-020", surface: "repo", pass: true });
  });
});

describe("t-027 · the board tells this version's changes from history, and folds long in-flight lists", () => {
  const deploy = (store: MemoryStore, c: ReturnType<typeof clock>, sha: string) =>
    emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: sha });
  const passOnProd = async (store: MemoryStore, c: ReturnType<typeof clock>, id: string, title: string) => {
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["works"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id });
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
    for (let i = 1; i <= 7; i++) { c.tick(min(1)); await emit(store, c, { kind: "task", op: "create", actor: "pm", task: `t-${i}`, title: `task ${i}`, criteria: ["x"] }); }
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-020", title: "牌桌卡片页", criteria: ["卡片页"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "t-020", touches: ["html.ts", "i18n.ts"] });
    c.tick(min(10));
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020", evidence: "4bff806" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "frontend", task: "t-020", evidence: "156f926" });
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
    await emit(s2.store, s2.c, { kind: "task", op: "done", actor: "frontend", task: "t-020", evidence: "fix" });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-o", title: "o", criteria: ["x"] });
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "pm", task: "t-o", reason: "x" }))).message).toMatch(/t-o is open/);
    await emit(store, c, { kind: "task", op: "withdraw", actor: "pm", task: "t-o", reason: "dup" });
    expect((await rejected(emit(store, c, { kind: "task", op: "reopen", actor: "pm", task: "t-o", reason: "x" }))).message).toMatch(/is withdrawn/);
  });

  it("a task that reopens becomes in flight again: a seam stacked on it turns back into a collision", async () => {
    const { store, c } = await setup();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-026", title: "折叠", criteria: ["x"] });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["works"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    c.tick(min(1));
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: id, evidence });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true, evidence: "tests green" });
  };
  const release = async (store: MemoryStore, c: ReturnType<typeof clock>) => board(reduce(await store.read(), c.now()), HUMAN, c.now()).release;

  it("no candidates: nothing verified on repo, or everything already on production", async () => {
    const store = new MemoryStore();
    const c = clock();
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "a", criteria: ["x"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["a"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234" });
    expect(await release(store, c)).toEqual({ deployed_sha: null, candidates: [] }); // done is a claim, not a verdict
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "D", evidence: "2222222" });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-40", title: "登录后回到原页", criteria: ["回跳"], refs: [s1.id] });
    [x] = await said(store, c);
    expect(x).toMatchObject({ status: "task", label: "已成为任务：登录后回到原页", links: { tasks: [{ id: "t-40", title: "登录后回到原页", status: "open" }] } });

    await emit(store, c, { kind: "task", op: "claim", actor: "dev", task: "t-40", touches: ["auth"] });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "t-40", evidence: "abc1234" });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "在途折叠", criteria: ["x"], refs: [s1.id] });
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "线上折叠", criteria: ["x"], refs: [s1.id] });
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
    const r = await rejected(emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "x", criteria: ["y"], refs: ["01M1TSDDK1VXP23K45CPR3KDH5"] }));
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
    emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["works"] });
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" });
    await emit(store, c, { kind: "task", op: "verify", actor: "qa", task: "A", surface: "repo", pass: true });
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "B" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" });
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
    await emit(store, c, { kind: "task", op: "done", actor: "dev", task: "A" });
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
      kind: "task", op: "create", actor: "pm", task: "t-acceptance", title: "acceptance numbers", criteria: ["users.count == 128"], refs: [baseline.id],
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "A", title: "a", criteria: ["x"] });
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "B", title: "b", criteria: ["y"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "backend", task: "A", touches: ["f"] });
    await emit(store, c, { kind: "task", op: "claim", actor: "frontend", task: "B", touches: ["f"] });
    c.tick(min(10));
    const b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toHaveLength(1);
    expect(b.needs_human[0]).toMatchObject({ kind: "ask", id: q.id, from: "pm", body: "Board auth?", options: ["private", "public"], default: "private" });
    expect(b.needs_human[0].chosen).toBeUndefined();
    expect(b.overdue.map((o) => o.to)).toEqual(["backend"]);
    expect(b.seams.filter((x) => x.open).map((x) => x.id)).toEqual(["seam:A+B"]);
  });

  it("t-019: live says what production runs and what is verified there; in_flight groups unfinished tasks by status", async () => {
    const store = new MemoryStore();
    const c = clock();
    for (const [id, title] of [["A", "sha endpoint"], ["B", "html board"], ["C", "withdraw op"], ["D", "never started"]]) {
      await emit(store, c, { kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["works"] });
    }
    let b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.live).toMatchObject({ deployed_sha: null, verified_on_production: [] });
    expect(Object.keys(b.in_flight)).toEqual(["open"]);
    expect(b.in_flight.open.total).toBe(4);
    expect(b.in_flight.open.all.map((x) => [x.id, x.title])).toEqual([["A", "sha endpoint"], ["B", "html board"], ["C", "withdraw op"], ["D", "never started"]]);

    await emit(store, c, { kind: "reading", actor: HUMAN, key: "deployed.sha", surface: "production", value: "1501d1cce361834f93f3b4063dadf89fb70379e0", depends_on: ["production:deployed.sha"] });
    for (const [id, who] of [["A", "dev"], ["B", "frontend"]]) {
      await emit(store, c, { kind: "task", op: "claim", actor: who, task: id, touches: [id] });
      await emit(store, c, { kind: "task", op: "done", actor: who, task: id });
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
    await emit(store, c, { kind: "task", op: "create", actor: "pm", task: "t-1", title: "Cookie flags", criteria: ["SameSite=Lax"] });
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
