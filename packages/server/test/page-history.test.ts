/**
 * t-307：**人那一页要小到永远打得开，而代价不许随项目活过多久增长。**
 *
 * 这一份量的是**真发出去的那串字节**，不是板的形状（板那一侧在 `packages/core/test/living-board.test.ts`）。
 * 基线是 qa 16:29 在生产上量的：给人那一份 5,732,267 字，tasks 53.7% ＋ instructions 26.4% ＝ **80% 是历史**。
 *
 * 判据⑤ 另立了一条禁令，这里逐字遵守：**不许把成因说成缓存**。`GET /` 早就走增量缓存（`stateFor`），
 * 而**缓存不封顶回包**——所以这一份一次都不量缓存，只量「这一页由什么组成」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { MemoryStore, append, PAGE_HISTORY_LINE, type NewEvent } from "@ateam/core";
import { createApp } from "../src/app.js";
import { ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const HTML = "text/html,application/xhtml+xml";
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

async function rig(store: MemoryStore) {
  const app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const cookie = await ownerCookie(base, TOKEN);
  return { base, cookie, close: () => new Promise<void>((r) => app.close(() => r())) };
}
const put = (store: MemoryStore, e: NewEvent) => append(store, e, { human: HUMAN });

/** 一段长文，用来撑大历史：真实的判据与证据就是这个量级。 */
const long = (n: number) => `第${n}条：${"这是一段很长的判据或证据文字，用来撑大历史。".repeat(8)}`;

/** `rounds` 轮历史：每一轮一件完结并上过生产的任务，加一条签收过、不带选项的指令。 */
async function history(store: MemoryStore, rounds: number) {
  await put(store, { kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "aaaaaaa1111", method: "GET /health" });
  for (let i = 1; i <= rounds; i++) {
    await put(store, { kind: "task", actor: "pm", op: "create", task: `t-${i}`, title: `完结${i}`, criteria: [long(1), long(2), long(3)], no_human_impact: true });
    await put(store, { kind: "task", actor: "dev", op: "claim", task: `t-${i}`, touches: [`src/${i}.ts`] });
    await put(store, { kind: "task", actor: "dev", op: "done", task: `t-${i}`, evidence: long(4) + long(5), no_human_impact: true });
    await put(store, { kind: "note", actor: "qa", body: long(6), task: `t-${i}` });
    await put(store, { kind: "task", actor: "qa", op: "verify", task: `t-${i}`, surface: "production", pass: true, evidence: long(7) });
    const card = await put(store, { kind: "instruction", actor: "pm", to: "dev", body: `${long(8)}（第 ${i} 条）`, ack_by: soon() });
    await put(store, { kind: "ack", actor: "dev", of: card.id });
  }
}

