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
import { MemoryStore, append, type NewEvent } from "@ateam/core";
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

  it("这一页自己说出它少印了什么——少给而不自知是这几天数了二十多次的那一族", () => {
    expect(html).toContain("已经完结的 20 件任务");
    expect(html).toContain("已经关上的 20 条指令");
  });

  it("人要答的那一张卡一个字不动：砍的全在挖层，首屏是这一页存在的理由（t-235 的口径）", () => {
    expect(html.slice(0, html.indexOf('<details class="rest"'))).toContain("先发哪个？");
  });
});

describe("t-307（pm 17:27）· 三桶的数每次都印在这一页上", () => {
  it("开着的指令按 reach 分三桶，而数的是整份——不是这一页印出来的那几条", async () => {
    const html = await page(5);
    expect(html).toMatch(/还开着 \d+ 条：没送到眼前 \d+、拉过了没人引用 \d+、有人引用过 \d+/);
    expect(html, "`read` 那一桶的意思要说出来，否则它只是一个数").toContain("可能已经办完、只是账上没清");
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

describe("t-307 判据② · 大小与项目活过多久无关", () => {
  it("历史涨四倍，这一页一个字节都不涨（完结的任务 ＋ 签收过的指令）", async () => {
    const one = await page(10);
    const four = await page(40);
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    // 两份日志里活着的事件一模一样，所以差额只可能来自历史。差的那几个字节是那句「已经完结的 N 件任务」
    // 里的数字本身——它随历史变长，而它是**一句话**，不是一张随历史长的名单。
    expect(bytes(four) - bytes(one), `1 倍 ${bytes(one)} ／ 4 倍 ${bytes(four)}`).toBeLessThan(8);
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
    const never = async (s: MemoryStore, rounds: number) => {
      for (let i = 1; i <= rounds; i++) await put(s, { kind: "instruction", actor: "pm", to: "release", body: `${long(9)}（没人签收，第 ${i} 条）`, ack_by: soon() });
    };
    const one = await page(1, (s) => never(s, 10));
    const four = await page(1, (s) => never(s, 40));
    const bytes = (s: string) => Buffer.byteLength(s, "utf8");
    expect(bytes(four) - bytes(one), `1 倍 ${bytes(one)} ／ 4 倍 ${bytes(four)}`).toBeLessThan(8);
  });
});
