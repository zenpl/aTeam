/**
 * t-235：**人那一页随日志一起长，而没有任何判据覆盖它。**
 *
 * 实测（生产 `09256fd`，匿名 `GET /`，18:51）：整页 **272,462 字节**——`tasks` 95,814、`instructions` 73,212、
 * `readings` 55,811、`now` 23,991、样式 9,105、`seams` 7,594，**而人真正要看的那一栏「需要你」只有 5,312，
 * 整页的 2%**。三大块合计 82.5%，都随日志线性长；qa 16:16 量到 226KB，两个半小时后是 272,462，长了 20%。
 *
 * **这一页与瘦身板是两条路**（判据 2）：`slimBoard` 只在 `GET /board` 那一处用，这一页在进程内自己算一份完整
 * `board()` 去渲染，所以 t-070 给瘦身板加的上限对它一点用没有。
 */
import { describe, it, expect } from "vitest";
import { Builder, PAGE_BYTES, type Board, type State } from "@ateam/core";
import { renderBoard } from "../src/html.js";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const section = (html: string, id: string) => {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return "";
  const next = html.slice(at + 1).search(/<section[^>]*id="/);
  return next < 0 ? html.slice(at) : html.slice(at, at + 1 + next);
};

/** 一天的形状：几十件任务各带长正文，上百条指令与读数。 */
async function aDay(): Promise<{ b: Board; s: State }> {
  const bld = new Builder({ start: Date.now() - 6 * 3600_000, stepMs: 10_000 });
  const long = (n: number, s: string) => Array.from({ length: n }, (_, i) => `${s} ${i} ${"判据正文很长，说明人能看到什么".repeat(4)}`);
  await bld.reading("pm", "roles", ["pm", "dev", "qa", "frontend"], { surface: "project" });
  for (let i = 0; i < 40; i++) {
    const id = `t-${String(i).padStart(3, "0")}`;
    await bld.task.create("pm", id, `任务 ${i}`, long(3, "判据"), { no_human_impact: true });
    const owner = i % 2 ? "dev" : "frontend";
    await bld.task.claim(owner, id, [`packages/x/${i}.ts`]);
    await bld.task.done(owner, id, { evidence: `${(1000000 + i).toString(16)}abcd：${"证据正文".repeat(20)}`, shows: "人能看到的一句话" });
    if (i < 34) await bld.task.verify("qa", id, "repo", true, { evidence: "跑过了" });
  }
  for (let i = 0; i < 150; i++) {
    await bld.tell("pm", ["dev", "qa", "frontend"][i % 3], `第 ${i} 条：${"请你去做这件事".repeat(6)}`, { ackByMs: 3600_000 });
    await bld.reading("qa", `k${i}`, { n: i, note: "量出来的".repeat(8) }, { surface: "repo" });
  }
  const now = new Date();
  return { b: await bld.board(now), s: await bld.state(now) };
}

describe("t-235 判据 1 · 那一页有一个绝对上限", () => {
  it("PAGE_BYTES 是写死的 192 KiB，与瘦身板那个数是两回事（判据 2）", async () => {
    const { BOARD_BYTES } = await import("@ateam/core");
    expect(PAGE_BYTES).toBe(196_608);
    expect(PAGE_BYTES).not.toBe(BOARD_BYTES);
  });

  it("**给多小的预算就压到多小以内**，而且每一档都是真渲染出来量的", async () => {
    const { b, s } = await aDay();
    expect(bytes(renderBoard(b, s, {})), "样本本身要大到这件有意义").toBeGreaterThan(60_000);
    for (const limit of [120_000, 60_000, 30_000]) {
      expect(bytes(renderBoard(b, s, { limit })), `预算 ${limit}`).toBeLessThanOrEqual(limit);
    }
  });

  it("**「需要你」与「现在」两栏一个字不动**——砍的全在挖层里", async () => {
    const { b, s } = await aDay();
    const roomy = renderBoard(b, s, { limit: 10_000_000 });
    const tight = renderBoard(b, s, { limit: 30_000 });
    expect(section(tight, "needs-you")).toBe(section(roomy, "needs-you"));
    expect(section(tight, "now")).toBe(section(roomy, "now"));
  });

  it("**少印了几条要说出来**（判据 5，先用页面已有的那句「还有 N 件」）", async () => {
    const { b, s } = await aDay();
    const tight = renderBoard(b, s, { limit: 60_000 });
    const said = tight.match(/还有 \d+ 件/g) ?? [];
    expect(said.length, "静默截断正是这件要防的").toBeGreaterThan(0);
  });

  it("**栏目标题上的总数仍然是真总数**，不是印出来那几条的数", async () => {
    const { b, s } = await aDay();
    const tight = renderBoard(b, s, { limit: 25_000 });   // 紧到连任务那一栏也要折
    const verified = (b.tasks.verified ?? []).length;
    expect(verified).toBeGreaterThan(20);
    const tasks = section(tight, "tasks");
    expect(tasks).toContain(`<span class="meta">${verified}</span>`);   // 标题上仍是真总数
    // 而这一栏确实少印了几条，并且自己说了几条
    const hidden = [...tasks.matchAll(/还有 (\d+) 件/g)].map((m) => Number(m[1]));
    expect(hidden.length, "少印了却不说，正是这件要防的").toBeGreaterThan(0);
    expect(Math.max(...hidden)).toBeGreaterThan(0);
    expect(Math.max(...hidden), "少印的不会比总数还多").toBeLessThan(verified);
  });

  it("装得下的时候一刀不砍：小日志那一页与不给预算时逐字相同", async () => {
    const bld = new Builder({ start: Date.now() - 3600_000, stepMs: 10_000 });
    await bld.task.create("pm", "t-1", "一件小事", ["判据"], { no_human_impact: true });
    const now = new Date();
    const [b, s] = [await bld.board(now), await bld.state(now)];
    expect(renderBoard(b, s, {})).toBe(renderBoard(b, s, { limit: 10_000_000 }));
    expect(bytes(renderBoard(b, s, {})), "小日志本来就装得下").toBeLessThanOrEqual(PAGE_BYTES);
  });
});

/**
 * 判据 4：**客户搬家会一次把日志推过那道坎。** t-224 的导入路今天写完了，第一个客户是 human 自己的项目——
 * **他把旧记录导进来那一刻，日志长度是他带来的，不是我们攒的**。所以这一条照 t-224 判据 5 的做法，
 * 在一个**新建的空项目**上导一批，再去开那一页。
 */
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";
import { runImport, type Written } from "@ateam/cli/dist/import.js";
import { Client } from "@ateam/cli/dist/client.js";

describe("t-235 判据 4 · 搬进来一批之后，那一页还开得开", () => {
  it("空项目导 1,200 条旧记录 ⇒ `GET /` 仍在上限以内，「需要你」那一栏还在", async () => {
    const store = new MemoryStore();
    const app = createApp({ store, token: "k", human: "human", sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const client = new Client({ url: base, token: "k", me: "pm" });
      const lines = Array.from({ length: 1200 }, (_, i) =>
        JSON.stringify({ kind: "note", body: `旧队伍的第 ${i} 条记录：${"这是一条从别处搬过来的正文".repeat(4)}`, from: `VersaHub/notes/${i}` }));
      const exit = await runImport(lines.join("\n"), (e) => client.emit(e) as Promise<Written>, "pm", () => {}, () => {});
      expect(exit, "一条都不该被拒").toBe(0);
      expect((await store.read()).events.length).toBeGreaterThanOrEqual(1200);

      const r = await fetch(`${base}/`, { headers: { accept: "text/html" } });
      expect(r.status).toBe(200);
      const html = await r.text();
      expect(bytes(html), `搬完之后这一页 ${bytes(html)} 字节`).toBeLessThanOrEqual(PAGE_BYTES);
      expect(html).toContain('id="needs-you"');
    } finally { await new Promise<void>((r) => app.close(() => r())); }
  }, 60_000);
});
