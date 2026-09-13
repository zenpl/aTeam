/**
 * t-054: a failed verification tells the owner by itself. t-055: a project with no verifier asks the human instead.
 * All times relative to now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, reduce, board, pull, FAIL_NOTICE, VERIFY_ASK, SERVICE_ACTOR, type Board, type Event, type State } from "@ateam/core";
import { createApp } from "../src/app.js";
import { ownerKey, ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

/** t-234：人说话用他自己那把钥匙；管理钥匙不再代他说话。 */
let OWNER = "";
import { followUps } from "@ateam/core";

const TOKEN = "secret-token";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";

const post = async (actor: string, body: unknown) => {
  const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${actor === HUMAN ? OWNER : TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const decide = (id: string, option: string) =>
  fetch(`${base}/decide`, { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, option }) });
const state = async (now = new Date()) => reduce(await store.read(), now);
// t-147: a fail notice carries no options, so it is never in `overdue` — what it is, is owed by its owner until
// somebody acts on it. That pile is `overdue_by_presence`.
const owed = (b: Board) => Object.values(b.overdue_by_presence).flatMap((g) => g.instructions);
const notices = (s: State, to: string, marker: string) => [...s.instructions.values()].filter((st) => st.instruction.actor === SERVICE_ACTOR && st.instruction.to === to && st.instruction.body.includes(marker)).map((st) => st.instruction);
const task = async (id: string, title: string, owner = "dev") => {
  await post("pm", { kind: "task", op: "create", task: id, title, criteria: ["能用"] , no_human_impact: true});
  await post(owner, { kind: "task", op: "claim", task: id, touches: [id] });
};

beforeAll(async () => {
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  OWNER = await ownerKey(base, TOKEN);
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-054 · verify --fail notifies the owner", () => {
  it("one notice per round, to the owner, from the service, with the reason's first 60 chars; delivered like any instruction", async () => {
    await task("t-1", "牌桌显示 sha");
    await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "abc1234: 加了端点" , no_human_impact: true});
    expect(notices(await state(), "dev", FAIL_NOTICE)).toHaveLength(0); // qa is in the default role set: nobody asks the human
    expect(notices(await state(), HUMAN, VERIFY_ASK)).toHaveLength(0);

    const reason = "criterion 2 not met: " + "细".repeat(80);
    const v = await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: false, evidence: reason });
    expect(v.status).toBe(201);
    let s = await state();
    const [n] = notices(s, "dev", FAIL_NOTICE);
    expect(n).toMatchObject({ to: "dev", actor: SERVICE_ACTOR, refs: [v.body.id] });
    expect(n.body).toBe(`t-1${FAIL_NOTICE}${[...reason].slice(0, 60).join("")}…。改完重新 done。`);
    expect(Date.parse(n.ack_by) - Date.parse(n.at)).toBe(15 * 60_000);
    expect(n.body.length).toBeLessThanOrEqual(280);
    // it reaches dev the way any instruction does
    const pulled = await pull(store, "dev", null);
    expect(pulled.events.some((e: Event) => e.id === n.id)).toBe(true);

    // a second fail in the same round adds nothing
    await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "staging", pass: false, evidence: "staging 也不行" });
    expect(notices(await state(), "dev", FAIL_NOTICE)).toHaveLength(1);

    // once the owner has done it again, the notice is stale: it leaves overdue by itself, unacked
    const later = new Date(Date.now() + 20 * 60_000);
    let b = board(await state(later), HUMAN, later);
    expect(owed(b)).toContain(n.id);
    await post("dev", { kind: "task", op: "reopen", task: "t-1", reason: "改" });
    expect((await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "def5678: 改了" , no_human_impact: true})).status).toBe(201);
    s = await state(later);
    b = board(s, HUMAN, later);
    expect(s.instructions.get(n.id)!.acked_at).toBeUndefined();
    expect(owed(b)).not.toContain(n.id);
    // a fail in the new round is a new notice
    const v2 = await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: false });
    const all = notices(await state(), "dev", FAIL_NOTICE);
    expect(all).toHaveLength(2);
    expect(all[1].refs).toEqual([v2.body.id]);
    expect(all[1].body).toContain("qa 在 repo 判不过，没给理由");
  });

  it("nothing is generated when the one who failed it is the owner", async () => {
    const s = await state();
    const t = s.tasks.get("t-1")!;
    const fake: Event = { id: "fake", at: new Date().toISOString(), kind: "task", op: "verify", actor: t.owner!, task: "t-1", surface: "repo", pass: false };
    expect(followUps(s, fake, HUMAN, new Date())).toEqual([]);
  });
});

