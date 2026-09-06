/**
 * 牌桌 v2 (t-034, docs/board.md). One layer for a glance, one to read, one to dig. These tests follow the
 * acceptance list at the end of board.md, plus what earlier tasks proved (escaping, no ids above the fold,
 * 说一句, folding, Chinese).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, reduce, board, append, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";
import { REFRESH_SECONDS, esc, waitingLine, renderBoard, renderTask, inlinedTasks, splitTitle, kindOf, cardKind, cardTitle, whyLine, tokenPage, previousSha, missingRole, latestReport } from "../src/html.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

function server(opts: Partial<Parameters<typeof createApp>[0]> = {}) {
  const app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234", ...opts });
  let base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
  // t-040: GET / is the board only for a browser (Accept: text/html); anything else gets the newcomer's manual.
  const api = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa", accept: "text/html,application/json", ...headers }, redirect: "manual" });
  const page = async (headers: Record<string, string> = {}) => (await fetch(`${base}/`, { headers: { accept: "text/html", ...headers } })).text();
  const authedPage = () => page({ authorization: `Bearer ${TOKEN}` });
  const cookie = async () => ((await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0];
  const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  const stop = () => new Promise<void>((r) => app.close(() => r()));
  return { get base() { return base; }, post, api, page, authedPage, cookie, form, start, stop };
}

/** Visible text above the fold (before the 其余 toggle), tags and style stripped. */
function fold(html: string): string {
  const cut = html.indexOf('<details class="rest"');
  expect(cut).toBeGreaterThan(0);
  return html.slice(0, cut).replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
}
const css = (html: string) => html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
const section = (html: string, id: string, nextId: string) => html.slice(html.indexOf(`id="${id}"`), html.indexOf(`id="${nextId}"`));

// ---------- a lived-in board ----------
const w = server();
let ask: { id: string }, doIt: { id: string }, tell: { id: string };
beforeAll(async () => {
  await w.start();
  await w.post("pm", { kind: "reading", surface: "team", key: "focus", value: "P0: <login> broken & nobody on it" });
  ask = await w.post("pm", { kind: "instruction", to: HUMAN, body: "看板认证选私有还是公开？细节：私有要每次带 token，公开谁都能看。", ack_by: soon(), options: ["私有", "公开"], default: "公开" });
  doIt = await w.post("pm", { kind: "instruction", to: HUMAN, body: "请把第 3 批推到 production：claude/frontend-j8z8jj@80ecd1a 与 42586d4 合进集成分支，CI 会部署。", ack_by: soon() });
  tell = await w.post("pm", { kind: "instruction", to: HUMAN, body: "今天不再部署了", ack_by: soon(), intent: "info" });
  await w.post("pm", { kind: "instruction", to: "dev", body: "claim t-1 now", ack_by: soon() });
  await w.post("pm", { kind: "instruction", to: "dev", body: "claim t-5 now, touching packages/core/src/rules.ts", ack_by: new Date(Date.now() - 60_000).toISOString() });
  // dev is listening (one pull), so the service raises no missing-role card for it (t-042/t-048); the cards below are the human's own
  await w.api("/events", { "x-actor": "dev" });
  await w.api("/events", { "x-actor": "frontend" });   // present = listening (t-047): a pull, not a post
  await w.post("pm", { kind: "task", op: "create", task: "t-1", title: "Cookie flags", criteria: ["cookie is SameSite=Lax", "no <script> on the page"] });
  await w.post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["api/session.ts"] });
  await w.post("dev", { kind: "task", op: "done", task: "t-1", evidence: "sha 1234567" });
  await w.post("qa", { kind: "task", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "tests 14/14" });
  await w.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "ede0f06b9d08c4d7de900832bb32d829cad92ee6", method: "GET /health" });
  await w.post("qa", { kind: "task", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "seen on ateam.fly.dev" });
  await w.post("pm", { kind: "task", op: "create", task: "t-2", title: "Rate limit", criteria: ["429 after 100 rps"] });
  await w.post("pm", { kind: "task", op: "create", task: "t-3", title: "Card page for the human", criteria: ["no ids above the fold"] });
  await w.post("frontend", { kind: "task", op: "claim", task: "t-3", touches: ["packages/server/src/html.ts"] });
  await w.post("pm", { kind: "task", op: "create", task: "t-4", title: "Watch survives errors", criteria: ["retries"] });
  await w.post("dev", { kind: "task", op: "claim", task: "t-4", touches: ["packages/cli/src/loop.ts"] });
  await w.post("dev", { kind: "task", op: "done", task: "t-4", evidence: "b6228e3 on the dev branch" });
  await w.post("pm", { kind: "task", op: "create", task: "t-6", title: "Env beats config file", criteria: ["env wins"] });
  await w.post("dev", { kind: "task", op: "claim", task: "t-6", touches: ["packages/cli/src/config.ts"] });
  await w.post("dev", { kind: "task", op: "block", task: "t-6", on: "premise was wrong, see 01M1TP818FWVXP1YQV31X092RR and packages/cli/src/config.ts, waiting for pm to decide whether this is worth doing at all" });
  await w.post("dev", { kind: "reading", surface: "production", key: "users.count", value: 128, method: "select count(*)", depends_on: ["production:users"] });
  await w.post("dev", { kind: "note", body: "imported batch 3", writes: ["production:users"] });
  await w.post("qa", { kind: "note", body: "concern: <flag> may be stripped by the proxy", task: "t-1" });
  await w.post("dev", { kind: "note", body: "evidence: also on the default branch as 7654321", task: "t-1" });
});
afterAll(() => w.stop());

describe("验收 1 · 首屏只有：需要你的卡、你刚定了、说一句、现在；其余折叠", () => {
  it("is text/html, in Chinese, with the sections in board.md order and everything else under 其余", async () => {
    const html = await w.authedPage();
    expect(html).toContain('<html lang="zh">');
    expect(html).toContain("<title>aTeam · 牌桌</title>");
    const order = ['id="needs-you"', 'id="say"', 'id="now"', 'id="rest"'].map((x) => html.indexOf(x));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((x) => x > 0)).toBe(true);
    const now = section(html, "now", "rest");
    for (const label of ["焦点", "线上", "在途", "谁在"]) expect(now).toContain(`<span class="label">${label}</span>`);
    expect(now).toContain(esc("P0: <login> broken & nobody on it"));  // focus, escaped
    expect(html).not.toContain("<login>");
    expect(html).not.toMatch(/<script\b/i);
    const m = html.match(/http-equiv="refresh" content="(\d+)"/);
    expect(Number(m![1])).toBeGreaterThanOrEqual(30);
    expect(REFRESH_SECONDS).toBeGreaterThanOrEqual(30);
    expect(html).toContain("abc1234");
  });

  it("the 其余 toggle carries agent instructions, overdue, seams, readings, tasks with ids, criteria and notes", async () => {
    const html = await w.authedPage();
    const rest = html.slice(html.indexOf('<details class="rest"'));
    expect(rest).toContain("claim t-1 now");
    expect(rest).toMatch(/逾期[\s\S]*dev 还没有确认来自 pm 的「claim t-5 now/);
    expect(rest).toContain("production:deployed.sha");
    expect(rest).toContain("Card page for the human");
    expect(rest).toContain("cookie is SameSite=Lax");
    expect(rest).toContain(esc("no <script> on the page"));
    expect(rest).toContain("sha 1234567");
    expect(rest).toContain("2 条留言 · <a href=\"/task/t-1\">看详情</a>");   // t-065: a finished task's notes are read on its page
    expect(rest).not.toContain("+ also on the default branch as 7654321");
    expect(rest).toMatch(/验过，在 <b>仓库<\/b>，由 qa/);
    expect(rest).toMatch(/已失效，原因 <code>/);
    expect(rest).toContain("packages/server/src/html.ts");
  });

  it("above the fold: no event ids, file paths, long shas, task ids or agent-to-agent instructions", async () => {
    const f = fold(await w.authedPage());
    expect(f).not.toContain("claim t-1 now");
    expect(f).not.toContain("claim t-5 now");
    expect(f).toContain("ede0f06");
    expect(f).not.toContain("ede0f06b");
    expect(f).not.toMatch(/\b[0-9A-HJKMNP-TV-Z]{26}\b/);
    expect(f).not.toMatch(/[\w-]+\/[\w-]+\.[a-z]{2,3}\b/);
    expect(f).not.toMatch(/\b[0-9a-f]{8,40}\b/);
    expect(f).not.toMatch(/\bt-\d+\b/);
    expect(f).toContain("premise was wrong, see … and …, waiting for pm to decide whe…");   // ids and paths masked, clipped to 60
  });
});

