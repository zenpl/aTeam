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
  await post("qa", { kind: "note", body: "concern: <flag> may be stripped by the proxy", task: "t-1" });
  await post("dev", { kind: "note", body: "evidence: also on the default branch as 7654321", task: "t-1" });
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
    expect(html).toContain("+ also on the default branch as 7654321"); // evidence update from a note --task
    expect(html).toMatch(/<ul class="notes">.*<b>qa<\/b>.*concern: &lt;flag&gt; may be stripped by the proxy.*<b>dev<\/b>.*evidence: also on the default branch/s);
    expect(html.match(/<ul class="notes">/g)).toHaveLength(1);     // only t-1 has notes
    expect(html).toMatch(/verified on <b>repo<\/b> by qa/);          // verification
    expect(html).toContain("production:health");                     // valid reading
    expect(html).toContain("production:users.count");                // stale reading, with why
    expect(html).toMatch(/invalidated by/);
    for (const p of b.presence) expect(html).toContain(`<b>${p.actor}</b>`);
    expect(html).toContain("abc1234");                               // server sha in the footer
  });

  it("is read-only: no script, no forms other than answer buttons, and refreshes no more often than every 30 s", async () => {
    const html = await (await api("/")).text();
    const forms = html.match(/<form\b[^>]*>/gi) ?? [];
    expect(forms).toHaveLength(1);                                   // one open instruction to human, without options: a "Got it" form
    for (const f of forms) expect(f).toMatch(/action="\/(decide|ack)"/);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    const m = html.match(/http-equiv="refresh" content="(\d+)"/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(30);
    expect(REFRESH_SECONDS).toBeGreaterThanOrEqual(30);
  });

  it("is public read-only by default (decision 06:23); ?token= once still becomes a cookie, which the buttons need", async () => {
    const bare = await fetch(`${base}/`, { redirect: "manual" });
    expect(bare.status).toBe(200);
    expect(await bare.text()).toContain("Cookie flags");

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

describe("GET / with boardPublic off · the pre-decision behaviour stays one switch away", () => {
  let priv: ReturnType<typeof createApp>;
  let purl: string;
  beforeAll(async () => {
    priv = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, boardPublic: false });
    await new Promise<void>((r) => priv.listen(0, "127.0.0.1", r));
    purl = `http://127.0.0.1:${(priv.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => priv.close(() => r())));

  it("needs the token: bearer header, or the cookie from ?token=", async () => {
    const bare = await fetch(`${purl}/`, { redirect: "manual" });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("content-type")).toMatch(/^text\/html/);
    const bearer = await fetch(`${purl}/`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.status).toBe(200);
    const once = await fetch(`${purl}/?token=${TOKEN}`, { redirect: "manual" });
    expect(once.status).toBe(303);
    const withCookie = await fetch(`${purl}/`, { headers: { cookie: (once.headers.get("set-cookie") ?? "").split(";")[0] } });
    expect(withCookie.status).toBe(200);
  });
});

describe("POST /decide · one click acks the instruction and records the decision, as the human", () => {
  let ask: { id: string; body: string };
  beforeAll(async () => {
    ask = await post("pm", { kind: "instruction", to: HUMAN, body: "board auth: private (A) or public (B)?", ack_by: new Date(Date.now() + 60_000).toISOString(), options: ["A", "B"], default: "B" });
  });

  it("renders one button per option on the needs-human entry, default marked; buttons are disabled without the token", async () => {
    const anon = await (await fetch(`${base}/`)).text();
    const forms = (anon.match(/<form\b[^>]*>/gi) ?? []).filter((f) => f.includes('action="/decide"'));
    expect(forms).toHaveLength(1);
    expect(anon).toContain(`<input type="hidden" name="id" value="${ask.id}">`);
    expect(anon).toMatch(/<button[^>]*name="option" value="A"[^>]*disabled>A<\/button>/);
    expect(anon).toMatch(/<button[^>]*name="option" value="B"[^>]*class="default"[^>]*disabled>B <small>default<\/small><\/button>/);
    expect(anon).toContain("open <code>/?token=…</code> once");
    expect(anon).not.toMatch(/<script\b/i);

    const authed = await (await api("/")).text();
    expect(authed).toMatch(/<button[^>]*name="option" value="A"[^>]*>A<\/button>/);
    expect(authed).not.toMatch(/<button[^>]*\bdisabled\b/);
  });

  it("rejects a wrong option and an anonymous click, emitting nothing", async () => {
    const before = (await (await api("/log")).json()).events.length;
    const anon = await fetch(`${base}/decide`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${ask.id}&option=B` });
    expect(anon.status).toBe(401);
    const wrong = await fetch(`${base}/decide`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: `id=${ask.id}&option=C` });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ rule: "decide" });
    const unknown = await fetch(`${base}/decide`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: `id=nope&option=B` });
    expect(unknown.status).toBe(404);
    expect((await (await api("/log")).json()).events.length).toBe(before);
  });

  it("a browser click with the cookie emits ack + decision note by the human in one request and returns to /", async () => {
    const before = (await (await api("/log")).json()).events.length;
    const cookie = ((await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
    const click = await fetch(`${base}/decide`, { method: "POST", redirect: "manual",
      headers: { cookie, accept: "text/html,*/*", "content-type": "application/x-www-form-urlencoded" }, body: `id=${ask.id}&option=B` });
    expect(click.status).toBe(303);
    expect(click.headers.get("location")).toBe("/");

    const events = (await (await api("/log")).json()).events.slice(before);
    expect(events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([["ack", HUMAN], ["note", HUMAN]]);
    expect(events[0]).toMatchObject({ of: ask.id });
    expect(events[1]).toMatchObject({ decision: true, decides: { of: ask.id, option: "B" }, body: `decision: ${ask.body} -> B`, refs: [ask.id] });

    const b = await (await api("/board")).json();
    const i = b.instructions.find((x: { id: string }) => x.id === ask.id);
    expect(i).toMatchObject({ status: "acked", chosen: { option: "B", by: HUMAN } });
    expect(b.needs_human.map((n: { id: string }) => n.id)).not.toContain(ask.id);

    const page = await (await api("/")).text();
    expect(page).not.toMatch(/action="\/decide"/);
    expect(page).toContain("<b>⇒ B</b>");

    const again = await fetch(`${base}/decide`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `id=${ask.id}&option=A` });
    expect(again.status).toBe(409);
    expect((await again.json()).message).toContain("already decided");
  });
});