describe("t-055 · no verifier in the role set: the human is asked", () => {
  it("done asks the human 过/不过 with the evidence and the surface; 过 is a verify --pass by the human", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev"] });
    await task("t-2", "登录后回到原页");
    const evidence = "abc1234: " + "证".repeat(250);
    const d = await post("dev", { kind: "task", op: "done", task: "t-2", evidence , no_human_impact: true});
    const s = await state();
    const [ask] = notices(s, HUMAN, VERIFY_ASK);
    expect(ask).toMatchObject({ to: HUMAN, actor: SERVICE_ACTOR, intent: "ask", options: ["过", "不过"], refs: [d.body.id] });
    expect(ask.default).toBeUndefined();
    expect(ask.body.startsWith(`登录后回到原页${VERIFY_ASK}证据：abc1234: `)).toBe(true);
    expect(ask.body.endsWith("…。判在 repo。")).toBe(true);
    expect([...ask.body].length).toBeLessThanOrEqual(280);
    const b = board(s, HUMAN);
    expect(b.needs_human.map((x) => x.id)).toContain(ask.id);

    expect((await decide(ask.id, "过")).status).toBe(201);
    const t = (await state()).tasks.get("t-2")!;
    expect(t.status).toBe("verified");
    expect(t.verifications.map((v) => ({ surface: v.surface, pass: v.pass, by: v.by, evidence: v.evidence }))).toEqual([{ surface: "repo", pass: true, by: HUMAN, evidence: "human 在牌桌上确认" }]);
    expect(board(await state(), HUMAN).needs_human.map((x) => x.id)).not.toContain(ask.id);
    expect(notices(await state(), "dev", FAIL_NOTICE).filter((i) => i.body.startsWith("t-2"))).toHaveLength(0);
  });

  it("不过 is a verify --fail by the human, and the owner gets the t-054 notice; the surface comes from project:verify.surface", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "verify.surface", value: "staging" });
    await task("t-3", "牌桌上的邀请链接");
    await post("dev", { kind: "task", op: "done", task: "t-3" , no_human_impact: true});
    const [ask] = notices(await state(), HUMAN, VERIFY_ASK).filter((i) => i.body.startsWith("牌桌上的邀请链接"));
    expect(ask.body).toBe(`牌桌上的邀请链接${VERIFY_ASK}没给证据。判在 staging。`);
    expect((await decide(ask.id, "不过")).status).toBe(201);
    const s = await state();
    const t = s.tasks.get("t-3")!;
    expect(t.status).toBe("failed");
    expect(t.verifications).toMatchObject([{ surface: "staging", pass: false, by: HUMAN, evidence: "human 在牌桌上判不过" }]);
    const [n] = notices(s, "dev", FAIL_NOTICE).filter((i) => i.body.startsWith("t-3"));
    expect(n.body).toBe(`t-3${FAIL_NOTICE}human 在牌桌上判不过。改完重新 done。`);
    // the owner does it again: a fresh ask, and the old one is stale for the board
    await post("dev", { kind: "task", op: "reopen", task: "t-3", reason: "改" });
    expect((await post("dev", { kind: "task", op: "done", task: "t-3", evidence: "fed9876: 改了" , no_human_impact: true})).status).toBe(201);
    const asks = notices(await state(), HUMAN, VERIFY_ASK).filter((i) => i.body.startsWith("牌桌上的邀请链接"));
    expect(asks).toHaveLength(2);
    expect(board(await state(), HUMAN).needs_human.map((x) => x.id)).toContain(asks[1].id);
  });

  it("with a verifier in the role set nothing changes", async () => {
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
    await task("t-4", "有 qa 的项目");
    await post("dev", { kind: "task", op: "done", task: "t-4", evidence: "abc1234" , no_human_impact: true});
    expect(notices(await state(), HUMAN, VERIFY_ASK).filter((i) => i.body.startsWith("有 qa 的项目"))).toHaveLength(0);
  });
});

describe("t-087 · a fail notice goes stale when another role takes the task over", () => {
  it("over the API: the notice leaves the human's and the owner's lists with the reason in the data, and the events stay", async () => {
    await task("t-9", "接手用例");
    await post("dev", { kind: "task", op: "done", task: "t-9", evidence: "abc1234" , no_human_impact: true});
    const v = await post("qa", { kind: "task", op: "verify", task: "t-9", surface: "repo", pass: false, evidence: "少一条测试" });
    expect(v.status).toBe(201);
    const later = new Date(Date.now() + 30 * 60_000);
    const notice = notices(await state(later), "dev", FAIL_NOTICE).find((i) => i.body.startsWith("t-9"))!;
    expect(owed(board(await state(later), HUMAN, later))).toContain(notice.id);
    const claim = await post("frontend", { kind: "task", op: "claim", task: "t-9", touches: ["t-9"] });
    expect(claim.status).toBe(201);
    const b = board(await state(later), HUMAN, later);
    expect(owed(b)).not.toContain(notice.id);
    expect(b.instructions.find((i) => i.id === notice.id)!.stale).toEqual({ reason: "taken_over", task: "t-9", by: "frontend", claim: claim.body.id });
    const events = (await store.read()).events;
    expect(events.find((e) => e.id === notice.id)).toBeTruthy(); // nothing deleted, nothing edited
  });
});