describe("验收 2 · 一种红、一种主色按钮、琥珀只给卡住/逾期、绿只给生产验过、字体分工", () => {
  it("red is only the 需要你 count and card edge; primary buttons = things to do; amber/green scoped; serif for questions and focus", async () => {
    const html = await w.authedPage();
    const style = css(html);
    const usesAlert = [...style.matchAll(/([^{}]+)\{[^{}]*var\(--alert\)[^{}]*\}/g)].map((m) => m[1].trim());
    for (const sel of usesAlert) expect(sel, `red used by ${sel}`).toMatch(/^\.(count|ask|kind)$/);
    const usesWarn = [...style.matchAll(/([^{}]+)\{[^{}]*var\(--warn\)[^{}]*\}/g)].map((m) => m[1].trim());
    for (const sel of usesWarn) expect(sel, `amber used by ${sel}`).toMatch(/^(\.chip\.warn|li\.warn \.dot|\.why|\.tag\.warn)$/);
    const usesGood = [...style.matchAll(/([^{}]+)\{[^{}]*var\(--good\)[^{}]*\}/g)].map((m) => m[1].trim());
    for (const sel of usesGood) expect(sel, `green used by ${sel}`).toMatch(/^(\.ok|\.who-chip i)$/);
    expect(style).toMatch(/\.q \{[^}]*var\(--serif\)/);
    expect(style).toMatch(/\.focus-text \{[^}]*var\(--serif\)/);
    expect(style).toMatch(/\.sha, code \{[^}]*var\(--mono\)/);
    expect(style).toMatch(/body \{[^}]*15px\/1\.7 var\(--sans\)/);
    expect(style).toMatch(/main \{[^}]*max-width:52rem/);
    expect(style).toMatch(/@media \(max-width:540px\) \{ \.row, \.focus \{ grid-template-columns:1fr; \}/);
    expect(style).toMatch(/@media \(prefers-color-scheme: dark\) \{ :root \{[^}]*--alert:#F08A7E/);

    const cards = (html.match(/<article class="ask"/g) ?? []).length;
    const primary = (html.match(/class="btn primary"/g) ?? []).length;
    expect(cards).toBe(3);
    expect(primary).toBe(cards);                                     // 说 is not primary
    expect(html).toMatch(/<span class="count">3<\/span>/);
  });
});

describe("验收 3 · 每张卡有种类与对应按钮；匿名点击走 token 小页面", () => {
  it("问你 / 请你做 / 告诉你: kind label, buttons, default marked, 「不点的话，到期按 X」", async () => {
    const html = await w.authedPage();
    const needs = section(html, "needs-you", "say");
    const card = (id: string) => { const i = needs.indexOf(`value="${id}"`); const s = needs.lastIndexOf("<article", i); return needs.slice(s, needs.indexOf("</article>", i)); };
    const a = card(ask.id), d = card(doIt.id), tl = card(tell.id);
    expect(a).toContain('data-kind="ask"');
    expect(a).toContain('<span class="kind">问你</span>');
    expect(a).toContain('<p class="q">看板认证选私有还是公开？</p>');         // the board's title drops the mark; the page puts 「？」 back
    expect(a).toMatch(/<details class="detail"><summary>细节<\/summary><p>细节：私有要每次带 token，公开谁都能看。<\/p><\/details>/);
    expect(a).toMatch(/<form class="actions" method="post" action="\/decide"><input type="hidden" name="id" value="[^"]+"><button class="btn" type="submit" name="option" value="私有">私有<\/button><button class="btn primary" type="submit" name="option" value="公开">公开 <small>默认<\/small><\/button><span class="hint">不点的话，到期按 公开<\/span><\/form>/);
    expect(d).toContain('<span class="kind">请你做</span>');
    expect(d).toContain('<p class="q">请把第 3 批推到 production</p>');
    expect(d).toContain("<summary>细节</summary><p>claude/frontend-j8z8jj@80ecd1a 与 42586d4 合进集成分支，CI 会部署。</p>");
    expect(d).toMatch(/<form class="actions" method="post" action="\/ack"><input type="hidden" name="id" value="[^"]+"><button class="btn primary" type="submit">做好了<\/button><button class="btn" type="submit" name="note" value="点了「先不做」，没写原因">先不做<\/button><\/form>/);
    expect(tl).toContain('<span class="kind">告诉你</span>');
    expect(tl).toContain('<p class="q">今天不再部署了</p>');
    expect(tl).not.toContain("细节");
    expect(tl).toMatch(/action="\/ack"><input[^>]+><button class="btn primary" type="submit">知道了<\/button><\/form>/);
    expect(needs).not.toMatch(/\bdisabled\b/);
  });

  it("anonymous: buttons stay clickable and post to /token carrying the action; the token page asks once, then does the action and returns", async () => {
    const anon = await w.page();
    const needs = section(anon, "needs-you", "say");
    expect(needs).not.toMatch(/\bdisabled\b/);
    expect(needs).toMatch(/<form class="actions" method="post" action="\/token"><input type="hidden" name="then" value="\/decide">/);
    expect(needs).toMatch(/<form class="actions" method="post" action="\/token"><input type="hidden" name="then" value="\/ack"><input type="hidden" name="id" value="[^"]+"><button class="btn primary" type="submit">做好了<\/button><button class="btn" type="submit" name="note" value="点了「先不做」，没写原因">先不做<\/button><\/form>/);
    expect(section(anon, "say", "now")).toContain('action="/token"><input type="hidden" name="then" value="/say">');

    // the token page carries the fields on
    const gate = await w.form("/token", { then: "/decide", id: ask.id, option: "公开" });
    expect(gate.status).toBe(200);
    const g = await gate.text();
    expect(g).toContain("<h2>输入 token</h2>");
    expect(g).toContain("要作答，先输入一次项目 token；之后 30 天不用再输。");
    expect(g).toContain('<input type="hidden" name="then" value="/decide">');
    expect(g).toContain(`<input type="hidden" name="id" value="${ask.id}">`);
    expect(g).toContain('<input type="hidden" name="option" value="公开">');
    expect(g).toMatch(/<input type="password" name="token"/);
    expect(g).not.toMatch(/<script\b/i);

    const wrong = await w.form("/token", { then: "/decide", id: ask.id, option: "公开", token: "nope" });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("token 不对，再试一次。");
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await w.form("/token", { then: "/decide", id: ask.id, option: "公开", token: TOKEN });
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/");
    const cookie = right.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ateam_token=/);
    expect(cookie).toMatch(/HttpOnly/);
    const b = await (await w.api("/board?full=1")).json();
    expect(b.instructions.find((i: { id: string }) => i.id === ask.id)).toMatchObject({ status: "acked", chosen: { option: "公开", by: HUMAN } });

    // now with the cookie the page shows 你刚定了 and the card is gone
    const after = await w.page({ cookie: cookie.split(";")[0] });
    expect(after).toMatch(/<p class="recent">你刚定了：看板认证选私有还是公开？ → <b>公开<\/b>/);
    expect(section(after, "needs-you", "say")).not.toContain(ask.id);
    expect(after).toMatch(/<span class="count">2<\/span>/);
    expect(section(after, "needs-you", "say")).not.toMatch(/action="\/token"/);
  });

  it("「先不做」acks and leaves a note in the human's name; 「做好了」/「知道了」ack; the card disappears and 你刚点了 appears", async () => {
    const cookie = await w.cookie();
    const before = (await (await w.api("/log")).json()).events.length;
    const defer = await w.form("/ack", { id: doIt.id, note: "点了「先不做」，没写原因" }, { cookie, accept: "text/html" });
    expect(defer.status).toBe(303);
    const events = (await (await w.api("/log")).json()).events.slice(before);
    expect(events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([["ack", HUMAN], ["note", HUMAN]]);
    expect(events[1]).toMatchObject({ body: "先不做：点了「先不做」，没写原因", refs: [doIt.id] });
    const bd = await (await w.api("/board?full=1")).json();
    expect(bd.instructions.find((i: { id: string }) => i.id === doIt.id).deferred).toMatchObject({ body: "点了「先不做」，没写原因" });

    const ack = await w.form("/ack", { id: tell.id }, { cookie, accept: "text/html" });
    expect(ack.status).toBe(303);
    const html = await w.page({ cookie });
    expect(section(html, "needs-you", "say")).toContain("没有等你的事。");
    expect(html).toMatch(/<p class="recent">你刚点了：今天不再部署了 → <b>知道了<\/b>/);
    // the deferred one reads 先不做 when it is the latest
    const again = await w.post("pm", { kind: "instruction", to: HUMAN, body: "请重启一次服务", ack_by: soon() });
    await w.form("/ack", { id: again.id, note: "点了「先不做」，没写原因" }, { cookie, accept: "text/html" });
    expect(await w.page({ cookie })).toMatch(/<p class="recent">你刚点了：请重启一次服务 → <b>先不做<\/b>/);
    expect((html.match(/class="btn primary"/g) ?? []).length).toBe(0);
    expect(html).not.toContain('<span class="count">');            // no red left on the page
    expect(css(html)).toContain("var(--alert)");                     // the token is defined, just unused

    const anon = await w.form("/ack", { id: tell.id });
    expect(anon.status).toBe(401);
  });
});

describe("验收 4 · 展开的列表 ≤5 行；指令首句作标题；相对时间；空态", () => {
  it("splitTitle and kindOf", () => {
    expect(splitTitle("部署第 3 批：把 x 合进 y。")).toEqual({ title: "部署第 3 批", detail: "把 x 合进 y。" });
    expect(splitTitle("看板认证：私有还是公开？")).toEqual({ title: "看板认证", detail: "私有还是公开？" });
    expect(splitTitle("看板认证：私有还是公开？细节：私有要每次带 token。")).toEqual({ title: "看板认证：私有还是公开？", detail: "细节：私有要每次带 token。" });
    expect(whyLine("see 01M1TP818FWVXP1YQV31X092RR and packages/cli/src/config.ts at ede0f06b9d08")).toBe("see … and … at …");
    expect(splitTitle("首屏能否不滚动看到需要你和现状？上一条可忽略。")).toEqual({ title: "首屏能否不滚动看到需要你和现状？", detail: "上一条可忽略。" });
    expect(splitTitle("这一句没有标点也没有细节")).toEqual({ title: "这一句没有标点也没有细节", detail: "" });
    const long = "这一句实在太长了远远超过了三十个字所以整句都必须当作标题来显示不能拆开：细节";
    expect(splitTitle(long)).toEqual({ title: "这一句实在太长了远远超过了三十个字所以整句都必须当作标题来显…", detail: long });
    expect([...splitTitle(long).title].length).toBe(31);
    expect(cardKind({ body: "今天不再部署", kind: "info" })).toBe("tell");
    expect(cardKind({ body: "今天不再部署", kind: "do" })).toBe("do");
    expect(cardTitle({ body: "x", title: "", detail: "全文太长没有标题" })).toEqual({ title: "全文太长没有标题", detail: "" });
    expect(cardTitle({ body: "x", title: "", detail: long })).toEqual({ title: "这一句实在太长了远远超过了三十个字所以整句都必须当作标题来显…", detail: long });
    expect(cardTitle({ body: "x", title: "标题", detail: "细节" })).toEqual({ title: "标题", detail: "细节" });
    expect(cardTitle({ body: "用哪种字体？细节见文档。", title: "用哪种字体", detail: "细节见文档。" })).toEqual({ title: "用哪种字体？", detail: "细节见文档。" });
    expect(cardTitle({ body: "部署第 3 批：把 x 合进 y。", title: "部署第 3 批", detail: "把 x 合进 y。" })).toEqual({ title: "部署第 3 批", detail: "把 x 合进 y。" });
    expect(whyLine("等 pm 定（01M1TP818FWVXP1YQV31X092RR，packages/cli/src/config.ts）再说")).toBe("等 pm 定再说");
    expect(kindOf({ body: "x", options: ["a", "b"] })).toBe("ask");
    expect(kindOf({ body: "请把分支合进去" })).toBe("do");
    expect(kindOf({ body: "今天不再部署了" })).toBe("tell");
  });

  it("线上 line, 在途 chips, working/blocked read, the rest dug; blocked reason in amber clipped to 60", async () => {
    const html = await w.authedPage();
    const now = section(html, "now", "rest");
    expect(now).toMatch(/<code class="sha">ede0f06<\/code> <span class="ok">在生产上验过 1 件<\/span> <span class="meta">· dev 刚刚核对<\/span>/);
    expect(now).toMatch(/<details class="more-list"><summary>这一版带来了什么<\/summary><ul class="plain"><li>Cookie flags<\/li><\/ul><\/details>/);
    expect(now).toMatch(/<span class="chip"><b>1<\/b> 在做<\/span><span class="chip warn"><b>1<\/b> 卡住<\/span><span class="chip"><b>1<\/b> 做完了，等验<\/span><span class="chip"><b>1<\/b> 没开始<\/span>/);
    expect(now).toMatch(/<div class="grp"><div class="grp-h">在做<\/div><ul class="tasks"><li><span class="dot"><\/span><span class="ttl">Card page for the human<\/span><span class="who">frontend<\/span><\/li><\/ul><\/div>/);
    expect(now).toMatch(/<div class="grp-h">卡住<\/div><ul class="tasks"><li class="warn"><span class="dot"><\/span><span class="ttl">Env beats config file<\/span><span class="who">dev<\/span><span class="why">premise was wrong, see … and …, waiting for pm to decide whe…<\/span>/);
    expect(now).toMatch(/<details class="grp"><summary class="grp-h">做完了，等验 <span class="meta">1 件<\/span><\/summary>/);
    expect(now).toMatch(/<details class="grp"><summary class="grp-h">没开始 <span class="meta">1 件<\/span><\/summary>/);
    expect(now).toMatch(/<span class="who-chip" data-role="frontend" data-status="listening"><i><\/i>frontend<span class="meta"><time[^>]*>刚刚<\/time><\/span><\/span>/);
    expect(now).toContain('<span class="who-chip away" data-role="pd" data-status="missing"><i></i>pd<span class="meta">缺人</span></span>');   // declared, never seen
  });

  it("more than 5 in an expanded group folds into 「还有 N 件」; 你说过的 folds into 「还有 N 句」; earlier versions nest under 这一版带来了什么", async () => {
    const v = server();
    await v.start();
    try {
      for (let i = 1; i <= 7; i++) {
        await v.post("pm", { kind: "task", op: "create", task: `t-${i}`, title: `任务${i}`, criteria: ["可用"] });
        await v.post("dev", { kind: "task", op: "claim", task: `t-${i}`, touches: [`src/${i}.ts`] });
      }
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
      for (const [id, title] of [["t-8", "登录修复"], ["t-9", "导出报表"]]) {
        await v.post("pm", { kind: "task", op: "create", task: id, title, criteria: ["可用"] });
        await v.post("dev", { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`] });
        await v.post("dev", { kind: "task", op: "done", task: id, evidence: "提交" });
        await v.post("qa", { kind: "task", op: "verify", task: id, surface: "production", pass: true, evidence: "线上看到" });
      }
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" });
      await v.post("pm", { kind: "task", op: "create", task: "t-10", title: "限流", criteria: ["可用"] });
      await v.post("dev", { kind: "task", op: "claim", task: "t-10", touches: ["src/10.ts"] });
      await v.post("dev", { kind: "task", op: "done", task: "t-10", evidence: "提交" });
      await v.post("qa", { kind: "task", op: "verify", task: "t-10", surface: "production", pass: true, evidence: "线上看到" });
      for (let i = 1; i <= 7; i++) await v.post(HUMAN, { kind: "note", body: `human 说：第${i}句` });

      const html = await v.authedPage();
      const now = section(html, "now", "rest");
      const working = now.slice(now.indexOf('<div class="grp-h">在做</div>'), now.indexOf('<div class="row"><span class="label">谁在</span>'));
      const shown = working.slice(0, working.indexOf('<details class="more-list">'));
      expect(shown.match(/<li>/g)).toHaveLength(5);
      expect(working).toMatch(/<details class="more-list"><summary>还有 2 件<\/summary><ul class="tasks">/);
      expect(shown).toContain("任务7");
      expect(now).toMatch(/<span class="chip"><b>7<\/b> 在做<\/span>/);

      expect(now).toMatch(/<span class="ok">在生产上验过 1 件<\/span>/); // pd 22:47 (B): this version's count only; the 2 earlier are in 更早的
      expect(now).toMatch(/<summary>这一版带来了什么 <span class="meta">自上一版 aaaaaaa 以来<\/span><\/summary><ul class="plain"><li>限流<\/li><\/ul><details class="more-list"><summary>更早的 2 件<\/summary><ul class="plain"><li>登录修复<\/li><li>导出报表<\/li><\/ul><\/details>/);

      const say = section(html, "say", "now");
      expect(say.match(/<li>/g)).toHaveLength(7);
      expect(say.slice(0, say.indexOf('<details class="more-list">')).match(/<li>/g)).toHaveLength(5);
      expect(say).toContain("<summary>还有 2 句</summary>");
      expect(say.indexOf("第7句")).toBeLessThan(say.indexOf("第6句"));
      expect(say).toContain("· 已收到</span>");

      const f = fold(html);
      expect(f).not.toMatch(/\bt-\d+\b/);
      expect(f).not.toMatch(/\b[0-9a-f]{8,}\b/);
    } finally { await v.stop(); }
  });

  it("线上 has three states: no sha reading; sha with nothing verified on it yet says so in words; sha with recent items lists them (t-060)", async () => {
    const v = server();
    await v.start();
    try {
      // 1. nobody checked which version is live
      expect(section(await v.authedPage(), "now", "rest")).toContain('<span class="quiet">还没人核对过线上是哪一版</span>');
      // 2. a sha is deployed, one task verified on the previous version, nothing yet on this one: a sentence, not an empty heading
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
      await v.post("pm", { kind: "task", op: "create", task: "t-1", title: "登录修复", criteria: ["可用"] });
      await v.post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["src/1.ts"] });
      await v.post("dev", { kind: "task", op: "done", task: "t-1", evidence: "提交" });
      await v.post("qa", { kind: "task", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上看到" });
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" });
      let now = section(await v.authedPage(), "now", "rest");
      expect(now).not.toContain("在生产上验过"); // pd 22:47 (B): no cumulative count beside the empty state
      expect(now).toMatch(/<code class="sha">bbbbbbb<\/code><\/div>\s*<div class="line"><span class="quiet">这一版刚上线，还没在生产验过<\/span><\/div><details class="more-list"><summary>更早的 1 件<\/summary><ul class="plain"><li>登录修复<\/li><\/ul><\/details>/);
      expect(now).not.toContain("这一版带来了什么");
      // 2b. first ever deploy, nothing verified anywhere: the same sentence, no 更早
      const f = server();
      await f.start();
      try {
        await f.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "ccccccc3333" });
        const first = section(await f.authedPage(), "now", "rest");
        expect(first).toMatch(/<code class="sha">ccccccc<\/code><\/div>\s*<div class="line"><span class="quiet">这一版刚上线，还没在生产验过<\/span><\/div>\s*<p class="meta contact-line">.*?<\/p>\s*<\/div>/);
        expect(first).not.toContain("更早的");
      } finally { await f.stop(); }
      // 3. something verified on this version: the list is back, the sentence is gone
      await v.post("pm", { kind: "task", op: "create", task: "t-2", title: "限流", criteria: ["可用"] });
      await v.post("dev", { kind: "task", op: "claim", task: "t-2", touches: ["src/2.ts"] });
      await v.post("dev", { kind: "task", op: "done", task: "t-2", evidence: "提交" });
      await v.post("qa", { kind: "task", op: "verify", task: "t-2", surface: "production", pass: true, evidence: "线上看到" });
      now = section(await v.authedPage(), "now", "rest");
      expect(now).toMatch(/<summary>这一版带来了什么 <span class="meta">自上一版 aaaaaaa 以来<\/span><\/summary><ul class="plain"><li>限流<\/li><\/ul><details class="more-list"><summary>更早的 1 件<\/summary>/);
      expect(now).not.toContain("这一版刚上线，还没在生产验过");
    } finally { await v.stop(); }
  });

  it("empty states are the board.md sentences, and there is no 你说过的 section", async () => {
    const e = server();
    await e.start();
    try {
      const html = await e.authedPage();
      expect(html).toContain('<section class="needs empty" id="needs-you"><h2>需要你</h2><p class="quiet">没有等你的事。</p></section>');
      expect(html).toContain('<p class="focus-text quiet">还没有焦点</p>');
      expect(html).toContain('<span class="quiet">还没人核对过线上是哪一版</span>');
      expect(html).toContain('<span class="quiet">没有在途的事</span>');
      // the declared roles are listed even on an empty board, all missing and never seen (t-042)
      for (const r of ["pd", "pm", "dev", "frontend", "qa"]) expect(html).toContain(`<span class="who-chip away" data-role="${r}" data-status="missing"><i></i>${r}<span class="meta">缺人</span></span>`);
      expect(html).not.toContain('<div class="grp-h">你说过的</div>');
      expect(html).toContain("你说过的会出现在这里");
      expect(html).not.toContain('<span class="count">');
      expect((html.match(/class="btn primary"/g) ?? []).length).toBe(0);
    } finally { await e.stop(); }
  });
});

describe("验收 5 · 公开/私有开关不变；说一句；中文界面", () => {
  it("public by default; boardPublic off needs the token for GET /; ?token= sets the cookie", async () => {
    const anon = await fetch(`${w.base}/`, { redirect: "manual", headers: { accept: "text/html" } });
    expect(anon.status).toBe(200);
    const curl = await fetch(`${w.base}/`, { redirect: "manual" });                       // t-040: a non-browser gets the manual
    expect(curl.headers.get("content-type")).toMatch(/^text\/markdown/);
    const once = await fetch(`${w.base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(once.status).toBe(303);
    expect(once.headers.get("set-cookie")).toMatch(/^ateam_token=.*HttpOnly/);
    const p = server({ boardPublic: false });
    await p.start();
    try {
      expect((await fetch(`${p.base}/`, { redirect: "manual", headers: { accept: "text/html" } })).status).toBe(401);
      expect((await fetch(`${p.base}/`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/html" } })).status).toBe(200);
    } finally { await p.stop(); }
    const h = await fetch(`${w.base}/health`);
    expect(await h.json()).toEqual({ ok: true, sha: "abc1234" });
    const b = await (await w.api("/board?full=1")).json();
    expect(Object.keys(b)).toContain("said");
    expect((await fetch(`${w.base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(400);
  });

  it("说一句 end to end: with the cookie, say → 303 → 已收到; a task --refs it → 已成为任务：<标题>; the input box sits between 需要你 and 现在", async () => {
    const v = server();
    await v.start();
    try {
      const cookie = await v.cookie();
      const say = await v.form("/say", { text: "登录页太慢了" }, { cookie, accept: "text/html" });
      expect(say.status).toBe(303);
      let html = await v.page({ cookie });
      const s = section(html, "say", "now");
      expect(html).toMatch(/<section class="say" id="say">\n<form class="" method="post" action="\/say"><input type="text" name="text" maxlength="500" placeholder="跟团队说一句：想要什么、什么坏了"/);
      expect(s).toContain('<button class="btn" type="submit">说</button>');
      expect(s).toMatch(/<li><span class="said-body">登录页太慢了<\/span> <span class="meta"><time[^>]*>刚刚<\/time> · 已收到<\/span><\/li>/);
      const b = await (await v.api("/board?full=1")).json();
      await v.post("pm", { kind: "task", op: "create", task: "t-1", title: "登录页加缓存", criteria: ["首屏 1 秒内"], refs: [b.said[0].id] });
      html = await v.page({ cookie });
      expect(section(html, "say", "now")).toContain("· 已成为任务：登录页加缓存</span>");
      expect(fold(html)).not.toContain(b.said[0].id);
      expect((await v.form("/say", { text: "   " }, { cookie })).status).toBe(400);
      expect((await v.form("/say", { text: "匿名" })).status).toBe(401);
    } finally { await v.stop(); }
  });

  it("no English UI word survives on a board whose content is Chinese; content is rendered as written", async () => {
    const z = server();
    await z.start();
    try {
      await z.post("pm", { kind: "reading", surface: "team", key: "focus", value: "人能读懂的看板" });
      await z.post("pm", { kind: "instruction", to: HUMAN, body: "看板认证：私有还是公开？", ack_by: soon(), options: ["私有", "公开"], default: "公开" });
      await z.post("pm", { kind: "instruction", to: HUMAN, body: "请读部署说明", ack_by: soon() });
      await z.post("pm", { kind: "instruction", to: HUMAN, body: "今天不再部署", ack_by: soon(), intent: "info" });
      await z.post("pm", { kind: "instruction", to: "dev", body: "认领 t-1", ack_by: new Date(Date.now() - 60_000).toISOString() });
      await z.post("pm", { kind: "instruction", to: "qa", body: "复核限流", ack_by: soon() });
      await z.post("pm", { kind: "task", op: "create", task: "t-1", title: "会话 cookie 标志", criteria: ["cookie 是 SameSite=Lax"] });
      await z.post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["api/session.ts"] });
      await z.post("dev", { kind: "task", op: "done", task: "t-1", evidence: "提交 1234567" });
      await z.post("qa", { kind: "task", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上看到" });
      await z.post("pm", { kind: "task", op: "create", task: "t-2", title: "限流", criteria: ["每秒 100 次后返回 429"] });
      await z.post("dev", { kind: "task", op: "claim", task: "t-2", touches: ["api/limit.ts"] });
      await z.post("dev", { kind: "task", op: "block", task: "t-2", on: "等 pm 定阈值" });
      await z.post("pm", { kind: "task", op: "create", task: "t-3", title: "看板中文化", criteria: ["无英文界面文字"] });
      await z.post("pm", { kind: "task", op: "create", task: "t-6", title: "导航改版", criteria: ["首页三步可达"] });
      await z.post("frontend", { kind: "task", op: "claim", task: "t-6", touches: ["web/nav.ts"] });
      await z.post("pm", { kind: "task", op: "create", task: "t-4", title: "日志脱敏", criteria: ["日志里没有邮箱"] });
      await z.post("dev", { kind: "task", op: "claim", task: "t-4", touches: ["api/log.ts"] });
      await z.post("dev", { kind: "task", op: "done", task: "t-4", evidence: "提交 2345678" });
      await z.post("pm", { kind: "task", op: "create", task: "t-5", title: "导出报表", criteria: ["能导出表格"] });
      await z.post("dev", { kind: "task", op: "claim", task: "t-5", touches: ["api/export.ts"] });
      await z.post("dev", { kind: "task", op: "done", task: "t-5", evidence: "提交 3456789" });
      await z.post("qa", { kind: "task", op: "verify", task: "t-5", surface: "repo", pass: true, evidence: "测试通过" });
      const q = await z.post("pm", { kind: "instruction", to: HUMAN, body: "先发哪个？", ack_by: soon(), options: ["报表", "限流"], default: "报表" });
      await z.post(HUMAN, { kind: "ack", of: q.id });
      await z.post(HUMAN, { kind: "note", body: "决定：先发报表", decision: true, decides: { of: q.id, option: "报表" } });
      await z.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "ede0f06b9d08c4d7de900832bb32d829cad92ee6", method: "读 /health" });
      await z.post("dev", { kind: "reading", surface: "production", key: "users.count", value: 128, depends_on: ["production:users"] });
      await z.post("dev", { kind: "note", body: "导入了第三批", writes: ["production:users"], task: "t-1" });
      await z.post("qa", { kind: "reading", surface: "production", key: "health", value: "ok", valid_until: new Date(Date.now() - 1000).toISOString() });
      await z.post(HUMAN, { kind: "note", body: "human 说：按钮太小" });

      for (const html of [await z.authedPage(), await z.page()]) {
        const ui = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<code[^>]*>[^<]*<\/code>/g, "").replace(/<[^>]+>/g, " ");
        for (const c of ["看板认证", "私有还是公开？", "请读部署说明", "今天不再部署", "会话 cookie 标志", "限流", "看板中文化", "日志脱敏", "导出报表", "先发哪个？", "等 pm 定阈值", "SameSite=Lax", "按钮太小"]) expect(ui).toContain(c);
        const words = ui.replace(/\b[0-9a-f]{7,}\b/g, "")
          .replace(/\b(pm|dev|qa|human|frontend|aTeam|repo|production|staging|team|ok|cookie|SameSite|Lax|Z|GET|POST|token|ateam|fly|seam|session|surface|key|agent)\b/g, "")   // agent: pd's own word in 「要更多 agent」
          .match(/[A-Za-z]{3,}/g) ?? [];
        expect(words, `English words on the page: ${[...new Set(words)].join(", ")}`).toEqual([]);
        for (const zh of ["aTeam · 牌桌", "需要你", "问你", "请你做", "告诉你", "做好了", "先不做", "知道了", "默认", "不点的话，到期按", "现在", "焦点", "线上", "在生产上验过", "核对", "在途", "在做", "卡住", "做完了，等验", "仓库验过，还没在生产验", "没开始", "谁在", "刚刚", "你说过的", "已收到", "其余：团队自己的状态", "逾期", "接缝", "事实", "已定", "human 选择了「报表」", "待送达", "仓库", "已失效", "已过期", "同一份数据"]) expect(ui, zh).toContain(zh);
      }
      expect(await (await fetch(`${z.base}/token`)).text()).toContain("输入 token");
    // the note on t-1 (verified before this version) is on the task page, whose labels are Chinese too (t-065)
      const tp = await (await fetch(`${z.base}/task/t-1`, { headers: { accept: "text/html" } })).text();
      expect(tp).toContain("导入了第三批");
      expect(tp.replace(/<style[\s\S]*?<\/style>/, "").replace(/<code>[^<]*<\/code>/g, "").replace(/<[^>]+>/g, " ")).not.toMatch(/\b(status|criteria|evidence|notes|task|by|seam)\b/i);
    } finally { await z.stop(); }
  });

  it("「自上一版 X 以来」names the previous deployed sha, never the current one; hidden when there is none", async () => {
    const v = server();
    await v.start();
    try {
      const ship = async (id: string, title: string) => {
        await v.post("pm", { kind: "task", op: "create", task: id, title, criteria: ["可用"] });
        await v.post("dev", { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`] });
        await v.post("dev", { kind: "task", op: "done", task: id, evidence: "提交" });
        await v.post("qa", { kind: "task", op: "verify", task: id, surface: "production", pass: true, evidence: "线上看到" });
      };
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "ede0f06b9d08" });
      await ship("t-1", "登录修复");
      expect(await v.authedPage()).not.toContain("自上一版");
      await v.post("human", { kind: "reading", surface: "production", key: "deployed.sha", value: "085624d04c7956ce5c328efb4d7c05c62271c3f2" });
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "085624d" });   // the same build, long then short
      await ship("t-2", "牌桌 v2");
      const html = await v.authedPage();
      expect(html).toContain("自上一版 ede0f06 以来");
      expect(html).not.toContain("自上一版 085624d");
      expect(previousSha(await (await v.api("/board?full=1")).json())).toBe("ede0f06");
    } finally { await v.stop(); }
  });

  it("an instruction decided by timeout reads 已按默认「X」执行（你仍可改）; tokenPage escapes its fields", async () => {
    const state = reduce(await new MemoryStore().read());
    const b: Board = board(state, HUMAN);
    b.instructions.push({ id: "01ASK", from: "pm", to: HUMAN, body: "部署方式 A 还是 B？", status: "acked", sent: b.now, acked: b.now, options: ["A", "B"], default: "B", chosen: { option: "B", by: "default", at: b.now } });
    const html = renderBoard(b, state, { human: HUMAN });
    expect(html).toContain("<b>已按默认「B」执行（你仍可改）</b>");
    expect(html).not.toContain("你刚定了");
    expect(tokenPage({ then: "/decide", id: "x", option: '<"&>' })).toContain('<input type="hidden" name="option" value="&lt;&quot;&amp;&gt;">');
  });
});

describe("t-043 · 起项目首屏的唯一一张卡与邀请链接、按角色的谁在、缺人卡（UC-S0 / UC-S7）", () => {
  const fresh = async () => {
    const state = reduce(await new MemoryStore().read());
    return { state, b: board(state, HUMAN) as Board & { invite_url?: string; presence: (Board["presence"][number] & { role?: string; present?: boolean; since?: string })[] } };
  };
  const minutesAgo = (b: Board, m: number) => new Date(Date.parse(b.now) - m * 60_000).toISOString();

  it("新项目：只有一张「问你」卡「这个项目是什么？说一句。」，无按钮，提示在下面说一句；卡下一行邀请链接带复制按钮", async () => {
    const { state, b } = await fresh();
    b.focus = { body: "等 human 说这个项目是什么", set_by: "pm", at: b.now };
    b.needs_human.push({ kind: "ask", id: "01ASK", from: "pm", body: "这个项目是什么？说一句。", title: "这个项目是什么", detail: "说一句。", summary: "", since: b.now } as Board["needs_human"][number]);
    b.invite_url = "https://ateam.fly.dev/invite/abc123";
    const html = renderBoard(b, state, { human: HUMAN });
    const needs = section(html, "needs-you", "say");
    expect(html.match(/<article class="ask"/g)).toHaveLength(1);
    expect(needs).toContain('<span class="kind">问你</span>');
    expect(needs).toContain('<p class="q">这个项目是什么？说一句。</p>');
    expect(needs).not.toContain("细节");
    expect(needs).toContain('<p class="hint answer">在下面「说一句」就是回答。</p>');
    expect(needs).not.toMatch(/<button class="btn[^"]*" type="submit"/);       // no answer buttons: the 说一句 box is the answer
    expect(needs).toContain('<p class="invite">要更多 agent，把这个链接给它们：<input class="invite-url" type="text" readonly value="https://ateam.fly.dev/invite/abc123" aria-label="邀请链接"><button class="btn copy" type="button" data-copy="https://ateam.fly.dev/invite/abc123">复制</button></p>');
    expect((html.match(/<script\b/g) ?? []).length).toBe(1);                   // only the copy button's script, only when a link is shown
    expect(html).toContain("navigator.clipboard.writeText");
    expect((html.match(/class="btn primary"/g) ?? []).length).toBe(0);
    expect(html).toContain('<span class="count">1</span>');
    // without an invite link: no line, no script
    delete b.invite_url;
    const plain = renderBoard(b, state, { human: HUMAN });
    expect(plain).not.toContain('class="invite"');
    expect(plain).not.toMatch(/<script\b/);
  });

  it("谁在按角色：在的绿点 + 多久前，缺的灰 + 「缺人 N 分钟」；老 board 没有角色字段时照旧按 actor", async () => {
    const { state, b } = await fresh();
    const row = (o: Partial<Board["presence"][number]> & { actor: string }) => ({ status: "listening", present: true, listening: true, last_pull: null, last_event: null, idle_pull_s: null, idle_event_s: null, last_seen: null, idle_s: null, since: null, ...o }) as Board["presence"][number];
    b.presence = [
      row({ actor: "pm", role: "pm", last_seen: minutesAgo(b, 2), idle_s: 120, since: minutesAgo(b, 2) }),
      row({ actor: "dev", role: "dev", last_seen: minutesAgo(b, 0.2), idle_s: 12, since: minutesAgo(b, 0.2) }),
      row({ actor: "qa", role: "qa", status: "missing", present: false, listening: false, last_seen: minutesAgo(b, 12), since: minutesAgo(b, 12), idle_s: 720 }),
      row({ actor: "pd", role: "pd", status: "missing", present: false, listening: false, last_seen: minutesAgo(b, 45), since: minutesAgo(b, 45), idle_s: 2700 }),
      row({ actor: "frontend", role: "frontend", status: "missing", present: false, listening: false }),
      row({ actor: "ops", role: "ops", status: "deaf", present: false, listening: false, last_event: minutesAgo(b, 1), last_pull: minutesAgo(b, 30), since: minutesAgo(b, 30), last_seen: minutesAgo(b, 1) }),   // speaks, does not pull
      row({ actor: "human", last_seen: minutesAgo(b, 1), idle_s: 60, since: minutesAgo(b, 1) }),   // outside the role set: not a chip
    ];
    b.undelivered = [{ to: "ops", count: 3, oldest_sent: minutesAgo(b, 20), listening: false }, { to: "qa", count: 1, oldest_sent: minutesAgo(b, 8), listening: false }];
    const html = renderBoard(b, state, { human: HUMAN });
    const who = html.slice(html.indexOf('<span class="label">谁在</span>'), html.indexOf("</section>", html.indexOf('<span class="label">谁在</span>')));
    expect(who).toMatch(/<span class="who-chip" data-role="pm" data-status="listening"><i><\/i>pm<span class="meta"><time[^>]*>2 分钟前<\/time><\/span><\/span>/);
    expect(who).toMatch(/<span class="who-chip" data-role="dev" data-status="listening"><i><\/i>dev<span class="meta"><time[^>]*>刚刚<\/time><\/span><\/span>/);
    expect(who).toContain('<span class="who-chip away" data-role="qa" data-status="missing"><i></i>qa<span class="meta">缺人 12 分钟 · 1 条没送到</span></span>');
    expect(who).toContain('<span class="who-chip away" data-role="pd" data-status="missing"><i></i>pd<span class="meta">缺人 45 分钟</span></span>');
    expect(who).toContain('<span class="who-chip away" data-role="frontend" data-status="missing"><i></i>frontend<span class="meta">缺人</span></span>');
    expect(who).toContain('<span class="who-chip away" data-role="ops" data-status="deaf"><i></i>ops<span class="meta">没在听 30 分钟 · 3 条没送到</span></span>');   // t-047 deaf + t-048 undelivered
    expect(who).not.toContain("human");
    expect(html).not.toContain('<span class="count">');                         // nobody is waiting on the human: no card, no red

    const old = (await fresh()).b;
    old.presence = [{ actor: "frontend", present: true, last_seen: minutesAgo(old, 1), idle_s: 60, since: null } as Board["presence"][number]];
    expect(renderBoard(old, state, { human: HUMAN })).toMatch(/<span class="who-chip"><i><\/i>frontend<span class="meta"><time[^>]*>1 分钟前<\/time>/);
  });

  it("缺人卡（决策 B）：服务生成的「qa 已经缺了 20 分钟，手里有 2 条指令。起一个 qa？」指令是一张请你做卡，「起好了」只 ack 它；页面不再自己合成卡", async () => {
    const { state, b } = await fresh();
    b.presence = [
      { actor: "pm", role: "pm", status: "listening", present: true, listening: true, last_seen: b.now, idle_s: 0, since: b.now } as Board["presence"][number],
      { actor: "qa", role: "qa", status: "missing", present: false, listening: false, last_seen: minutesAgo(b, 20), since: minutesAgo(b, 20), idle_s: 1200 } as Board["presence"][number],
    ];
    b.overdue.push({ instruction: "01OVER1", to: "qa", from: "pm", body: "验 t-1", ack_by: minutesAgo(b, 15), age_s: 900 });
    b.invite_url = "https://ateam.fly.dev/invite/abc123";
    // a missing role with overdue instructions alone makes no card: the server decides when to ask the human
    expect(renderBoard(b, state, { human: HUMAN })).not.toMatch(/<article class="ask"/);

    b.needs_human.push({ kind: "do", id: "01MISS", from: "pm", body: "qa 已经缺了 20 分钟，手里有 2 条指令。起一个 qa？", title: "qa 已经缺了 20 分钟，手里有 2 条指令", detail: "起一个 qa？", summary: "", since: minutesAgo(b, 1) } as Board["needs_human"][number]);
    const html = renderBoard(b, state, { human: HUMAN });
    expect(html.match(/<article class="ask"/g)).toHaveLength(1);
    const card = html.slice(html.indexOf('<article class="ask" data-kind="do">'), html.indexOf("</article>"));
    expect(card).toContain('<span class="kind">请你做</span>');
    expect(card).toContain('<p class="q">qa 已经缺了 20 分钟，手里有 2 条指令</p>');
    expect(card).toMatch(/<form class="actions" method="post" action="\/ack"><input type="hidden" name="id" value="01MISS"><button class="btn primary" type="submit">起好了<\/button><span class="hint">要更多 agent，把这个链接给它们：<code>https:\/\/ateam\.fly\.dev\/invite\/abc123<\/code><\/span><\/form>/);
    expect(card).not.toContain("先不做");
    expect(card).not.toContain("01OVER1");                                   // the role's own instructions are not touched
    expect(html).toContain('<span class="count">1</span>');
    expect((html.match(/class="btn primary"/g) ?? []).length).toBe(1);
    expect(missingRole({ body: "qa 已经缺了 20 分钟，手里有 2 条指令。起一个 qa？" })).toBe("qa");
    expect(missingRole({ body: "请部署", role: "dev" })).toBe("dev");
    expect(missingRole({ body: "qa 可能失联 12 分钟，3 条指令没送到。起一个 qa？" })).toBe("qa");   // t-048 wording, same card
    expect(missingRole({ body: "请部署" })).toBeNull();

    // the server acks every id in one request
    const v = server();
    await v.start();
    try {
      const a = await v.post("pm", { kind: "instruction", to: "qa", body: "验 t-1", ack_by: soon() });
      const c = await v.post("pm", { kind: "instruction", to: "qa", body: "验 t-2", ack_by: soon() });
      const cookie = await v.cookie();
      const r = await v.form("/ack", { id: a.id }, { cookie });
      expect(r.status).toBe(201);
      const r2 = await fetch(`${v.base}/ack`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `id=${a.id}&id=${c.id}` });
      expect(r2.status).toBe(409);                                              // the first id is already acked: the ack rule refuses, nothing else is written
      const r3 = await fetch(`${v.base}/ack`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `id=${c.id}` });
      expect(r3.status).toBe(201);
      const d = await v.post("pm", { kind: "instruction", to: "qa", body: "验 t-3", ack_by: soon() });
      const e = await v.post("pm", { kind: "instruction", to: "qa", body: "验 t-4", ack_by: soon() });
      const r4 = await fetch(`${v.base}/ack`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `id=${d.id}&id=${e.id}` });
      expect(r4.status).toBe(201);
      const bd = await (await v.api("/board?full=1")).json();
      for (const id of [a.id, c.id, d.id, e.id]) expect(bd.instructions.find((i: { id: string }) => i.id === id).status).toBe("acked");
    } finally { await v.stop(); }
  });
});

describe("协作报告不上首屏；挖层一行「最近一份协作报告」（pd 14:50 ③）", () => {
  it("names the latest docs/collab report from the notes, links it only when repo:url is a valid fact, never above the fold", async () => {
    const v = server();
    await v.start();
    try {
      let html = await v.authedPage();
      expect(html).toContain("最近一份协作报告：还没有协作报告");
      await v.post("pm", { kind: "note", body: "协作顺滑度报告第一份：docs/collab/2026-09-06-1435.md @ pm 分支 007f6c9，覆盖 05:58–14:34。" });
      await v.post("pm", { kind: "note", body: "第二份：docs/collab/2026-09-06-1635.md @ 1a2b3c4d5e6f，覆盖 14:35–16:34。" });
      await v.post("pm", { kind: "note", body: "补发的旧报告 docs/collab/2026-09-06-1200.md" });
      html = await v.authedPage();
      const rest = html.slice(html.indexOf('<details class="rest"'));
      expect(rest).toContain('<p class="meta report">最近一份协作报告：2026-09-06 16:35Z <code>docs/collab/2026-09-06-1635.md @ 1a2b3c4</code></p>');
      expect(rest).not.toContain("<a href");
      expect(fold(html)).not.toContain("协作报告");
      expect(fold(html)).not.toContain("docs/collab");

      await v.post("pm", { kind: "reading", surface: "repo", key: "url", value: "https://example.org/team/project" });
      html = await v.authedPage();
      expect(html).toContain('<a href="https://example.org/team/project/blob/1a2b3c4/docs/collab/2026-09-06-1635.md">2026-09-06 16:35Z</a>');
      const b = await (await v.api("/board?full=1")).json();
      const st = reduce(await new MemoryStore().read());
      expect(latestReport({ ...st, notes: [{ id: "n", actor: "pm", at: b.now, kind: "note", body: "docs/collab/2026-09-07-0900.md" }] } as unknown as typeof st, b)).toMatchObject({ path: "docs/collab/2026-09-07-0900.md", when: "2026-09-07 09:00Z", href: "https://example.org/team/project/blob/HEAD/docs/collab/2026-09-07-0900.md" });
    } finally { await v.stop(); }
  });
});

describe("t-056 · the page shows the owner's sentence, and folds the evidence under it", () => {
  it("live and verified rows prefer shows over the title; a task without shows reads as before", async () => {
    const store = new MemoryStore();
    const log = [
      { kind: "reading", actor: HUMAN, surface: "production", key: "deployed.sha", value: "abc1234", depends_on: ["production:deployed.sha"] },
      { kind: "task", op: "create", actor: "pm", task: "A", title: "牌桌显示 sha", criteria: ["works"] },
      { kind: "task", op: "create", actor: "pm", task: "B", title: "限流", criteria: ["works"] },
      { kind: "task", op: "claim", actor: "dev", task: "A", touches: ["A"] },
      { kind: "task", op: "claim", actor: "dev", task: "B", touches: ["B"] },
      { kind: "task", op: "done", actor: "dev", task: "A", evidence: "abc1234: <ul> 全绿", shows: "线上牌桌第一行是部署 sha" },
      { kind: "task", op: "done", actor: "dev", task: "B", evidence: "abc1234: 全绿" },
      { kind: "task", op: "verify", actor: "qa", task: "A", surface: "production", pass: true },
      { kind: "task", op: "verify", actor: "qa", task: "B", surface: "staging", pass: true },
    ];
    for (const e of log) await append(store, e as never, { human: HUMAN });
    const state = reduce(await store.read());
    const html = renderBoard(board(state, HUMAN), state, { sha: "abc1234", canDecide: true, human: HUMAN, base: "" });
    expect(html).toContain("<li>线上牌桌第一行是部署 sha</li>"); // this version's row: shows, not the title
    expect(html).toContain('<span class="ttl">限流</span>'); // verified elsewhere, no shows: the title as before
    const at = html.indexOf("<div>线上牌桌第一行是部署 sha</div>"); // in the task's details: shows first
    expect(at).toBeGreaterThan(0);
    expect(html.slice(at).replace(/\s+/g, " ")).toContain("<div>线上牌桌第一行是部署 sha</div> <details class=\"meta\"><summary>证据</summary>abc1234: &lt;ul&gt; 全绿</details>"); // then the evidence, folded
    // B was verified on staging only: on the board it is a title and a line (t-065); its evidence is on the task page
    expect(html).toContain('<li class="brief"><a href="/task/B">限流</a> <span class="meta">@dev · ✓ staging</span></li>');
    expect(html).not.toContain("证据：abc1234: 全绿");
    const pageB = renderTask(board(state, HUMAN), state, "B", { sha: "abc1234", human: HUMAN, base: "" })!;
    expect(pageB).toContain("<div class=\"meta\">证据：abc1234: 全绿</div>"); // no shows: evidence as before
  });
});

describe("t-065 · 挖层只带本版判据；GET /task/<id>", () => {
  it("earlier tasks are a title and a line linking to their page; this version's and moving tasks keep criteria inline", async () => {
    const html = await w.authedPage();
    const rest = html.slice(html.indexOf('<details class="rest"'));
    // t-3 is working: criteria, touches inline
    expect(rest).toContain("<summary>Card page for the human <span class=\"meta\">@frontend</span></summary>");
    expect(rest).toContain("no ids above the fold");
    // the shared fixture verifies t-1 on production after the sha reading, so it is this version's: inline too
    expect(inlinedTasks(JSON.parse(await (await w.api("/board")).text()))).toContain("t-1");
    expect(rest).toMatch(/<a href="\/task\/t-\d+">看详情<\/a>/);
  });

  it("an earlier task is brief on the board and full on its page; unknown id is 404; a private board keeps the page private", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
      await v.post("pm", { kind: "task", op: "create", task: "t-1", title: "登录修复", criteria: ["能登录", "记住我"] });
      await v.post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["src/login.ts"] });
      await v.post("dev", { kind: "task", op: "done", task: "t-1", evidence: "提交 1234567：两条都过" });
      await v.post("qa", { kind: "task", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上登录成功" });
      await v.post("qa", { kind: "note", body: "concern: 记住我在无痕窗口失效", task: "t-1" });
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" });
      // two moving tasks on the same file: an open seam, listed; once pm resolves it, only a count remains
      await v.post("pm", { kind: "task", op: "create", task: "t-2", title: "导出", criteria: ["可用"] });
      await v.post("pm", { kind: "task", op: "create", task: "t-3", title: "导入", criteria: ["可用"] });
      await v.post("dev", { kind: "task", op: "claim", task: "t-2", touches: ["src/io.ts"] });
      await v.post("frontend", { kind: "task", op: "claim", task: "t-3", touches: ["src/io.ts"] });
      let html = await v.page();
      let rest = html.slice(html.indexOf('<details class="rest"'));
      expect(rest).toContain('<li class="brief"><a href="/task/t-1">登录修复</a> <span class="meta">@dev · ✓ 生产</span></li>');
      for (const gone of ["能登录", "记住我", "提交 1234567", "线上登录成功", "无痕窗口"]) expect(rest).not.toContain(gone);
      expect(rest).toContain('<span class="tag warn">未解决</span> <a href="/task/t-3"><code>t-3</code></a> + <a href="/task/t-2"><code>t-2</code></a> 都涉及 <code>src/io.ts</code>');
      expect(rest).not.toContain("另有");
      await v.post("pm", { kind: "task", op: "seam", tasks: ["t-2", "t-3"], resolution: "frontend 合 dev" });
      html = await v.page();
      rest = html.slice(html.indexOf('<details class="rest"'));
      expect(rest).toMatch(/<section id="seams"><h3>接缝 <span class="meta">0 条未解决<\/span><\/h3>\n<p class="quiet">无<\/p>\n<p class="meta">另有 1 条已解决或先后落地，见各任务页<\/p>/);
      expect(rest).not.toContain("都涉及");
      // the seam is on both task pages
      const t2 = await (await fetch(`${v.base}/task/t-2`, { headers: { accept: "text/html" } })).text();
      expect(t2).toContain('<h3>接缝 <span class="meta">1</span></h3>');
      expect(t2).toContain('<span class="tag">pm 已解决</span> <a href="/task/t-3"><code>t-3</code></a> + <a href="/task/t-2"><code>t-2</code></a> 都涉及 <code>src/io.ts</code>');

      const r = await fetch(`${v.base}/task/t-1`, { headers: { accept: "text/html" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      const tp = await r.text();
      expect(tp).toContain("<title>登录修复 · aTeam · 牌桌</title>");
      expect(tp).not.toContain('http-equiv="refresh"');
      expect(tp).toContain('<a href="/">← 回牌桌</a>');
      expect(tp).toContain("<h2>登录修复</h2>");
      expect(tp).toContain('<p class="meta">验过 · @dev · ✓ 生产</p>');
      expect(tp).toContain("<ol class=\"criteria\"><li>能登录</li><li>记住我</li></ol>");
      expect(tp).toContain("证据：提交 1234567：两条都过");
      expect(tp).toMatch(/✓ 验过，在 <b>生产<\/b>，由 qa，<time[^>]*>刚刚<\/time>：线上登录成功/);
      expect(tp).toContain("涉及：<code>src/login.ts</code>");
      expect(tp).toContain("<b>qa</b>");
      expect(tp).toContain("concern: 记住我在无痕窗口失效");
      // the raw id only inside the fold for agents
      const above = tp.slice(0, tp.indexOf("<details"));
      expect(above.replace(/<style[\s\S]*?<\/style>/, "").replace(/<a [^>]*>/g, "")).not.toMatch(/\bt-1\b/);
      expect(tp).toContain("<summary>给 agent 看的</summary><code>t-1</code>");

      const missing = await fetch(`${v.base}/task/t-9`, { headers: { accept: "text/html" } });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("没有这个任务");
    } finally { await v.stop(); }

    const p = server({ boardPublic: false });
    await p.start();
    try {
      await p.post("pm", { kind: "task", op: "create", task: "t-1", title: "登录修复", criteria: ["能登录"] });
      expect((await fetch(`${p.base}/task/t-1`, { headers: { accept: "text/html" } })).status).toBe(401);
      expect((await fetch(`${p.base}/task/t-1`, { headers: { accept: "text/html", authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally { await p.stop(); }
  });

  it("the page does not grow with the log: 60 finished tasks with long notes and evidence render under 80KB, and only open seams are listed", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
      const long = (n: number) => `第${n}条：${"这是一段很长的判据或证据文字，用来撑大页面。".repeat(8)}`;
      for (let i = 1; i <= 60; i++) {
        await v.post("pm", { kind: "task", op: "create", task: `t-${i}`, title: `任务${i}`, criteria: [long(1), long(2), long(3), long(4), long(5)] });
        await v.post("dev", { kind: "task", op: "claim", task: `t-${i}`, touches: [`src/${i}.ts`, "src/shared.ts"] });
        await v.post("dev", { kind: "task", op: "done", task: `t-${i}`, evidence: long(6) + long(7) });
        for (let k = 0; k < 5; k++) await v.post("qa", { kind: "note", body: long(10 + k), task: `t-${i}` });
        await v.post("qa", { kind: "task", op: "verify", task: `t-${i}`, surface: "production", pass: true, evidence: long(8) });
      }
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" });
      const html = await v.page();
      expect(Buffer.byteLength(html)).toBeLessThan(80 * 1024);
      const rest = html.slice(html.indexOf('<details class="rest"'));
      expect(rest.match(/<li class="brief">/g)).toHaveLength(60);
      expect(rest).not.toContain("这是一段很长的判据或证据文字");
      // the log is long; the task page still has everything
      const tp = await (await fetch(`${v.base}/task/t-60`, { headers: { accept: "text/html" } })).text();
      expect(tp.match(/这是一段很长的判据或证据文字/g)!.length).toBeGreaterThan(10);
    } finally { await v.stop(); }
  });
});

describe("t-069 · 起项目第二张卡：你不在时怎么找你（pd 21:08）", () => {
  const CONTACT = "你不在时怎么找你？给个邮箱或 webhook；也可以先不要";
  // The feature is off by default (pm 22:39 after the human's 「外呼地址先不做」): a fact turns it on
  const ask = async (v: ReturnType<typeof server>) => {
    await v.post("pm", { kind: "reading", surface: "project", key: "alert.ask", value: true });
    return v.post("pm", { kind: "instruction", to: HUMAN, body: CONTACT, intent: "ask", options: ["填写", "先不要"], ack_by: soon() });
  };

  it("the card is 请你做 with pd's title and body, an input, 记下 (primary) and 先不要; anonymous goes through the token page; 记下 sets the address and the page says so", async () => {
    const v = server();
    await v.start();
    try {
      const { id } = await ask(v);
      let html = await v.page();
      const card = html.slice(html.indexOf('<article class="ask" data-kind="do">'), html.indexOf("</article>"));
      expect(card).toContain('<span class="kind">请你做</span>');
      expect(card).toContain('<p class="q">你不在时怎么找你？</p><p class="body">给个 webhook。全队都停了、或有事等你超过半小时，我们就往这里发一条。</p>');
      expect(card).toContain('<form class="actions contact" method="post" action="/token"><input type="hidden" name="then" value="/decide">');
      expect(card).toContain('<input type="text" name="value" placeholder="https://…" aria-label="https://…" autocomplete="off">');
      expect(card).toContain('<button class="btn primary" type="submit" name="option" value="填写">记下</button><button class="btn" type="submit" name="option" value="先不要">先不要</button>');
      expect(html).not.toContain('<p class="meta contact-line">'); // the card is on screen: no grey line under 线上
      expect(html).not.toContain("填写</button>"); // the option names are not what the human reads
      expect(html).not.toContain("邮箱"); // pd 22:45: the service only calls webhooks, so the page never promises email

      const cookie = await v.cookie();
      html = await v.page({ cookie });
      expect(html).toContain('<form class="actions contact" method="post" action="/decide">');
      // 记下 without an address is refused, and nothing is written
      const before = (await (await v.api("/events")).json()).events.length;
      expect((await v.form("/decide", { id, option: "填写", value: "  " }, { cookie, accept: "text/html" })).status).toBe(400);
      expect((await (await v.api("/events")).json()).events.length).toBe(before);
      const r = await v.form("/decide", { id, option: "填写", value: "https://hooks.example/me" }, { cookie, accept: "text/html" });
      expect(r.status).toBe(303);
      html = await v.page({ cookie });
      expect(html).not.toContain('data-kind="do"');
      expect(html).toContain('<p class="recent">你刚定了：<b>找你用 https://hooks.example/me</b>');
      expect(html).toContain('<p class="meta contact-line">你不在时发到 https://hooks.example/me</p>');
      const readings = (await (await v.api("/board")).json()).readings;
      expect(readings.find((x: { surface: string; key: string }) => x.surface === "project" && x.key === "alert.webhook")?.value).toBe("https://hooks.example/me");
    } finally { await v.stop(); }
  });

  it("先不要 closes the card and leaves the grey line; the grey line reopens the card, which posts the address alone", async () => {
    const v = server();
    await v.start();
    try {
      const { id } = await ask(v);
      const cookie = await v.cookie();
      expect((await v.form("/decide", { id, option: "先不要" }, { cookie, accept: "text/html" })).status).toBe(303);
      let html = await v.page({ cookie });
      expect(html).not.toContain('data-kind="do"');
      expect(html).toContain("你刚定了：你不在时怎么找你？ → <b>先不要</b>");
      expect(html).toContain('<p class="meta contact-line">你不在时，我们找不到你。</p>');

      html = await (await fetch(`${v.base}/?ask=alert`, { headers: { accept: "text/html", cookie } })).text();
      const card = html.slice(html.indexOf('<article class="ask" data-kind="do">'), html.indexOf("</article>"));
      expect(card).toContain('<p class="q">你不在时怎么找你？</p>');
      expect(card).toContain('<form class="actions contact" method="post" action="/fact"><input type="hidden" name="key" value="alert.webhook">');
      expect(card).toContain('<button class="btn primary" type="submit">记下</button><a class="btn" href="/">先不要</a>');
      expect(html).not.toContain('<p class="meta contact-line">');
      // anonymous reopen goes through the token page too
      const anon = await (await fetch(`${v.base}/?ask=alert`, { headers: { accept: "text/html" } })).text();
      expect(anon).toContain('<form class="actions contact" method="post" action="/token"><input type="hidden" name="then" value="/fact">');

      expect((await v.form("/fact", { key: "alert.webhook", value: "not an address" }, { cookie, accept: "text/html" })).status).toBe(400);
      expect((await v.form("/fact", { key: "alert.webhook", value: "me@example.org" }, { cookie, accept: "text/html" })).status).toBe(400); // only a webhook can be called
      expect((await v.form("/fact", { key: "deployed.sha", value: "https://h.example/x" }, { cookie, accept: "text/html" })).status).toBe(400);
      expect((await v.form("/fact", { key: "alert.webhook", value: "https://hooks.example/abc" }, { cookie, accept: "text/html" })).status).toBe(303);
      html = await v.page({ cookie });
      expect(html).toContain('<p class="meta contact-line">你不在时发到 https://hooks.example/abc</p>');
      // reopened with an address: the input is prefilled
      html = await (await fetch(`${v.base}/?ask=alert`, { headers: { accept: "text/html", cookie } })).text();
      expect(html).toContain('autocomplete="off" value="https://hooks.example/abc">');
      // the token page carries the address the anonymous human typed (then=/fact)
      expect((await v.form("/token", { then: "/fact", key: "alert.webhook", value: "https://hooks.example/xyz", token: TOKEN })).status).toBe(303);
      expect((await v.page({ cookie })).includes("你不在时发到 https://hooks.example/xyz")).toBe(true);
    } finally { await v.stop(); }
  });

  it("off by default: without the fact the card is hidden, there is no grey line, no reopen page and no /fact route", async () => {
    // the grey line is always there, not clickable, and truthful (pd 22:45)
    expect(await w.authedPage()).toContain('<p class="meta contact-line">你不在时，我们找不到你。</p>');
    expect(await w.authedPage()).not.toContain('?ask=alert');
    const v = server();
    await v.start();
    try {
      const { id } = await v.post("pm", { kind: "instruction", to: HUMAN, body: CONTACT, intent: "ask", options: ["填写", "先不要"], ack_by: soon() });
      const cookie = await v.cookie();
      let html = await v.page({ cookie });
      expect(html).not.toContain("你不在时怎么找你");
      expect(html).toContain('<p class="meta contact-line">你不在时，我们找不到你。</p>');
      expect(html).toContain('<section class="needs empty" id="needs-you">');
      html = await (await fetch(`${v.base}/?ask=alert`, { headers: { accept: "text/html", cookie } })).text();
      expect(html).not.toContain("你不在时怎么找你");
      expect((await v.form("/fact", { key: "alert.webhook", value: "https://hooks.example/me" }, { cookie, accept: "text/html" })).status).toBe(404);
      // one fact turns it on, no release needed: the card the data side already sent appears, and the address can be set
      await v.post("pm", { kind: "reading", surface: "project", key: "alert.ask", value: true });
      html = await v.page({ cookie });
      expect(html).toContain("<p class=\"q\">你不在时怎么找你？</p>");
      expect((await v.form("/decide", { id, option: "填写", value: "https://hooks.example/me" }, { cookie, accept: "text/html" })).status).toBe(303);
      expect(await v.page({ cookie })).toContain("你不在时发到 https://hooks.example/me");
      // an address recorded any other way also counts as on
      const u = server();
      await u.start();
      try {
        await u.post("pm", { kind: "reading", surface: "project", key: "alert.webhook", value: "https://hooks.example/x" });
        expect(await u.authedPage()).toContain('<p class="meta contact-line">你不在时发到 https://hooks.example/x</p>');
      } finally { await u.stop(); }
    } finally { await v.stop(); }
  });
});

describe("t-086 · 「线上」按来源署名：推的 / 核对", () => {
  it("names the pusher when the fact came from release --deploy, the checker when someone measured it, and nobody when the fact says neither", async () => {
    const v = server();
    await v.start();
    try {
      // measured: whoever wrote the reading only checked which version is live
      await v.post("qa", { kind: "reading", surface: "production", key: "deployed.sha", value: "eae0b22fd12", method: "curl /health 读到的" });
      let now = section(await v.page(), "now", "rest");
      expect(now).toContain('<span class="meta">· qa 刚刚核对</span>');
      expect(now).not.toContain("推的");
      // pushed: the deployer's own release --deploy wrote it
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222", method: "ateam release --deploy 推的" });
      now = section(await v.page(), "now", "rest");
      expect(now).toContain('<span class="meta">· dev 刚刚推的</span>');
      expect(now).not.toContain("核对");
      // a reading with no method says nothing about its source: the sha stands alone
      await v.post("pm", { kind: "reading", surface: "production", key: "deployed.sha", value: "ccccccc3333" });
      now = section(await v.page(), "now", "rest");
      expect(now).toContain('<code class="sha">ccccccc</code>');
      expect(now).not.toContain("推的");
      expect(now).not.toContain("核对");
    } finally { await v.stop(); }
  });

  it("shows both claims side by side when the board knows both, never merged into one", async () => {
    const store = new MemoryStore();
    await append(store, { kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "bbbbbbb2222", method: "ateam release --deploy 推的" } as never, { human: HUMAN });
    const state = reduce(await store.read());
    const b = board(state, HUMAN);
    b.live.checked_by = "qa"; // the same version pushed by one and checked by another
    const html = renderBoard(b, state, { human: HUMAN });
    expect(html).toContain('<span class="meta">· dev 刚刚推的</span> <span class="meta">· qa 刚刚核对</span>');
  });
});

describe("t-091 · 「线上」下常显：有 N 件已验的等一次部署", () => {
  const verified = async (v: ReturnType<typeof server>, id: string, title: string, sha: string) => {
    await v.post("pm", { kind: "task", op: "create", task: id, title, criteria: ["可用"] });
    await v.post("dev", { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`] });
    await v.post("dev", { kind: "task", op: "done", task: id, evidence: `${sha}: 全绿` });
    await v.post("qa", { kind: "task", op: "verify", task: id, surface: "repo", pass: true, evidence: "测试通过" });
  };
  const setup = async (v: ReturnType<typeof server>) => {
    await v.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111", method: "读 /health" });
    await verified(v, "t-1", "登录修复", "1111111");
    await verified(v, "t-2", "导出报表", "2222222");
  };
  const line = (html: string) => /<p class="meta waiting">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";

  it("says how many are verified and waiting; says nothing when none wait; says why instead of a number when it cannot tell", async () => {
    const v = server();
    await v.start();
    try {
      await setup(v);
      // no containment fact yet: the board cannot tell, so it says why and what to do, and invents no number
      let html = await v.page();
      expect(line(html)).toContain("不知道有多少件在等上线");
      expect(line(html)).toContain("<code>production:deployed.tasks</code>");
      expect(line(html)).toContain("<code>ateam release</code>");
      expect(html).not.toContain("有 0 件");

      // one of the two is not in production yet: exactly that one is waiting
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: "aaaaaaa1111", contained: ["t-1"], not_contained: ["t-2"] }, method: "ateam release 用 git 逐件测" });
      html = await v.page();
      expect(line(html)).toBe("1 件验过了，等一次上线。");
      expect(html).not.toContain("部署"); // pd: 上线 is the human's word, 部署 is the machine's

      // both in production: nothing waits, so the line is gone entirely
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: "aaaaaaa1111", contained: ["t-1", "t-2"], not_contained: [] }, method: "ateam release 用 git 逐件测" });
      html = await v.page();
      expect(html).not.toContain('class="meta waiting"');
      expect(html).not.toContain("等一次上线");
    } finally { await v.stop(); }
  });

  it("counts only what the data says, and the CLI says the same sentence from the same counts", async () => {
    const v = server();
    await v.start();
    try {
      await setup(v);
      await v.post("dev", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: "aaaaaaa1111", contained: [], not_contained: ["t-1", "t-2"] }, method: "ateam release 用 git 逐件测" });
      const b = JSON.parse(await (await v.api("/board?full=1")).text()) as Board;
      expect(b.release.counts).toMatchObject({ pending_deploy: 2, deployed_unverified: 0, unknown: 0 });
      expect(waitingLine(b)).toBe("2 件验过了，等一次上线。");
      expect(line(await v.page())).toBe("2 件验过了，等一次上线。");
      // the line states, it never asks: no link and no button in it
      expect(line(await v.page())).not.toMatch(/<a |<button|<form/);
    } finally { await v.stop(); }
  });
});

describe("t-095 · S9/M4 核对卡：搬过来了，对吗？", () => {
  const migrate = async (v: ReturnType<typeof server>) => {
    // one in-flight task, one decision, one fact and one open question, each carrying where it came from (t-088/t-089)
    await v.post("dev", { kind: "task", op: "create", task: "t-1", title: "登录修复", criteria: ["能登录"], from: "jira://PROJ-1" });
    await v.post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["src/login.ts"] });
    await v.post("dev", { kind: "note", body: "决定：先做登录", decision: true, from: "jira://PROJ-2" });
    await v.post("dev", { kind: "reading", surface: "staging", key: "users", value: 128, measured_at: new Date(Date.now() - 86_400_000).toISOString(), from: "jira://PROJ-3" });
    await v.post("dev", { kind: "instruction", to: HUMAN, body: "旧队伍等你答的问题", ack_by: soon(), from: "jira://PROJ-4" });
    // the importer says so in the log, and claims numbers of its own; the service counts what actually landed
    return v.post("dev", { kind: "note", body: "导入完成：我搬了 99 件任务、88 条决定", from: "jira://done-1" });
  };
  const card = (html: string) => {
    const needs = section(html, "needs-you", "say"); // the card, if it is still being asked; the dig layer keeps the answered one
    const i = needs.indexOf("搬过来了，对吗？");
    return i < 0 ? "" : needs.slice(needs.lastIndexOf("<article", i), needs.indexOf("</article>", i));
  };

  it("renders as 问你 with pd's title, the service's counts in the open, 对 primary and 有漏 plain", async () => {
    const v = server();
    await v.start();
    try {
      await migrate(v);
      const html = await v.page();
      const c = card(html);
      expect(c).toContain('data-kind="ask"');
      expect(c).toContain('<span class="kind">问你</span>');
      expect(c).toContain('<p class="q">搬过来了，对吗？</p>');
      // the four numbers are the service's, shown as body rather than folded away; the importer's 99/88 never appear
      expect(c).toContain('<p class="body">在途 1 件、1 条现行决定、1 个数字、1 个等你答的问题。搬来的数字都标了要重测。旧的那边一条没删。</p>');
      expect(c).not.toContain("99");
      expect(c).not.toContain("88");
      expect(c).not.toContain("<details");
      expect(c).toContain('<button class="btn primary" type="submit" name="option" value="对">对</button>');
      expect(c).toContain('<button class="btn" type="submit" name="option" value="有漏">有漏</button>');
      expect(c).not.toContain("默认"); // no default: the card waits for a real answer
    } finally { await v.stop(); }
  });

  it("「对」 leaves 你刚定了：清单对 and no card; 「有漏」 leaves 清单有漏 and 现在 says who is patching", async () => {
    const v = server();
    await v.start();
    try {
      const note = await migrate(v);
      const id = JSON.parse(await (await v.api("/board")).text()).needs_human.find((n: { body: string }) => n.body.startsWith("搬过来了"))!.id;
      const cookie = await v.cookie();
      expect((await v.form("/decide", { id, option: "对" }, { cookie, accept: "text/html" })).status).toBe(303);
      let html = await v.page({ cookie });
      expect(card(html)).toBe("");
      expect(html).toContain('<p class="recent">你刚定了：<b>清单对</b>');
      expect(html).not.toContain('class="meta patching"');

      // a second migration that the human says is incomplete
      const w = server();
      await w.start();
      try {
        await migrate(w);
        const id2 = JSON.parse(await (await w.api("/board")).text()).needs_human.find((n: { body: string }) => n.body.startsWith("搬过来了"))!.id;
        const c2 = await w.cookie();
        expect((await w.form("/decide", { id: id2, option: "有漏" }, { cookie: c2, accept: "text/html" })).status).toBe(303);
        const h2 = await w.page({ cookie: c2 });
        expect(card(h2)).toBe("");
        expect(h2).toContain('<p class="recent">你刚定了：<b>清单有漏，已让 dev 回去补</b>');
        expect(h2).toContain('<p class="meta patching">等 dev 补漏</p>');
      } finally { await w.stop(); }
      expect(note).toBeTruthy();
    } finally { await v.stop(); }
  });
});

describe("t-099 · 搬来的东西看得见来自哪一条", () => {
  const page = async (v: ReturnType<typeof server>, id: string) => (await fetch(`${v.base}/task/${id}`, { headers: { accept: "text/html" } })).text();

  it("a carried-in task and its decision note say where they came from, in code, after the criteria and the evidence", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("dev", { kind: "task", op: "create", task: "t-1", title: "登录修复", criteria: ["能登录"], from: "https://tracker.example.com/PROJ-42" });
      await v.post("dev", { kind: "task", op: "claim", task: "t-1", touches: ["src/login.ts"] });
      await v.post("dev", { kind: "task", op: "done", task: "t-1", evidence: "提交 1234567" });
      await v.post("dev", { kind: "note", body: "决定：先做登录", decision: true, task: "t-1", from: "chat://msg/998" });
      const html = await page(v, "t-1");
      // the source is a link only because this one is a URL; it sits after the criteria and the evidence
      expect(html).toContain('<div class="meta from">来自 <a href="https://tracker.example.com/PROJ-42"><code>https://tracker.example.com/PROJ-42</code></a></div>');
      expect(html.indexOf("能登录")).toBeLessThan(html.indexOf('class="meta from"'));
      expect(html.indexOf("提交 1234567")).toBeLessThan(html.indexOf('class="meta from"'));
      // the decision note carries its own source, in the same shape, right after the note
      expect(html).toContain('决定：先做登录<div class="meta from">来自 <code>chat://msg/998</code></div>');
      expect(html).not.toContain('<a href="chat://msg/998"'); // not a link one can follow: not a link
    } finally { await v.stop(); }
  });

  it("a source that is not a URL is code and not clickable; a task created here renders exactly as before", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("pm", { kind: "task", op: "create", task: "t-1", title: "导出报表", criteria: ["能导出"], from: "docs/plan.md#L20" });
      await v.post("pm", { kind: "task", op: "create", task: "t-2", title: "限流", criteria: ["每秒 100 次"] });
      for (const id of ["t-1", "t-2"]) await v.post("dev", { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`] });
      const carried = await page(v, "t-1"), local = await page(v, "t-2");
      expect(carried).toContain('<div class="meta from">来自 <code>docs/plan.md#L20</code></div>');
      expect(carried).not.toContain('<a href="docs/plan.md#L20"');
      // nothing at all for something created here: no label, no placeholder, no empty element
      expect(local).not.toContain("来自");
      expect(local).not.toContain('class="meta from"');
      expect(local).not.toContain("<div class=\"meta from\"></div>");
    } finally { await v.stop(); }
  });
});

describe("t-100 · 显示名撞了才附真 id", () => {
  const setup = async (v: ReturnType<typeof server>) => {
    // T-99 is another task's display name AND the third task's id: two different kinds of collision at once
    await v.post("pm", { kind: "task", op: "create", task: "L-1", title: "登录超时", criteria: ["可用"], label: "T-99" });
    await v.post("pm", { kind: "task", op: "create", task: "L-2", title: "导出乱码", criteria: ["可用"], label: "T-99" });
    await v.post("pm", { kind: "task", op: "create", task: "T-99", title: "限流", criteria: ["可用"] });
    await v.post("pm", { kind: "task", op: "create", task: "L-3", title: "日志脱敏", criteria: ["可用"], label: "T-07" });
    await v.post("pm", { kind: "task", op: "create", task: "L-4", title: "本地建的", criteria: ["可用"] });
    for (const id of ["L-1", "L-2", "T-99", "L-3", "L-4"]) await v.post("dev", { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`] });
  };
  const rest = (html: string) => html.slice(html.indexOf('<details class="rest"'));

  it("two rows sharing a display name, and a display name that is another row's id, carry the real id; the rest stay clean", async () => {
    const v = server();
    await v.start();
    try {
      await setup(v);
      const r = rest(await v.page());
      // both T-99 rows are ambiguous twice over: same name as each other, and the name is a real id
      expect(r).toContain("T-99 登录超时 (L-1)");
      expect(r).toContain("T-99 导出乱码 (L-2)");
      // a display name nobody else uses stays clean, and so does a task with no display name
      expect(r).toContain("T-07 日志脱敏");
      expect(r).not.toContain("T-07 日志脱敏 (L-3)");
      expect(r).toContain("本地建的");
      expect(r).not.toContain("本地建的 (L-4)");
      // the task whose id is T-99 has no display name of its own: it is not ambiguous, so nothing is appended
      expect(r).toContain("限流");
      expect(r).not.toContain("限流 (T-99)");
    } finally { await v.stop(); }
  });

  it("the task page uses the same heading, and nothing about the log changes", async () => {
    const v = server();
    await v.start();
    try {
      await setup(v);
      const page = await (await fetch(`${v.base}/task/L-1`, { headers: { accept: "text/html" } })).text();
      expect(page).toContain("<h2>T-99 登录超时 (L-1)</h2>");
      const clean = await (await fetch(`${v.base}/task/L-3`, { headers: { accept: "text/html" } })).text();
      expect(clean).toContain("<h2>T-07 日志脱敏</h2>");
      // ids and display names are untouched: the collision only changes what is printed
      const b = JSON.parse(await (await v.api("/board?full=1")).text()) as Board;
      const byId = Object.fromEntries(Object.values(b.tasks).flat().map((t) => [t.id, t]));
      expect(byId["L-1"].label).toBe("T-99");
      expect(byId["L-2"].label).toBe("T-99");
      expect(byId["T-99"].id).toBe("T-99");
    } finally { await v.stop(); }
  });
});
