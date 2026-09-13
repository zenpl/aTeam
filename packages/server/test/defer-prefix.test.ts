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
import { ownerKey, ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

/** t-234：人说话用他自己那把钥匙；管理钥匙不再代他说话。 */
let OWNER = "";
import { readFileSync } from "node:fs";

const TOKEN = "secret-token";
const HUMAN = "human";

function server() {
  const app = createApp({ ownerSecret: TEST_OWNER_SECRET, store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  let base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${actor === HUMAN ? OWNER : TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json() as { id: string };
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
  const page = async () => (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const board = async () => await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json() as Board;
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  OWNER = await ownerKey(base, TOKEN); };
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

/**
 * t-161 判据 2，按 pm 08:11 定的验收形态：t-165 删掉那个 fallback 之后，这一处只剩一个判定点，所以这条用例
 * 该红的原因是**「那三个字又被写回去了」**——源码级断言，与 t-136 那道闸同一族。
 *
 * 它只看字符串与模板字面量，不看注释：html.ts 里两处散文提到那三个字（一处引 human 说过的话、一处解释按钮），
 * 那是叙述不是谓词，拿它们当违规会逼人把正确的注释删掉。
 *
 * 扫法用的是一个走一遍字符的小状态机，不是正则。第一版我用正则挑字面量，它把注释里 `human's` 的那个撇号当成
 * 了字符串起头，于是把一整句注释报成了违规——**一个会误报的闸，比没有闸更贵**，所以这里宁可多写十行。
 */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i], nxt = src[i + 1];
    if (c === "/" && nxt === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && nxt === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c, start = i++;
      while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
      out.push(src.slice(start, ++i));
      continue;
    }
    i++;
  }
  return out;
}

/** 那三个字，从 core 的常量取（去掉冒号）——这份用例自己也不写死它。 */
const DEFER_WORDS = DEFER_PREFIX.replace(/[：:]$/, "");

describe("t-161 判据 2 · html.ts 里不许再出现那三个字的字面量", () => {
  it("源码里搜不到——谁写回去，这条当场红", () => {
    const src = readFileSync(new URL("../src/html.ts", import.meta.url), "utf8");
    const literals = stringLiterals(src);
    expect(literals.length, "字面量一个都没扫到，说明这条断言的扫法坏了，不是真的干净").toBeGreaterThan(20);
    const offenders = literals.filter((lit) => lit.includes(DEFER_WORDS));
    expect(offenders, `html.ts 里这些字面量写死了「${DEFER_WORDS}」，该读 core 的 DEFER_PREFIX：${offenders.join(" / ")}`).toEqual([]);
  });

  /**
   * t-168：扫法自己的正反例。**每个例子都要能把一个真的坏扫法认出来**——否则它只是看起来在守着。
   *
   * qa 08:19 抓到我第一版这里的一条假断言：为撇号 bug 写的那个 snippet 只有一个撇号，正则的 `'[^']*'` 配不上，
   * 于是那条断言在它要防的 bug 面前也是绿的。修法是把 snippet 换成带第二个撇号的（qa 给的），并且不再只靠人眼
   * 判断「这个例子够不够」：下面把两个真的坏扫法摆在这里，逐个例子断言好扫法与坏扫法**给出不同的答案**。
   * 一个连坏扫法都认不出来的例子，就是一条不会红的断言。
   */
  /** 第一版那个正则扫法：看不见注释，撇号会被当成字符串起头。 */
  const regexScan = (src: string) => src.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gs) ?? [];
  /** 按行切：完全看不见注释与字面量的分别。 */
  const naiveScan = (src: string) => src.split("\n");
  /** 整个扫法坏掉，什么都扫不出来——静默变绿的那一种。 */
  const emptyScan = () => [] as string[];
  const hits = (scan: (s: string) => string[], src: string) => scan(src).filter((l) => l.includes(DEFER_WORDS)).length;

  const cases: { name: string; src: string; want: number; caught: (s: string) => string[] }[] = [
    { name: "注释里那三个字不算违规", src: `// human 说了${DEFER_WORDS}\nconst a = "干净";`, want: 0, caught: naiveScan },
    // 这一条配的是 emptyScan 不是 naiveScan：按行切的扫法在这个 snippet 上也报 1，与好扫法同答案，挡不住它。
    // 我第一版就把它配成了 naiveScan，是这条「例子认不认得出坏扫法」的用例当场把它揪出来的。
    { name: "字面量里那三个字算", src: `const a = "${DEFER_WORDS}";`, want: 1, caught: emptyScan },
    // 两个撇号：正则的 '[^']*' 会从第一个撇号一路吞到第二个，把中间整段注释当成字符串
    { name: "注释里的撇号不该把后面整段吞成字符串", src: `/* the human's 「${DEFER_WORDS}」 and it's fine */\nconst a = "干净";`, want: 0, caught: regexScan },
  ];

  it.each(cases)("扫法自己是准的：$name", ({ src, want }) => {
    expect(hits(stringLiterals, src)).toBe(want);
  });

  it.each(cases)("而这个例子认得出坏扫法（否则它是一条不会红的断言）：$name", ({ src, want, caught }) => {
    expect(hits(caught, src), "好扫法与这个坏扫法给出同一个答案，说明这个例子挡不住它").not.toBe(want);
  });
});