/** 活着的那几件：两份日志里一模一样，所以两次的差额只可能来自历史。 */
async function alive(store: MemoryStore) {
  await put(store, { kind: "reading", actor: "pm", surface: "team", key: "focus", value: "P0：人那一页要打得开" });
  await put(store, { kind: "task", actor: "pm", op: "create", task: "t-alive", title: "在做的那一件", criteria: ["成立"], no_human_impact: true });
  await put(store, { kind: "task", actor: "frontend", op: "claim", task: "t-alive", touches: ["packages/server/src/html.ts"] });
  await put(store, { kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？细节在任务上。", options: ["报表", "限流"], default: "报表", ack_by: soon() });
}

/**
 * t-314（qa 20:42 定的做法，我原来那条是 `toBeLessThan(8)`）：**把门槛去掉，不是把门槛放宽。**
 *
 * 判据②要说的话是「这一页不随历史长」，而它的残差是 **log n**：页上那几个计数器各多一位，就多几个字节。
 * 一个常数门槛去量一个对数的东西，换多大的常数都只是把假红推后——我自己量过它什么时候咬人：
 * 同一份夹具 10 轮 14,218 字节、100 轮 14,226，**差正好 8**，而我断言的是 `toBeLessThan(8)`，当场红，
 * 而那一刻的行为完全正确。
 *
 * 所以改成「抠掉数字之后两份逐字相同」：它不认是哪几个计数器在变（我先前写「两个计数器各多一位」是一个
 * 不必要的归因，qa 同样认了它自己那条「五个计数器」），**只认「这一页还是同一页，只是里面的数变了」**——
 * 那正是判据②那句话。
 *
 * **ULID 要先归一化，这一半是 qa 连踩过的坑一起交的**：只抠数字的话 `10=40` 就已经不等，而第一处不同在
 * 那个 `<input name="id" value="…">` 上——事件 id 每次跑都不同。**一条会红在「每次跑都不同的随机 id」上的
 * 用例，比一个常数门槛更坏。** 先换 id 再抠数字，顺序不能倒：抠完数字，ULID 就不再是 26 位了。
 */
const strip = (html: string) => html.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, "<id>").replace(/[0-9]/g, "");

async function page(rounds: number, extra?: (s: MemoryStore) => Promise<void>): Promise<string> {
  const store = new MemoryStore();
  const r = await rig(store);
  try {
    await history(store, rounds);
    if (extra) await extra(store);
    await alive(store);
    return await (await fetch(`${r.base}/`, { headers: { accept: HTML, cookie: r.cookie } })).text();
  } finally { await r.close(); }
}

describe("t-307 判据① · 这一页里历史的占比是 0", () => {
  let html = "";
  beforeAll(async () => { html = await page(20); });

  it("二十件完结并上过生产的任务，一个字都没进这一页；它们的判据、证据、留言也没有", () => {
    const rest = html.slice(html.indexOf('<details class="rest"'));
    expect(rest).not.toContain("这是一段很长的判据或证据文字");
    expect(rest.match(/<li class="brief">/g), "brief 短行是 t-065 当年的答案，而那些短行正是今天量到的 53.7%").toBeNull();
    for (let i = 1; i <= 20; i++) expect(rest, `t-${i}`).not.toContain(`完结${i}`);
  });

  it("签收过、不带选项的指令也没进；而活着的那几件在", () => {
    const rest = html.slice(html.indexOf('<details class="rest"'));
    expect(rest).toContain("在做的那一件");
    expect(rest).not.toContain("（第 20 条）");
  });

  /**
   * pd 18:15 定稿，而它比我的占位少了两样：**数，和那个链接**。
   *
   * 我的占位印的是「已经完结的 N 件任务、已经关上的 N 条指令」，并本来要补一句「要看某一件，用 `/task/<id>`」。
   * pd 两处都不要：那一问正是「得先知道 id」，而**一句指向一个到不了的地方的话比不指路更坏**——它让人以为
   * 路在那儿，是自己没找到。所以这一页说出的是**缺口本身**，直到入口真的存在。
   * 砍了几条仍然说得出来，在 `page_cut` 与 `omitted` 里——那是给机器的那一份（`living-board.test.ts` 钉它）。
   */
  it("这一页自己说出那个缺口：pd 的定稿一个字不改，而且它不指向一个人到不了的地方", () => {
    expect(html).toContain(PAGE_HISTORY_LINE);
    const rest = html.slice(html.indexOf('<details class="rest"'));
    // 这一段里不许出现一个要人先知道 id 才用得上的链接当作「去那儿看」的指路
    expect(PAGE_HISTORY_LINE).not.toContain("/task/");
    expect(rest).not.toContain("已经完结的 20 件任务");
  });

  it("人要答的那一张卡一个字不动：砍的全在挖层，首屏是这一页存在的理由（t-235 的口径）", () => {
    expect(html.slice(0, html.indexOf('<details class="rest"'))).toContain("先发哪个？");
  });
});

describe("t-307 · 三桶那一行不在人那一页上（pd 18:15 连读者一起定了）", () => {
  it("人那一页上一个字都没有：读者是节点，不是人——它印在 `ateam board` 上（`packages/cli/test/reach-line.test.ts` 钉它）", async () => {
    const html = await page(5);
    expect(html).not.toContain("发给你的还开着");
    expect(html, "三桶的字段名更不许上这一页").not.toMatch(/unread|acted/);
  });
});

describe("t-307 判据④ · 范围里含 `/release`，而不只 `GET /`", () => {
  it("`/release` 这一页也只印活着的事", async () => {
    const store = new MemoryStore();
    const r = await rig(store);
    try {
      await history(store, 12);
      await alive(store);
      const html = await (await fetch(`${r.base}/release`, { headers: { accept: HTML, cookie: r.cookie } })).text();
      expect(html).not.toContain("这是一段很长的判据或证据文字");
      for (let i = 1; i <= 12; i++) expect(html, `t-${i}`).not.toContain(`完结${i}`);
    } finally { await r.close(); }
  });

  /**
   * 这一条是**出处**上的量，不是行为上的量：行为那一侧在 `receipt.test.ts` 里（把 `read()` 整个打坏之后
   * 这两页照旧 200）。两条一起留，因为它们各自会在不同的日子里先红：有人把 `store.read()` 写回这一页时，
   * 这一条当场红；而行为那一条要等到有人真去打坏读取才红。
   */
  it("源码里，人碰得到的那两页一处都不叫全量重放", () => {
    const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const human = src.slice(src.indexOf('req.method === "GET" && path === "/"'), src.indexOf('path.startsWith("/task/")'))
      // 注释里**写着**那个形状（它说的正是「这一行原来是全量重放」），所以先把注释去掉再量：
      // 一道闸把一句解释它自己的注释判成违规，下一个人学到的是「别写注释」。
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(human).toContain("stateFor");
    expect(human, "`GET /` 与 `/release` 不许再从头读一遍日志").not.toMatch(/reduce\(await \w*store\.read\(\)/);
  });
});

/**
 * pm 18:50 在我的交付上报的形状，而立这条规矩的是 dev（它为 t-308 自己立的，判据没要）：
 * **`Reduction` 原地 settle，所以那一份 `state` 不许跨 `await` 拿着。** 跨了，那两个 `await` 期间别的请求
 * 可以把同一份 reduction 重新 settle 到另一个时刻，于是 await 之前算好的 `b` 与渲染时才读的 `state`
 * 可能在说两个不同的时刻。
 *
 * **这个形状比 t-307 早**（t-307 只把 `board(...)` 换成 `livingBoard(board(...))`），而它在我的触点上。
 * 修法是把要 `await` 的两样先取完。钉它的是源码的形状，因为这类缺陷**在单线程的用例里几乎不可能复现**：
 * 要两个请求在那两个 `await` 之间交错，而一条行为用例看不见它——所以这里量的是「有没有这个形状」。
 */
describe("t-307 · 那一份 state 不许跨 await 拿着（pm 18:50 的形状，dev 为 t-308 立的规矩）", () => {
  it("`GET /` 里，取到 state 与把它交给 renderBoard 之间一个 await 都没有", () => {
    const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const open = src.indexOf('req.method === "GET" && path === "/"');
    const body = src.slice(open, src.indexOf("renderBoard(", open));
    const got = body.lastIndexOf("const state = await stateFor");
    expect(got, "这一页还是得先有 state").toBeGreaterThan(0);
    const between = body.slice(got + "const state = await stateFor".length)
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(between, "要 await 的东西先取完，不许夹在 state 与渲染之间").not.toContain("await ");
  });

  it("`/release` 与 `/task/<id>` 同样：取到 state 之后直奔渲染", () => {
    const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    for (const [route, render] of [['path === "/release"', "renderRelease("], ['path.startsWith("/task/")', "renderTask("]] as const) {
      const open = src.indexOf(route);
      const body = src.slice(open, src.indexOf(render, open));
      const got = body.lastIndexOf("await stateFor");
      expect(got, `${route} 还是得先有 state`).toBeGreaterThan(0);
      const between = body.slice(got + "await stateFor".length).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(between, `${route}：state 与渲染之间不许有 await`).not.toContain("await ");
    }
  });
});

describe("t-307 判据② · 大小与项目活过多久无关", () => {
  it("历史涨十倍，这一页除了几个数字以外逐字不变（完结的任务 ＋ 签收过的指令）", async () => {
    const [one, four, hundred] = [await page(10), await page(40), await page(100)];
    const bytes = (x: string) => Buffer.byteLength(x, "utf8");
    const where = `10 轮 ${bytes(one)} ／ 40 轮 ${bytes(four)} ／ 100 轮 ${bytes(hundred)}`;
    expect(strip(four), where).toBe(strip(one));
    expect(strip(hundred), where).toBe(strip(one));
  });

  /**
   * **判据② 的另一半在 T15 手上，而它不是「我不愿意」，是一条代码事实**（`reduce.ts:637-643`）：
   * 一条从没被签收、也从没被任何事件引用过的指令，**永远算「还开着」**。于是它永远留在这一页上，
   * 而这种指令随项目活过的时间线性增多——pm 17:31 写进判据⑨ 的那份普查里，这是那 298 条。
   *
   * 上面那一条之所以成立，是因为**签收过的那一类（普查里的 2,247 条，88%）在这一页上算关上了**；
   * 剩下的这一类关不上，因为「关上」这件事此刻只有「有人引用它」一条路，而那条路住在 `reduce`，
   * 不在这一页上（pm 17:24 的裁定逐字如此）。
   *
   * **启用这条用例的义务挂在实现 T15 的那张单上**（pm 17:20 的两条附带之一），不在这一行注释里：
   * T15 落地之后把 `.skip` 去掉，它该当场变绿；若那时它仍是红的，说明 T15 没有真的关掉这一类。
   */
  it.skip("卡在 T15：办了但没引用的永远算开着——从没签收过的那一类涨四倍，这一页就跟着涨", async () => {
    const never = async (st: MemoryStore, rounds: number) => {
      for (let i = 1; i <= rounds; i++) await put(st, { kind: "instruction", actor: "pm", to: "release", body: `${long(9)}（没人签收，第 ${i} 条）`, ack_by: soon() });
    };
    const one = await page(1, (st) => never(st, 10));
    const four = await page(1, (st) => never(st, 40));
    // 与上面那一条**同一个断言**：T15 落地之后，这一类也该只差几个数字。
    // qa 20:39 量过此刻差多少：那 30 条多花 21,660 字节——不是数字，是整整 30 行。
    expect(strip(four), `10 条 ${Buffer.byteLength(one, "utf8")} ／ 40 条 ${Buffer.byteLength(four, "utf8")}`).toBe(strip(one));
  });
});
