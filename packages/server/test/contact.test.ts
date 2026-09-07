/**
 * t-069: a new project's second card asks how to reach the human when they are away. Optional: 填写 records the
 * fact the call-outs read (t-050); 不要了 closes it; a fact recorded any other way closes it too. Times relative.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { CONTACT_FILL, CONTACT_OPTIONS, MemoryStore, CONTACT_ASK, type Event } from "@ateam/core";
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
  // t-122: the card exists only where the project asked for call-outs (fact project:alert.ask). It used to be sent
  // unconditionally at join, which put it in needs_human on a page that would never render it.
  await api(p.project, "/events", first.node_key, { method: "POST", headers: { "x-actor": "pm" }, body: JSON.stringify({ kind: "reading", surface: "project", key: "alert.ask", value: true }) });
  return { project: p.project as string, admin: p.admin_key as string, key: first.node_key as string };
}

describe("t-069 · the second card of a new project", () => {
  it("unanswered: it follows the first card, with 记下 / 不要了, and blocks nothing; joining again does not repeat it", async () => {
    const w = await start("一");
    const c = await cards(w.project, w.key);
    expect(c.map((x) => x.body)).toEqual(["这个项目是什么？说一句。", CONTACT_ASK]);
    expect(c[1].options).toEqual(CONTACT_OPTIONS); // t-111 永久那一项说出后果；t-118 (pd 01:40) 值就是人看到的那个词
    await join((await (await api(w.project, "/board", w.admin)).json()).invite_url, "一-a");
    expect((await cards(w.project, w.key)).filter((x) => x.body === CONTACT_ASK)).toHaveLength(1);
    // nothing waits on it: a node can work, the human can answer the first card alone
    expect((await api(w.project, "/events", w.key, { method: "POST", body: JSON.stringify({ kind: "reading", key: "focus", surface: "team", value: "开工" }) })).status).toBe(201);
  });

  it("记下 needs a value, then records project:alert.webhook and the card is gone", async () => {
    const w = await start("二");
    const card = (await cards(w.project, w.key)).find((x) => x.body === CONTACT_ASK)!;
    expect((await decide(w.project, w.admin, card.id, CONTACT_FILL)).status).toBe(400);
    expect((await decide(w.project, w.admin, card.id, CONTACT_FILL, "  ")).status).toBe(400);
    expect((await (await api(w.project, "/board", w.key)).json()).alert).toEqual({ status: "unanswered" });
    expect((await decide(w.project, w.admin, card.id, CONTACT_FILL, "https://hooks.example/team")).status).toBe(201);
    const b = await (await api(w.project, "/board", w.key)).json();
    // t-119：配上就是「记下了，还没真发成功过」——牌桌说的是「你收不收得到」，不是「配没配」
    expect(b.alert).toMatchObject({ status: "unproven", value: "https://hooks.example/team", source: "given" });
    expect(b.alert.line).toBe("记下了外呼地址，还没真发成功过——不知道你收不收得到。");
    const fact = b.readings.find((r: { surface: string; key: string }) => r.surface === "project" && r.key === "alert.webhook");
    expect(fact).toMatchObject({ value: "https://hooks.example/team", valid: true, by: "human" });
    expect(b.needs_human.map((x: { body: string }) => x.body)).not.toContain(CONTACT_ASK);
    const events = (await (await api(w.project, "/log", w.key)).json()).events as Event[];
    expect(events.find((e) => e.kind === "note" && e.decision)).toMatchObject({ body: `decision: ${CONTACT_ASK} -> ${CONTACT_FILL}：https://hooks.example/team` });
  });

  it("不要了: a note says it was skipped, the card never returns; a fact recorded later still works", async () => {
    const w = await start("三");
    const card = (await cards(w.project, w.key)).find((x) => x.body === CONTACT_ASK)!;
    expect((await decide(w.project, w.admin, card.id, "不要了")).status).toBe(201);
    expect((await cards(w.project, w.key)).map((x) => x.body)).not.toContain(CONTACT_ASK);
    expect((await (await api(w.project, "/board", w.key)).json()).alert).toEqual({ status: "skipped" });
    const events = (await (await api(w.project, "/log", w.key)).json()).events as Event[];
    expect(events.some((e) => e.kind === "note" && e.decision && e.body === `decision: ${CONTACT_ASK} -> 不要了`)).toBe(true);
    expect(events.some((e) => e.kind === "reading" && e.key === "alert.webhook")).toBe(false);
    await api(w.project, "/events", w.key, { method: "POST", body: JSON.stringify({ kind: "reading", key: "alert.webhook", surface: "project", value: "https://hooks.example/later" }) });
    expect((await cards(w.project, w.key)).map((x) => x.body)).not.toContain(CONTACT_ASK);
    expect((await (await api(w.project, "/board", w.key)).json()).alert.status).toBe("unproven"); // 先跳过、之后才配上：仍是「还没真发成功过」
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

describe("t-122 · 日志里有几张卡，页面上就有几张", () => {
  /**
   * qa 01:57: a new project put two cards in needs_human and rendered one. The call-out card was sent
   * unconditionally at join while the other generator and the page are both gated on project:alert.ask, so the
   * human got a card they could never see and never answer — with 「不想要就点不要了」 written on it.
   */
  const cardCount = (html: string) => (html.match(/<article class="ask"/g) ?? []).length;

  it("the first minute of a new project: the counts match, and they still match once call-outs are asked for", async () => {
    const p = await newProject("数得上");
    const first = await join(p.invite_url, "数得上-a");
    const page = async () => await (await fetch(`${base}/p/${p.project}/?token=${p.admin_key}`, { headers: { accept: "text/html" }, redirect: "follow" })).text();

    const before = await cards(p.project, first.node_key);
    expect(before.map((x) => x.body)).toEqual(["这个项目是什么？说一句。"]);
    expect(cardCount(await page())).toBe(before.length);
    expect(await page()).not.toContain("你不在时怎么找你");

    // asking for call-outs adds the card on both sides at once, never to only one
    await api(p.project, "/events", first.node_key, { method: "POST", body: JSON.stringify({ kind: "reading", surface: "project", key: "alert.ask", value: true }) });
    const after = await cards(p.project, first.node_key);
    expect(after).toHaveLength(2);
    expect(cardCount(await page())).toBe(after.length);
    expect(await page()).toContain("你不在时怎么找你");
  });
});
