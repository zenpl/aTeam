/**
 * Replay of the 2026-09-05 field report ("Git 总线上的五个 Agent").
 * Each test is one failure mode from that day. The tool must make it impossible or visible.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, pull, reduce, board, Rejected, type NewEvent, type Event } from "../src/index.js";

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
    expect(b.needs_human.map((x) => x.kind)).toContain("overdue");

    // backend finally pulls: delivery is a server-side fact, not a guess
    const got = await pull(store, "backend", null, c.now());
    expect(got.for_me.map((e) => e.id)).toEqual([order.id]);
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.instructions[0].delivered).toBe(c.iso());

    await emit(store, c, { kind: "ack", actor: "backend", of: order.id });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.instructions[0].status).toBe("acked");
    expect(b.needs_human).toHaveLength(0);
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
    expect(board(s, HUMAN, c.now()).needs_human.some((x) => x.kind === "open_seam")).toBe(true);

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
    expect(b.needs_human.map((x) => x.kind)).toContain("open_seam");
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
    expect(b.needs_human.map((x) => x.kind)).toContain("open_seam");
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
    const r = await emit(store, c, { kind: "reading", actor: "qa", key: "staging.has_real_users", value: false, surface: "staging", valid_until: c.iso(min(60)) });
    c.tick(min(61));
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
    expect(b.needs_human).toEqual([expect.objectContaining({ id: q.id, kind: "instruction" })]);
    await emit(store, c, { kind: "ack", actor: HUMAN, of: q.id });
    b = board(reduce(await store.read(), c.now()), HUMAN, c.now());
    expect(b.needs_human).toHaveLength(0);
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
    expect(b.presence).toEqual([
      { actor: "backend", last_seen: c.iso(-min(7)), idle_s: 420 },
      { actor: "pm", last_seen: c.iso(-min(10)), idle_s: 600 },
    ]);
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