/** Visible text above the fold: everything before the details toggle, tags stripped, attribute values gone. */
function aboveTheFold(html: string): string {
  const cut = html.indexOf('<details class="more">');
  expect(cut).toBeGreaterThan(0);
  return html.slice(0, cut).replace(/<[^>]+>/g, " ");
}

describe("t-020 · a card page for the human: NEEDS YOU, STATUS, everything else behind a toggle", () => {
  beforeAll(async () => {
    await post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "ede0f06b9d08c4d7de900832bb32d829cad92ee6", method: "GET /health" });
    await post("qa", { kind: "task", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "seen on ateam.fly.dev" });
    await post("pm", { kind: "task", op: "create", task: "t-3", title: "Card page for the human", criteria: ["no ids above the fold"] });
    await post("frontend", { kind: "task", op: "claim", task: "t-3", touches: ["packages/server/src/html.ts"] });
    await post("pm", { kind: "task", op: "create", task: "t-4", title: "Watch survives errors", criteria: ["retries"] });
    await post("dev", { kind: "task", op: "claim", task: "t-4", touches: ["packages/cli/src/loop.ts"] });
    await post("dev", { kind: "task", op: "done", task: "t-4", evidence: "b6228e3 on the dev branch" });
    await post("pm", { kind: "instruction", to: "dev", body: "claim t-5 now, touching packages/core/src/rules.ts", ack_by: new Date(Date.now() - 60_000).toISOString() });
    await post("pm", { kind: "task", op: "create", task: "t-6", title: "Env beats config file", criteria: ["env wins"] });
    await post("dev", { kind: "task", op: "claim", task: "t-6", touches: ["packages/cli/src/config.ts"] });
    await post("dev", { kind: "task", op: "block", task: "t-6", on: "premise was wrong, see 01M1TP818FWVXP1YQV31X092RR and packages/cli/src/config.ts" });
  });

  it("above the fold: NEEDS YOU holds only questions for the human, STATUS speaks in titles; no ids, paths, long shas or agent instructions", async () => {
    const html = await (await api("/")).text();
    const fold = aboveTheFold(html);
    expect(html.indexOf('id="needs-you"')).toBeLessThan(html.indexOf('id="status"'));
    expect(html.indexOf('id="status"')).toBeLessThan(html.indexOf('<details class="more">'));

    expect(fold).toContain("approve the deploy");                    // the human's own question
    expect(fold).not.toContain("claim t-1 now");                     // pm → dev is not for the human
    expect(fold).not.toContain("claim t-5 now");                     // nor an overdue one
    expect(fold).toContain("ede0f06");                               // live build, short
    expect(fold).not.toContain("ede0f06b");                          // never the long sha
    expect(fold).toContain("Cookie flags");                          // verified on production → live
    expect(fold).toContain("Card page for the human (frontend)");    // being worked on
    expect(fold).toContain("Watch survives errors");                 // done, waiting for a check
    expect(fold).toMatch(/Being worked on[\s\S]*Card page/);
    expect(fold).toMatch(/Done, waiting for a check[\s\S]*Watch survives/);
    expect(fold).toMatch(/Blocked[\s\S]*Env beats config file \(dev\)/);
    expect(fold).not.toContain("premise was wrong");                 // a blocked_on reason stays below the fold
    for (const p of ["pm", "dev", "qa", "frontend"]) expect(fold).toContain(p);
    expect(fold).toContain("just now");

    expect(fold).not.toMatch(/\b[0-9A-HJKMNP-TV-Z]{26}\b/);           // no event ids
    expect(fold).not.toMatch(/[\w-]+\/[\w-]+\.[a-z]{2,3}\b/);        // no file paths
    expect(fold).not.toMatch(/\b[0-9a-f]{8,40}\b/);                  // no long shas
    expect(fold).not.toMatch(/\bt-\d+\b/);                           // titles, not task ids
    expect(html).not.toMatch(/<script\b/i);
  });

  it("the details toggle carries the rest: agent instructions, overdue, seams, readings, task ids", async () => {
    const html = await (await api("/")).text();
    const rest = html.slice(html.indexOf('<details class="more">'));
    expect(rest).toContain("claim t-1 now");
    expect(rest).toMatch(/Overdue[\s\S]*has not acked "claim t-5 now/);
    expect(rest).toContain("production:deployed.sha");
    expect(rest).toContain("<code>t-3</code>");
    expect(rest).toContain("packages/server/src/html.ts");
  });

  it("a question without options gets a 'Got it' button; POST /ack acks it as the human and returns to /", async () => {
    const ask = await post("pm", { kind: "instruction", to: HUMAN, body: "please read the deploy note", ack_by: new Date(Date.now() + 60_000).toISOString() });
    const html = await (await api("/")).text();
    expect(html).toContain(`<form class="decide" method="post" action="/ack"><input type="hidden" name="id" value="${ask.id}"><button type="submit">Got it</button></form>`);

    const anon = await fetch(`${base}/ack`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `id=${ask.id}` });
    expect(anon.status).toBe(401);
    const bad = await fetch(`${base}/ack`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/x-www-form-urlencoded" }, body: `id=nope` });
    expect(bad.status).toBe(409);

    const cookie = ((await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
    const click = await fetch(`${base}/ack`, { method: "POST", redirect: "manual", headers: { cookie, accept: "text/html", "content-type": "application/x-www-form-urlencoded" }, body: `id=${ask.id}` });
    expect(click.status).toBe(303);
    const b = await (await api("/board")).json();
    expect(b.instructions.find((i: { id: string }) => i.id === ask.id)).toMatchObject({ status: "acked" });
    expect(aboveTheFold(await (await api("/")).text())).not.toContain("please read the deploy note");
  });
});
