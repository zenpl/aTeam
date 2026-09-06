/**
 * t-069: a new project's second card asks how to reach the human when they are away. Optional: 填写 records the
 * fact the call-outs read (t-050); 先不要 closes it; a fact recorded any other way closes it too. Times relative.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, CONTACT_ASK, type Event } from "@ateam/core";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let base = "";
const j = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => null) });
const newProject = async (name: string) => (await j(await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }))).body;
const join = async (inviteUrl: string, agent: string) => (await j(await fetch(`${base}/invite/${inviteUrl.split("/").pop()}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: agent }) }))).body;
const api = (project: string, path: string, key: string, init: RequestInit = {}) =>
  fetch(`${base}/p/${project}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, "x-actor": "pm", "content-type": "application/json", ...(init.headers ?? {}) } });
const decide = (project: string, admin: string, id: string, option: string, value?: string) =>
  fetch(`${base}/p/${project}/decide`, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, option, ...(value !== undefined ? { value } : {}) }) });
const cards = async (project: string, key: string) => ((await (await api(project, "/board", key)).json()).needs_human as { id: string; body: string; options?: string[] }[]);

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: "root", human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

async function start(name: string) {
  const p = await newProject(name);
  const first = await join(p.invite_url, `${name}-a`);
  return { project: p.project as string, admin: p.admin_key as string, key: first.node_key as string };
}

describe("t-069 · the second card of a new project", () => {
  it("unanswered: it follows the first card, with 填写 / 先不要, and blocks nothing; joining again does not repeat it", async () => {
    const w = await start("一");
    const c = await cards(w.project, w.key);
    expect(c.map((x) => x.body)).toEqual(["这个项目是什么？说一句。", CONTACT_ASK]);
    expect(c[1].options).toEqual(["填写", "先不要"]);
    await join((await (await api(w.project, "/board", w.admin)).json()).invite_url, "一-a");
    expect((await cards(w.project, w.key)).filter((x) => x.body === CONTACT_ASK)).toHaveLength(1);
    // nothing waits on it: a node can work, the human can answer the first card alone
    expect((await api(w.project, "/events", w.key, { method: "POST", body: JSON.stringify({ kind: "reading", key: "focus", surface: "team", value: "开工" }) })).status).toBe(201);
  });

  it("填写 needs a value, then records project:alert.webhook and the card is gone", async () => {
    const w = await start("二");
    const card = (await cards(w.project, w.key)).find((x) => x.body === CONTACT_ASK)!;
    expect((await decide(w.project, w.admin, card.id, "填写")).status).toBe(400);
    expect((await decide(w.project, w.admin, card.id, "填写", "  ")).status).toBe(400);
    expect((await (await api(w.project, "/board", w.key)).json()).alert).toEqual({ status: "unanswered" });
    expect((await decide(w.project, w.admin, card.id, "填写", "https://hooks.example/team")).status).toBe(201);
    const b = await (await api(w.project, "/board", w.key)).json();
    expect(b.alert).toEqual({ status: "set", value: "https://hooks.example/team", source: "given" });
    const fact = b.readings.find((r: { surface: string; key: string }) => r.surface === "project" && r.key === "alert.webhook");
    expect(fact).toMatchObject({ value: "https://hooks.example/team", valid: true, by: "human" });
    expect(b.needs_human.map((x: { body: string }) => x.body)).not.toContain(CONTACT_ASK);
    const events = (await (await api(w.project, "/log", w.key)).json()).events as Event[];
    expect(events.find((e) => e.kind === "note" && e.decision)).toMatchObject({ body: `decision: ${CONTACT_ASK} -> 填写：https://hooks.example/team` });
  });

  it("先不要: a note says it was skipped, the card never returns; a fact recorded later still works", async () => {
    const w = await start("三");
    const card = (await cards(w.project, w.key)).find((x) => x.body === CONTACT_ASK)!;
    expect((await decide(w.project, w.admin, card.id, "先不要")).status).toBe(201);
    expect((await cards(w.project, w.key)).map((x) => x.body)).not.toContain(CONTACT_ASK);
    expect((await (await api(w.project, "/board", w.key)).json()).alert).toEqual({ status: "skipped" });
    const events = (await (await api(w.project, "/log", w.key)).json()).events as Event[];
    expect(events.some((e) => e.kind === "note" && e.decision && e.body === `decision: ${CONTACT_ASK} -> 先不要`)).toBe(true);
    expect(events.some((e) => e.kind === "reading" && e.key === "alert.webhook")).toBe(false);
    await api(w.project, "/events", w.key, { method: "POST", body: JSON.stringify({ kind: "reading", key: "alert.webhook", surface: "project", value: "https://hooks.example/later" }) });
    expect((await cards(w.project, w.key)).map((x) => x.body)).not.toContain(CONTACT_ASK);
    expect((await (await api(w.project, "/board", w.key)).json()).alert.status).toBe("set"); // skipped, then given later
  });

  it("a fact recorded by a node before the human answers closes the card by itself", async () => {
    const w = await start("四");
    expect((await cards(w.project, w.key)).map((x) => x.body)).toContain(CONTACT_ASK);
    await api(w.project, "/events", w.key, { method: "POST", body: JSON.stringify({ kind: "reading", key: "alert.webhook", surface: "project", value: "https://hooks.example/cli" }) });
    const b = await (await api(w.project, "/board", w.key)).json();
    expect(b.needs_human.map((x: { body: string }) => x.body)).toEqual(["这个项目是什么？说一句。"]);
    expect(b.instructions.find((i: { body: string }) => i.body === CONTACT_ASK).status).not.toBe("acked"); // unanswered, just no longer asked
  });
});
