/**
 * 牌桌 v2 (t-034, docs/board.md). One layer for a glance, one to read, one to dig. These tests follow the
 * acceptance list at the end of board.md, plus what earlier tasks proved (escaping, no ids above the fold,
 * 说一句, folding, Chinese).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, reduce, board, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";
import { REFRESH_SECONDS, esc, renderBoard, splitTitle, kindOf, whyLine, tokenPage } from "../src/html.js";

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
  const api = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa", ...headers }, redirect: "manual" });
  const page = async (headers: Record<string, string> = {}) => (await fetch(`${base}/`, { headers })).text();
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
  ask = await w.post("pm", { kind: "instruction", to: HUMAN, body: "看板认证：私有还是公开？细节：私有要每次带 token，公开谁都能看。", ack_by: soon(), options: ["私有", "公开"], default: "公开" });
  doIt = await w.post("pm", { kind: "instruction", to: HUMAN, body: "请把第 3 批推到 production：claude/frontend-j8z8jj@80ecd1a 与 42586d4 合进集成分支，CI 会部署。", ack_by: soon() });
  tell = await w.post("pm", { kind: "instruction", to: HUMAN, body: "今天不再部署了", ack_by: soon() });
  await w.post("pm", { kind: "instruction", to: "dev", body: "claim t-1 now", ack_by: soon() });
  await w.post("pm", { kind: "instruction", to: "dev", body: "claim t-5 now, touching packages/core/src/rules.ts", ack_by: new Date(Date.now() - 60_000).toISOString() });
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
    expect(rest).toContain("<code>t-3</code>");
    expect(rest).toContain("cookie is SameSite=Lax");
    expect(rest).toContain(esc("no <script> on the page"));
    expect(rest).toContain("sha 1234567");
    expect(rest).toContain("+ also on the default branch as 7654321");
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
    expect(a).toContain('<p class="q">看板认证：私有还是公开？</p>');
    expect(a).toMatch(/<details class="detail"><summary>细节<\/summary><p>细节：私有要每次带 token，公开谁都能看。<\/p><\/details>/);
    expect(a).toMatch(/<form class="actions" method="post" action="\/decide"><input type="hidden" name="id" value="[^"]+"><button class="btn" type="submit" name="option" value="私有">私有<\/button><button class="btn primary" type="submit" name="option" value="公开">公开 <small>默认<\/small><\/button><span class="hint">不点的话，到期按 公开<\/span><\/form>/);
    expect(d).toContain('<span class="kind">请你做</span>');
    expect(d).toContain('<p class="q">请把第 3 批推到 production</p>');
    expect(d).toContain("<summary>细节</summary><p>claude/frontend-j8z8jj@80ecd1a 与 42586d4 合进集成分支，CI 会部署。</p>");
    expect(d).toMatch(/action="\/ack"><input[^>]+><button class="btn primary" type="submit" name="then" value="\/ack">做好了<\/button><button class="btn" type="submit" name="then" value="\/defer" formaction="\/defer">先不做<\/button>/);
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
    expect(needs).toMatch(/action="\/token"><input type="hidden" name="id" value="[^"]+"><button class="btn primary" type="submit" name="then" value="\/ack" formaction="\/token">做好了<\/button><button class="btn" type="submit" name="then" value="\/defer" formaction="\/token">先不做<\/button>/);
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
    const b = await (await w.api("/board")).json();
    expect(b.instructions.find((i: { id: string }) => i.id === ask.id)).toMatchObject({ status: "acked", chosen: { option: "公开", by: HUMAN } });

    // now with the cookie the page shows 你刚定了 and the card is gone
    const after = await w.page({ cookie: cookie.split(";")[0] });
    expect(after).toMatch(/<p class="recent">你刚定了：看板认证：私有还是公开？ → <b>公开<\/b>/);
    expect(section(after, "needs-you", "say")).not.toContain(ask.id);
    expect(after).toMatch(/<span class="count">2<\/span>/);
    expect(section(after, "needs-you", "say")).not.toMatch(/action="\/token"/);
  });

  it("「先不做」acks and leaves a note in the human's name; 「做好了」/「知道了」ack; the card disappears and 你刚点了 appears", async () => {
    const cookie = await w.cookie();
    const before = (await (await w.api("/log")).json()).events.length;
    const defer = await w.form("/defer", { id: doIt.id }, { cookie, accept: "text/html" });
    expect(defer.status).toBe(303);
    const events = (await (await w.api("/log")).json()).events.slice(before);
    expect(events.map((e: { kind: string; actor: string }) => [e.kind, e.actor])).toEqual([["ack", HUMAN], ["note", HUMAN]]);
    expect(events[1]).toMatchObject({ body: "human 先不做：请把第 3 批推到 production：claude/frontend-j8z8jj@80ecd1a 与 42586d4 合进集成分支，CI 会部署。", refs: [doIt.id] });

    const ack = await w.form("/ack", { id: tell.id }, { cookie, accept: "text/html" });
    expect(ack.status).toBe(303);
    const html = await w.page({ cookie });
    expect(section(html, "needs-you", "say")).toContain("没有等你的事。");
    expect(html).toMatch(/<p class="recent">你刚点了：今天不再部署了 → <b>知道了<\/b>/);
    // the deferred one reads 先不做 when it is the latest
    const again = await w.post("pm", { kind: "instruction", to: HUMAN, body: "请重启一次服务", ack_by: soon() });
    await w.form("/defer", { id: again.id }, { cookie, accept: "text/html" });
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
    expect(splitTitle(long)).toEqual({ title: long, detail: "" });
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
    expect(now).toMatch(/<span class="who-chip"><i><\/i>frontend<span class="meta"><time[^>]*>刚刚<\/time><\/span><\/span>/);
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

      expect(now).toMatch(/<span class="ok">在生产上验过 3 件<\/span>/);
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

  it("empty states are the board.md sentences, and there is no 你说过的 section", async () => {
    const e = server();
    await e.start();
    try {
      const html = await e.authedPage();
      expect(html).toContain('<section class="needs empty" id="needs-you"><h2>需要你</h2><p class="quiet">没有等你的事。</p></section>');
      expect(html).toContain('<p class="focus-text quiet">还没有焦点</p>');
      expect(html).toContain('<span class="quiet">还没人核对过线上是哪一版</span>');
      expect(html).toContain('<span class="quiet">没有在途的事</span>');
      expect(html).toContain('<span class="quiet">还没有人</span>');
      expect(html).not.toContain('<div class="grp-h">你说过的</div>');
      expect(html).toContain("你说过的会出现在这里");
      expect(html).not.toContain('<span class="count">');
      expect((html.match(/class="btn primary"/g) ?? []).length).toBe(0);
    } finally { await e.stop(); }
  });
});

describe("验收 5 · 公开/私有开关不变；说一句；中文界面", () => {
  it("public by default; boardPublic off needs the token for GET /; ?token= sets the cookie", async () => {
    const anon = await fetch(`${w.base}/`, { redirect: "manual" });
    expect(anon.status).toBe(200);
    const once = await fetch(`${w.base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(once.status).toBe(303);
    expect(once.headers.get("set-cookie")).toMatch(/^ateam_token=.*HttpOnly/);
    const p = server({ boardPublic: false });
    await p.start();
    try {
      expect((await fetch(`${p.base}/`, { redirect: "manual" })).status).toBe(401);
      expect((await fetch(`${p.base}/`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally { await p.stop(); }
    const h = await fetch(`${w.base}/health`);
    expect(await h.json()).toEqual({ ok: true, sha: "abc1234" });
    const b = await (await w.api("/board")).json();
    expect(Object.keys(b)).toContain("said");
    expect((await fetch(`${w.base}/board`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(400);
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
      const b = await (await v.api("/board")).json();
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
      await z.post("pm", { kind: "instruction", to: HUMAN, body: "今天不再部署", ack_by: soon() });
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
      await z.post("dev", { kind: "reading", surface: "production", key: "deployed.sha", value: "ede0f06b9d08c4d7de900832bb32d829cad92ee6" });
      await z.post("dev", { kind: "reading", surface: "production", key: "users.count", value: 128, depends_on: ["production:users"] });
      await z.post("dev", { kind: "note", body: "导入了第三批", writes: ["production:users"], task: "t-1" });
      await z.post("qa", { kind: "reading", surface: "production", key: "health", value: "ok", valid_until: new Date(Date.now() - 1000).toISOString() });
      await z.post(HUMAN, { kind: "note", body: "human 说：按钮太小" });

      for (const html of [await z.authedPage(), await z.page()]) {
        const ui = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<code[^>]*>[^<]*<\/code>/g, "").replace(/<[^>]+>/g, " ");
        for (const c of ["看板认证", "私有还是公开？", "请读部署说明", "今天不再部署", "会话 cookie 标志", "限流", "看板中文化", "日志脱敏", "导出报表", "先发哪个？", "等 pm 定阈值", "导入了第三批", "SameSite=Lax", "按钮太小"]) expect(ui).toContain(c);
        const words = ui.replace(/\b[0-9a-f]{7,}\b/g, "")
          .replace(/\b(pm|dev|qa|human|frontend|aTeam|repo|production|staging|team|ok|cookie|SameSite|Lax|Z|GET|POST|token|ateam|fly|seam|session|surface|key)\b/g, "")
          .match(/[A-Za-z]{3,}/g) ?? [];
        expect(words, `English words on the page: ${[...new Set(words)].join(", ")}`).toEqual([]);
        for (const zh of ["aTeam · 牌桌", "需要你", "问你", "请你做", "告诉你", "做好了", "先不做", "知道了", "默认", "不点的话，到期按", "现在", "焦点", "线上", "在生产上验过", "核对", "在途", "在做", "卡住", "做完了，等验", "验过了，还没上线", "没开始", "谁在", "刚刚", "你说过的", "已收到", "其余：团队自己的状态", "逾期", "接缝", "事实", "已定", "human 选择了「报表」", "待送达", "仓库", "已失效", "已过期", "同一份数据"]) expect(ui, zh).toContain(zh);
      }
      expect(await (await fetch(`${z.base}/token`)).text()).toContain("输入 token");
    } finally { await z.stop(); }
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
