/**
 * t-002: the human's page. GET / is the board as read-only HTML; nothing else about the API changes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";
import { REFRESH_SECONDS, esc } from "../src/html.js";

const TOKEN = "secret-token";
const HUMAN = "human";

let app: ReturnType<typeof createApp>;
let base: string;

async function post(actor: string, body: unknown) {
  const r = await fetch(`${base}/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

const api = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa", ...headers }, redirect: "manual" });

beforeAll(async () => {
  app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

  await post("pm", { kind: "reading", surface: "team", key: "focus", value: "P0: <login> broken & nobody on it" });
  await post("pm", { kind: "instruction", to: HUMAN, body: "approve the deploy", ack_by: new Date(Date.now() + 60_000).toISOString() });
  await post("pm", { kind: "instruction", to: "dev", body: "claim t-1 now", ack_by: new Date(Date.now() + 60_000).toISOString() });
  await post("pm", { kind: "task", op: "create", task: "t-1", title: "Cookie flags", criteria: ["cookie is SameSite=Lax", "no <script> on the page"] });
  await post("pm", { kind: "task", op: "create", task: "t-2", title: "Rate limit", criteria: ["429 after 100 rps"] });
  await post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["api/session.ts"] });
  await post("dev", { kind: "task", op: "done", task: "t-1", evidence: "sha 1234567" });
  await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "tests 14/14" });
  await post("dev", { kind: "reading", surface: "production", key: "users.count", value: 128, method: "select count(*)", depends_on: ["production:users"] });
  await post("dev", { kind: "note", body: "imported batch 3", writes: ["production:users"] });
  await post("qa", { kind: "reading", surface: "production", key: "health", value: "ok" });
});

afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("GET / · read-only HTML board", () => {
  it("is text/html and carries every section of /board, including task criteria", async () => {
    const [page, boardRes] = await Promise.all([api("/"), api("/board")]);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await page.text();
    const b = await boardRes.json();

    expect(html).toContain(esc(b.focus.body));                       // focus, escaped
    expect(html).not.toContain("<login>");
    expect(html).toContain("approve the deploy");                    // needs-human (instruction to human)
    expect(html).toContain("claim t-1 now");                         // open instruction
    for (const t of ["t-1", "t-2"]) expect(html).toContain(`<code>${t}</code>`);
    expect(html).toContain("cookie is SameSite=Lax");                // criteria
    expect(html).toContain(esc("no <script> on the page"));
    expect(html).toContain("429 after 100 rps");
    expect(html).toContain("sha 1234567");                           // evidence
    expect(html).toMatch(/verified on <b>repo<\/b> by qa/);          // verification
    expect(html).toContain("production:health");                     // valid reading
    expect(html).toContain("production:users.count");                // stale reading, with why
    expect(html).toMatch(/invalidated by/);
    for (const p of b.presence) expect(html).toContain(`<b>${p.actor}</b>`);
    expect(html).toContain("abc1234");                               // server sha in the footer
  });

  it("is read-only: no forms, no script, and refreshes no more often than every 30 s", async () => {
    const html = await (await api("/")).text();
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    const m = html.match(/http-equiv="refresh" content="(\d+)"/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(30);
    expect(REFRESH_SECONDS).toBeGreaterThanOrEqual(30);
  });

  it("needs the token: bearer header, or ?token= once which becomes a cookie", async () => {
    const bare = await fetch(`${base}/`, { redirect: "manual" });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("content-type")).toMatch(/^text\/html/);

    const wrong = await fetch(`${base}/?token=nope`, { redirect: "manual" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const once = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(once.status).toBe(303);
    expect(once.headers.get("location")).toBe("/");
    const cookie = once.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ateam_token=/);
    expect(cookie).toMatch(/HttpOnly/);

    const withCookie = await fetch(`${base}/`, { headers: { cookie: cookie.split(";")[0] } });
    expect(withCookie.status).toBe(200);
    expect(await withCookie.text()).toContain("Cookie flags");
  });

  it("does not need an X-Actor and leaves no trace: presence and cursors are untouched", async () => {
    const before = await (await api("/board")).json();
    await fetch(`${base}/`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const after = await (await api("/board")).json();
    expect(after.presence.map((p: { actor: string }) => p.actor)).toEqual(before.presence.map((p: { actor: string }) => p.actor));
  });

  it("leaves /health and /board unchanged", async () => {
    const h = await fetch(`${base}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true, sha: "abc1234" });
    const b = await api("/board");
    expect(b.headers.get("content-type")).toBe("application/json");
    const j = await b.json();
    expect(Object.keys(j).sort()).toEqual(["focus", "instructions", "needs_human", "now", "presence", "readings", "seams", "tasks"]);
    const noActor = await fetch(`${base}/board`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(noActor.status).toBe(400);
  });
});
