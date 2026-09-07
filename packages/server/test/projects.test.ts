/**
 * t-041: many projects on one service. Each has its own log, cursors, deliveries and keys; the unprefixed
 * address is the default project; a key never opens another project; a node key is bound to its role.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";
import { SqliteDb, SqliteStore, SqliteRegistry } from "../src/sqlite-store.js";
import { MemoryRegistry, hashKey } from "../src/projects.js";

const LEGACY = "legacy-token";
const HUMAN = "human";
let app: ReturnType<typeof createApp>;
let base = "";
let registry: MemoryRegistry;

const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const api = (path: string, key: string | undefined, actor = "qa", init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "x-actor": actor, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (path: string, key: string | undefined, actor: string, body: unknown) => api(path, key, actor, { method: "POST", body: JSON.stringify(body) });
const later = () => new Date(Date.now() + 3_600_000).toISOString();

beforeAll(async () => {
  registry = new MemoryRegistry();
  app = createApp({ store: new MemoryStore(), token: LEGACY, registry, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-041 · POST /projects", () => {
  it("needs no key, returns the address, the admin key (once) and an invite link; the key is stored hashed", async () => {
    const r = await j(await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "菜谱本" }) }));
    expect(r.status).toBe(201);
    expect(r.body.project).toMatch(/^p-[0-9a-f]{6}$|^[a-z0-9-]+-[0-9a-f]{6}$/);
    // t-103: the address the first agent relays now carries the owner's own key — the sentence is unchanged, the address is theirs
    expect(r.body.board_url).toMatch(new RegExp(`^${base}/p/${r.body.project}/\\?k=nk_[A-Za-z0-9_-]+$`));
    expect(r.body.admin_key).toMatch(/^ak_/);
    expect(r.body.invite_url).toBe(`${base}/invite/${(await registry.getInvite(r.body.invite_url.split("/").pop()))!.code}`);
    expect([...registry.keys.keys()]).toContain(hashKey(r.body.admin_key));
    expect([...registry.keys.values()].some((k) => JSON.stringify(k).includes(r.body.admin_key))).toBe(false);
    expect((await j(await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(400);
  });
});

describe("t-041 · isolation", () => {
  let a: { project: string; admin_key: string }, b: { project: string; admin_key: string };
  beforeAll(async () => {
    a = (await j(await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "A" }) }))).body;
    b = (await j(await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "B" }) }))).body;
  });

  it("each project has its own log, cursor and delivery; the default project is the unprefixed address with the legacy key", async () => {
    expect((await post(`/p/${a.project}/events`, a.admin_key, "pm", { kind: "note", body: "A 的第一条" })).status).toBe(201);
    expect((await post(`/events`, LEGACY, "pm", { kind: "note", body: "默认项目的一条" })).status).toBe(201);
    const inA = (await j(await api(`/p/${a.project}/log`, a.admin_key))).body.events.map((e: { body: string }) => e.body);
    const inB = (await j(await api(`/p/${b.project}/log`, b.admin_key))).body.events;
    const inDefault = (await j(await api(`/log`, LEGACY))).body.events.map((e: { body: string }) => e.body);
    expect(inA).toEqual(["A 的第一条"]);
    expect(inB).toEqual([]);
    expect(inDefault).toEqual(["默认项目的一条"]);
    // same actor, two projects, two cursors: pulling in A does not move B
    const ia = (await j(await post(`/p/${a.project}/events`, a.admin_key, "pm", { kind: "instruction", to: "dev", body: "A 的活", ack_by: later() }))).body;
    await api(`/p/${a.project}/events`, a.admin_key, "dev");
    const boardA = (await j(await api(`/p/${a.project}/board`, a.admin_key))).body;
    const boardB = (await j(await api(`/p/${b.project}/board`, b.admin_key))).body;
    expect(boardA.instructions.find((i: { id: string }) => i.id === ia.id).status).toBe("delivered");
    expect(boardB.instructions).toEqual([]);
    expect(boardB.presence.every((p: { present: boolean }) => !p.present)).toBe(true);
    expect(boardA.presence.find((p: { actor: string }) => p.actor === "dev").present).toBe(true);
  });

  it("a key of another project is 403; no key is 401; an unknown project is 404", async () => {
    expect((await api(`/p/${b.project}/board`, a.admin_key)).status).toBe(403);
    expect((await api(`/p/${a.project}/board`, LEGACY)).status).toBe(403);
    expect((await api(`/board`, a.admin_key)).status).toBe(403);
    expect((await api(`/p/${a.project}/board`, undefined)).status).toBe(401);
    expect((await api(`/p/${a.project}/board`, "ak_nope")).status).toBe(401);
    expect((await api(`/p/nope-000000/board`, a.admin_key)).status).toBe(404);
  });

  it("a node key is bound to its project and role: X-Actor must be that role", async () => {
    const nodeKey = await registry.addKey(a.project, "dev", "agent-1");
    expect((await api(`/p/${a.project}/board`, nodeKey, "dev")).status).toBe(200);
    expect((await j(await api(`/p/${a.project}/board`, nodeKey, "pm"))).status).toBe(403);
    expect((await api(`/p/${b.project}/board`, nodeKey, "dev")).status).toBe(403);
    // a node key does not open the human's buttons; the admin key does
    expect((await fetch(`${base}/p/${a.project}/say`, { method: "POST", headers: { authorization: `Bearer ${nodeKey}`, "content-type": "application/x-www-form-urlencoded" }, body: "text=hi" })).status).toBe(401);
    expect((await fetch(`${base}/p/${a.project}/say`, { method: "POST", headers: { authorization: `Bearer ${a.admin_key}`, "content-type": "application/x-www-form-urlencoded" }, body: "text=你好" })).status).toBe(201);
  });

  it("the board page of a project posts its forms under its own prefix, and ?token= sets a cookie for that project only", async () => {
    await post(`/p/${a.project}/events`, a.admin_key, "pm", { kind: "instruction", to: HUMAN, body: "看一眼", ack_by: later() });
    // anonymous: the board v2 sends every button through the project's token page, carrying the action (t-034)
    const page = await (await fetch(`${base}/p/${a.project}/`, { headers: { accept: "text/html" } })).text();
    expect(page).toContain(`action="/p/${a.project}/token"><input type="hidden" name="then" value="/ack">`);
    const login = await fetch(`${base}/p/${a.project}/?token=${a.admin_key}`, { redirect: "manual" });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe(`/p/${a.project}/`);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie.startsWith(`ateam_token_${a.project}=`)).toBe(true);
    // with the project's cookie the forms post straight to the prefixed actions
    const inside = await (await fetch(`${base}/p/${a.project}/`, { headers: { accept: "text/html", cookie: cookie.split(";")[0] } })).text();
    expect(inside).toContain(`action="/p/${a.project}/ack"`);
    // the token page of the project validates the project's own admin key, sets its cookie, runs the action, returns under the prefix
    const gate = await fetch(`${base}/p/${a.project}/token`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ then: "/say", text: "从项目页说的", token: a.admin_key }).toString() });
    expect(gate.status).toBe(303);
    expect(gate.headers.get("location")).toBe(`/p/${a.project}/`);
    expect(gate.headers.get("set-cookie")!.startsWith(`ateam_token_${a.project}=`)).toBe(true);
    expect((await fetch(`${base}/p/${b.project}/token`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ then: "/say", text: "x", token: a.admin_key }).toString() })).status).toBe(401);
    expect((await fetch(`${base}/p/${b.project}/?token=${a.admin_key}`, { redirect: "manual" })).status).toBe(401);
    // the manuals are reachable under the prefix too, so ATEAM_URL may be the project address
    expect((await fetch(`${base}/p/${a.project}/manual/dev`)).status).toBe(200);
    expect((await fetch(`${base}/p/${a.project}/manual`)).status).toBe(200);
  });
});

describe("t-041 · SQLite: the log that predates projects migrates into the default project", () => {
  it("old tables gain a project column, rows land in the default project, keys and invites persist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ateam-mp-"));
    const file = join(dir, "a.db");
    // an old-shape database, as the server created it before t-041
    const { DatabaseSync } = (process as unknown as { getBuiltinModule(id: string): typeof import("node:sqlite") }).getBuiltinModule("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE events (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE cursors (actor TEXT PRIMARY KEY, last_event_id TEXT, at TEXT NOT NULL);
      CREATE TABLE deliveries (event_id TEXT NOT NULL, to_actor TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (event_id, to_actor));
      INSERT INTO events VALUES ('01A', '2026-09-06T00:00:00.000Z', 'pm', 'note', '{"id":"01A","at":"2026-09-06T00:00:00.000Z","actor":"pm","kind":"note","body":"老日志"}');
      INSERT INTO cursors VALUES ('dev', '01A', '2026-09-06T00:00:01.000Z');
      INSERT INTO deliveries VALUES ('01A', 'dev', '2026-09-06T00:00:01.000Z');
    `);
    old.close();
    const sdb = new SqliteDb(file, "ateam");
    const reg = new SqliteRegistry(sdb);
    await reg.ensure("ateam", "ateam", LEGACY);
    const log = await new SqliteStore(sdb, "ateam").read();
    expect(log.events.map((e) => e.id)).toEqual(["01A"]);
    expect(log.cursors).toEqual([{ actor: "dev", last_event_id: "01A", at: "2026-09-06T00:00:01.000Z" }]);
    expect(log.deliveries).toEqual([{ event_id: "01A", to: "dev", at: "2026-09-06T00:00:01.000Z" }]);
    expect(await reg.lookup(LEGACY)).toMatchObject({ project: "ateam", role: null });
    const { project, admin_key, invite } = await reg.create("第二个");
    expect((await new SqliteStore(sdb, project.id).read()).events).toEqual([]);
    expect(await reg.lookup(admin_key)).toMatchObject({ project: project.id, role: null });
    expect(await reg.getInvite(invite.code)).toMatchObject({ project: project.id });
    // reopening is idempotent
    const again = new SqliteDb(file, "ateam");
    expect((await new SqliteStore(again, "ateam").read()).events).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
