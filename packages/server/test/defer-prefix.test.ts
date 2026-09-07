/**
 * t-161：页面判断人有没有说「先不做」时，读 core 的 DEFER_PREFIX，不用自己写死的那三个字。
 *
 * 这一处特别在于它**不是显示、是判定**。改错一个显示的字，人一眼看得见；改错一个判定的字，页面照样好好地渲染，
 * 只是把「先不做」认成了「知道了」——没有任何东西会喊。所以这里的用例一个中文字都不自己写：判据用的每一处
 * 「先不做」都从 core 取，措辞哪天改了，用例跟着改，而一个钉死字面量的实现会当场红。
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, DEFER_PREFIX, slimBoard, type Board } from "@ateam/core";
import { UI } from "../src/i18n.js";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";

function server() {
  const app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  let base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json() as { id: string };
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
  const page = async () => (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const board = async () => await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json() as Board;
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  return { post, page, board, start, stop: () => new Promise<void>((r) => app.close(() => r())) };
}

/**
 * A card to the human, acked, plus whatever note body the test wants to hang off it — and, so that a test can
 * compare the two answers, both what the page renders and what core decided (`GET /board?full=1`).
 */
async function withBoard(body: string | null, noteBy = HUMAN) {
  const v = server();
  await v.start();
  const card = await v.post("pm", { kind: "instruction", to: HUMAN, body: "外呼地址填一个？细节在任务上。", ack_by: new Date(Date.now() + 900_000).toISOString() });
  await v.post(HUMAN, { kind: "ack", of: card.id });
  if (body !== null) await v.post(noteBy, { kind: "note", body, refs: [card.id] });
  const html = await v.page();
  const b = await v.board();
  await v.stop();
  return { first: html.slice(0, html.indexOf('<details class="rest"')), b };   // 第一屏，「你刚定了」那一行在这里
}

/** Only the page, for the tests that are about the page's words. */
const deferred = async (body: string | null) => (await withBoard(body)).first;

describe("t-161 · 「先不做」是 core 的字，不是页面的字", () => {
  it("follows core's prefix: the body is built from DEFER_PREFIX, never typed out here", async () => {
    // 判据 2 的做法：用例不写那三个字，只从 core 取。core 里那句改成别的，这一行跟着改而断言仍然成立；
    // 一个钉死字面量的实现在那一刻会认不出来，用例当场红。
    const first = await deferred(`${DEFER_PREFIX}这周先不碰外呼`);
    expect(first).toContain(UI.notNow);
    expect(first).not.toContain(UI.gotIt);
  });

  it("a note that is not a deferral does not become one", async () => {
    const first = await deferred("外呼那件我看了，先放着");   // 像那么回事，但不是那个前缀
    expect(first).toContain(UI.didIt);
    expect(first).not.toContain(UI.notNow);
  });

  it("acking with no note at all is not a deferral either", async () => {
    const first = await deferred(null);
    expect(first).toContain(UI.didIt);
    expect(first).not.toContain(UI.notNow);
  });
});

/**
 * t-165：判定只读 core 的 deferred，页面不再自己推一遍。
 *
 * pm 08:04 要的是「等价性用测试证明，不是用推导」——今晚 t-142 与 t-136 栽的都是「推导看起来对」。所以下面三种
 * 状态是照它列的那三种造的，而且每一条都**同时**断言 core 说什么、页面说什么：两个答案在三种状态下一一对上，
 * 才叫等价；只断言页面，等价性仍然只是我的推导。
 */
describe("t-165 · 那个 || 回退删掉之后，判定与 core 一一对上", () => {
  const at = (b: Board) => b.instructions.find((i) => i.to === HUMAN && i.body.startsWith("外呼地址"))!;

  it("① core 说 deferred 为真 ⇒ 页面说「先不做」", async () => {
    const { first, b } = await withBoard(`${DEFER_PREFIX}这周先不碰外呼`, HUMAN);
    expect(at(b).deferred).toBeTruthy();
    expect(first).toContain(UI.notNow);
  });

  it("② 有一条以 DEFER_PREFIX 开头的 note，但不是人写的 ⇒ core 说假，页面也说不是", async () => {
    // 删掉的那个回退与 core 的条件逐条相同（actor 是 human、refs 含这条卡、正文以 DEFER_PREFIX 开头），
    // 所以这一条在删前删后都是「不是先不做」。它是 pm 列的第二种状态里唯一造得出来的形状。
    const { first, b } = await withBoard(`${DEFER_PREFIX}我替他先放着`, "pm");
    expect(at(b).deferred).toBeFalsy();
    expect(first).not.toContain(UI.notNow);
    expect(first).toContain(UI.didIt);
  });

  it("③ 两者都无 ⇒ core 说假，页面也说不是", async () => {
    const { first, b } = await withBoard(null, HUMAN);
    expect(at(b).deferred).toBeFalsy();
    expect(first).not.toContain(UI.notNow);
    expect(first).toContain(UI.didIt);
  });

  /**
   * 判据 3 要「瘦身板保留 deferred」有断言钉住。我照做了，但先更正我在 t-161 证据里说岔的两处——pm 那条判据
   * 是照我的推导写的，所以更正要指名：
   * ① **页面从来看不到瘦身板**：GET / 走的是 `board(state, human, now())` 直接进 renderBoard（app.ts），
   *    瘦身只发生在 GET /board。所以瘦身与这次删除无关，我当时把它当成等价性的一条支撑，那一条不相干。
   * ② 更要紧的：**这种卡根本不在瘦身板里**。slimBoard 的 instructions 过滤会把「已 ack、无选项、未选择」的
   *    整条丢掉，于是 deferred 保不保留对它毫无意义——我当初只看了「字段没被 map 掉」，没看承载它的那条还在不在。
   * 下面两条把真实情况钉住：这种形状整条不在；而一条真能活过瘦身的卡（带选项、已选择），deferred 确实还在。
   */
  it("④ 已 ack 无选项的卡整条不在瘦身板里——deferred 保不保留对它没有意义", async () => {
    const { b } = await withBoard(`${DEFER_PREFIX}这周先不碰外呼`, HUMAN);
    const slim = slimBoard(b);
    expect(at(b).deferred).toBeTruthy();                                    // 完整板上有
    expect(slim.instructions.find((i) => i.id === at(b).id)).toBeUndefined(); // 瘦身板上整条没了
  });

  it("⑤ 一条活得过瘦身的卡（带选项、已选择）：deferred 仍在，被瘦掉时这条会红", async () => {
    const v = server();
    await v.start();
    try {
      const card = await v.post("pm", { kind: "instruction", to: HUMAN, body: "先发哪个？两个都行。", options: ["报表", "限流"], default: "报表", ack_by: new Date(Date.now() + 900_000).toISOString() });
      await v.post(HUMAN, { kind: "note", body: "决定：先发报表", decision: true, decides: { of: card.id, option: "报表" } });
      await v.post(HUMAN, { kind: "note", body: `${DEFER_PREFIX}限流那条这周先不碰`, refs: [card.id] });
      const b = await v.board();
      const kept = slimBoard(b).instructions.find((i) => i.id === card.id);
      expect(kept, "这条卡也被瘦掉了，那这条断言换个形状再写").toBeTruthy();
      expect(kept!.deferred).toBeTruthy();
    } finally { await v.stop(); }
  });
});
