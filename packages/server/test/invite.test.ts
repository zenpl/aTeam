/**
 * t-042: an invite link is exchanged for a node key; the service assigns the missing role; joining is idempotent;
 * the first node is pm and puts the first card on the board; a quiet role with work in hand becomes a card for the human.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { MemoryRegistry } from "../src/projects.js";

const HUMAN = "human";
let app: ReturnType<typeof createApp>;
let base = "";
let registry: MemoryRegistry;
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const newProject = async (name: string) => (await j(await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }))).body;
const join = async (code: string, body: unknown) => j(await fetch(`${base}/invite/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const api = (project: string, path: string, key: string, actor: string, init: RequestInit = {}) =>
  fetch(`${base}/p/${project}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "x-actor": actor, "content-type": "application/json", ...(init.headers ?? {}) } });
const code = (inviteUrl: string) => inviteUrl.split("/").pop()!;

beforeAll(async () => {
  registry = new MemoryRegistry();
  app = createApp({ registry, token: "legacy", human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-042 · GET /invite/<code>", () => {
  it("is the join manual with the code and project filled in; unknown 404; expired 410; admin can reissue", async () => {
    const p = await newProject("菜谱本");
    const r = await fetch(`${base}/invite/${code(p.invite_url)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await r.text();
    expect(text).toContain(`POST ${base}/invite/${code(p.invite_url)}/join`);
    expect(text).toContain(`${base}/p/${p.project}/events`);
    expect(text).toContain("菜谱本");
    expect((await fetch(`${base}/invite/nope`)).status).toBe(404);
    const stale = await registry.createInvite(p.project, new Date(), -1);
    expect((await fetch(`${base}/invite/${stale.code}`)).status).toBe(410);
    expect((await join(stale.code, { agent_id: "x" })).status).toBe(410);
    const re = await j(await api(p.project, "/invites", p.admin_key, "human", { method: "POST" }));
    expect(re.status).toBe(201);
    expect(re.body.invite_url).toMatch(new RegExp(`^${base}/invite/`));
    expect((await fetch(`${base}/invite/${code(re.body.invite_url)}`)).status).toBe(200);
  });
});

describe("t-042 · POST /invite/<code>/join", () => {
  it("the first node is pm, gets a node key and its manual, and puts the first card on the board; joining again is idempotent", async () => {
    const p = await newProject("第一个项目");
    expect((await join(code(p.invite_url), {})).status).toBe(400);
    const a = await join(code(p.invite_url), { agent_id: "session-A", capabilities: ["写仓库", "有网"] });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ role: "pm", first: true, created: true, project: p.project, project_url: `${base}/p/${p.project}`, board_url: `${base}/p/${p.project}/` });
    expect(a.body.node_key).toMatch(/^nk_/);
    expect(a.body.manual).toContain("# 角色 · pm");
    const b = (await j(await api(p.project, "/board", a.body.node_key, "pm"))).body;
    expect(b.focus.body).toBe("等 human 说这个项目是什么");
    expect(b.needs_human.map((n: { kind: string; body: string; from: string }) => [n.kind, n.from, n.body])).toEqual([["ask", "pm", "这个项目是什么？说一句。"]]);
    expect(b.readings.find((r: { surface: string; key: string }) => r.surface === "node" && r.key === "pm:能力").value).toEqual(["写仓库", "有网"]);
    expect(b.presence.find((x: { actor: string }) => x.actor === "pm").present).toBe(true);
    // again: same key, same role, nothing new in the log
    const events = (await j(await api(p.project, "/log", a.body.node_key, "pm"))).body.events.length;
    const again = await join(code(p.invite_url), { agent_id: "session-A" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ role: "pm", node_key: a.body.node_key, created: false, first: false });
    expect((await j(await api(p.project, "/log", a.body.node_key, "pm"))).body.events.length).toBe(events);
    // the node key is bound to pm; nothing else is accepted, and it does not open another project
    expect((await api(p.project, "/board", a.body.node_key, "dev")).status).toBe(403);
    const other = await newProject("别的");
    expect((await api(other.project, "/board", a.body.node_key, "pm")).status).toBe(403);
    // only the admin sees the invite link on the board
    expect((await j(await api(p.project, "/board", p.admin_key, "human"))).body.invite_url).toBe(p.invite_url);
    expect(b.invite_url).toBeUndefined();
  });

  it("assigns the first missing role in the project's order, honours an explicit role, and says which are free when all are present", async () => {
    const p = await newProject("满员");
    const c = code(p.invite_url);
    expect((await join(c, { agent_id: "1" })).body.role).toBe("pm");
    expect((await join(c, { agent_id: "2", capabilities: ["x"] })).body.role).toBe("pd");
    expect((await join(c, { agent_id: "3", role: "qa", capabilities: ["x"] })).body.role).toBe("qa");
    expect((await join(c, { agent_id: "4", capabilities: ["x"] })).body.role).toBe("dev");
    expect((await join(c, { agent_id: "5", capabilities: ["x"] })).body.role).toBe("frontend");
    const full = await join(c, { agent_id: "6" });
    expect(full.status).toBe(409);
    expect(full.body.available).toEqual(["pd", "pm", "dev", "frontend", "qa"]);
    expect((await join(c, { agent_id: "6", role: "dev" })).body.role).toBe("dev"); // a new node replaces the old (Q10)
    expect((await join(c, { agent_id: "7", role: "writer" })).status).toBe(409);
    // a project that declares fewer roles assigns only those
    const q = await newProject("两人");
    const first = await join(code(q.invite_url), { agent_id: "a" });
    await api(q.project, "/events", first.body.node_key, "pm", { method: "POST", body: JSON.stringify({ kind: "reading", key: "roles", surface: "project", value: ["pm", "dev"] }) });
    expect((await join(code(q.invite_url), { agent_id: "b", capabilities: ["x"] })).body.role).toBe("dev");
    expect((await join(code(q.invite_url), { agent_id: "c" })).body.available).toEqual(["pm", "dev"]);
  });
});

describe("t-048 · undelivered instructions become the same card, not a second one", () => {
  it("a role that never pulled with an old pending instruction: one 可能失联 card; still one after an overdue one appears", async () => {
    const p = await newProject("没送到");
    const pm = await join(code(p.invite_url), { agent_id: "pm-1" });
    // an instruction to qa sent 6 minutes ago: append with a past 'at' is not possible through the API, so use an overdue-and-pending one
    // (pending: qa never pulled). The service card exists because of overdue (t-042); undelivered needs 5 minutes of age.
    const past = new Date(Date.now() - 1000).toISOString();
    await api(p.project, "/events", pm.body.node_key, "pm", { method: "POST", body: JSON.stringify({ kind: "instruction", to: "qa", body: "验一下", ack_by: past }) });
    let b = (await j(await api(p.project, "/board", p.admin_key, "human"))).body;
    expect(b.undelivered).toEqual([]); // too young to count as undelivered
    const cards = b.needs_human.filter((n: { from: string }) => n.from === "ateam");
    expect(cards).toHaveLength(1);
    expect(cards[0].body).toMatch(/^qa 已经缺了 \d+ 分钟，手里有 1 条指令。起一个 qa？$/); // nothing undelivered yet (younger than 5 minutes): the 缺人 wording
    b = (await j(await api(p.project, "/board", p.admin_key, "human"))).body;
    expect(b.needs_human.filter((n: { from: string }) => n.from === "ateam")).toHaveLength(1);
    expect(b.presence.find((x: { actor: string }) => x.actor === "qa")).toMatchObject({ status: "missing", listening: false });
  });
});

describe("t-042 · a quiet role with work in its hands becomes a card for the human", () => {
  it("one card per absence; it leaves needs_human when the role is back, without an ack", async () => {
    const p = await newProject("缺人");
    const pm = await join(code(p.invite_url), { agent_id: "pm-1" });
    const past = new Date(Date.now() - 1000).toISOString();
    await api(p.project, "/events", pm.body.node_key, "pm", { method: "POST", body: JSON.stringify({ kind: "instruction", to: "dev", body: "修登录", ack_by: past }) });
    await api(p.project, "/events", pm.body.node_key, "pm", { method: "POST", body: JSON.stringify({ kind: "instruction", to: "dev", body: "修注册", ack_by: past }) });
    let b = (await j(await api(p.project, "/board", p.admin_key, "human"))).body;
    const cards = b.needs_human.filter((n: { from: string }) => n.from === "ateam");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "do", body: "dev 已经缺了 10 分钟，手里有 2 条指令。起一个 dev？", title: "dev 已经缺了 10 分钟，手里有 2 条指令" });
    b = (await j(await api(p.project, "/board", p.admin_key, "human"))).body;
    expect(b.needs_human.filter((n: { from: string }) => n.from === "ateam")).toHaveLength(1); // not twice
    // dev joins and pulls: the role is back, the card is no longer true
    const dev = await join(code(p.invite_url), { agent_id: "dev-1", role: "dev" });
    await api(p.project, "/events?after=", dev.body.node_key, "dev");
    b = (await j(await api(p.project, "/board", p.admin_key, "human"))).body;
    expect(b.needs_human.filter((n: { from: string }) => n.from === "ateam")).toHaveLength(0);
    expect(b.instructions.find((i: { from: string }) => i.from === "ateam").status).not.toBe("acked");
    expect(b.presence.find((x: { actor: string }) => x.actor === "dev")).toMatchObject({ role: "dev", present: true });
  });
});
