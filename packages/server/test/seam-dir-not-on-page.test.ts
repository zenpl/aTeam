/**
 * t-280 判据：**pm 03:24 的第 ② 条——「只撞在目录上」这一类，`GET /` 上一个字都不许出现。**
 *
 * 理由不是范围，是话：那一页现在能说的只有 t-114 那句「都动了同一个文件、各自的符号不相交」，而对这一类
 * 它每个分句都不成立（两边没动同一个文件；句子点名的文件只有一侧动过；根本没有符号）。那句话是 pd 定稿的，
 * dev 不自拟，所以在 pd 给出这一类的话之前，这一类不上那一页。
 *
 * 钉法照 t-279 那条：**先造出那个状态、证明它真的成立**，再证那一页上确实没有它。
 * 再加一条 pm 点名要的：**渲染与「这一类根本不存在」时逐字相同**——不是「我没往那边写」，是「那边一个字节都没变」。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SEAM_DIR_ONLY, reduce, board } from "@ateam/core";
import { createApp } from "../src/app.js";
import { renderBoard, renderTask } from "../src/html.js";

const TOKEN = "t";
let app: ReturnType<typeof createApp>;
let store: MemoryStore;
let base = "";
/** 不带 accept: text/html 的 GET / 回的是手册，不是那一页——在它上面断言「没有」永远成立，等于没断言。 */
const getPage = async () => (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
const post = (actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  store = new MemoryStore();
  app = createApp({ store, token: TOKEN, human: "human", sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await post("pm", { kind: "reading", surface: "project", key: "roles",
    value: { pm: { responsibilities: ["R4"] }, dev: { responsibilities: ["R5"] }, frontend: { responsibilities: ["R7"] } } });
  // t-248 与 t-279 当时逐字的声明：只在 packages/server/test 这个目录上相撞
  await post("pm", { kind: "task", op: "create", task: "t-248", title: "补那一格渲染", criteria: ["x"], no_human_impact: true });
  await post("pm", { kind: "task", op: "create", task: "t-279", title: "牌桌算停摆", criteria: ["y"], no_human_impact: true });
  await post("frontend", { kind: "task", op: "claim", task: "t-248", touches: ["packages/server/src/html.ts", "packages/server/test", "packages/server/test/criteria-added.test.ts"] });
  await post("dev", { kind: "task", op: "claim", task: "t-279", touches: ["packages/core/src/board.ts", "packages/server/test/stalled-not-on-page.test.ts"] });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-280 · 只撞在目录上的那一类不上人那一页", () => {
  it("先证那个状态真的成立：这两件确实撞出了这一类接缝", async () => {
    const b = board(reduce(await store.read()), "human");
    expect(b.contained_seams.map((x) => x.id), "触发条件成立").toEqual(["seam:t-248+t-279"]);
    expect(b.contained_seams[0]).toMatchObject({ light: true, open: false, contained: true });
  });

  it("而 GET / 那一页上，一个字都没有", async () => {
    const html = await getPage();
    expect(html.slice(0, 200), "先证我看的是那一页，不是手册").toContain("<!doctype html>");
    expect(html).toContain('id="seams"');
    expect(html).not.toContain(SEAM_DIR_ONLY);
    // t-114 那句对这一类是假话，所以它更不许出现在这两件身上
    expect(html).not.toContain("各自的符号不相交");
    // 也不许换个地方冒出来：那个目录名在接缝那一节里一次都不该有
    const seamsSection = html.slice(html.indexOf('id="seams"'), html.indexOf('id="seams"') >= 0 ? html.indexOf("</section>", html.indexOf('id="seams"')) : 0);
    expect(seamsSection).not.toContain("packages/server/test");
  });

  it("逐字相同：把这一类整个拿掉再渲染一次，两份 HTML 一个字节都不差", async () => {
    const st = reduce(await store.read());
    const b = board(st, "human");
    expect(b.contained_seams.length, "先证这不是一次空比较：它确实在那份数据里").toBe(1);
    expect(renderBoard(b, st, { sha: "abc1234" })).toBe(renderBoard({ ...b, contained_seams: [] }, st, { sha: "abc1234" }));
    // 任务详情那一页同样：GET /task/<id> 也是人看的
    for (const id of ["t-248", "t-279"])
      expect(renderTask(b, st, id, { sha: "abc1234" }), id).toBe(renderTask({ ...b, contained_seams: [] }, st, id, { sha: "abc1234" }));
  });

  it("同一个目录声明，只要两边真的动了同一个文件，那一页照旧看得见——不上页的只有这一类", async () => {
    await post("pm", { kind: "task", op: "create", task: "t-242", title: "真撞上", criteria: ["z"], no_human_impact: true });
    await post("dev", { kind: "task", op: "claim", task: "t-242", touches: ["packages/server/src/html.ts", "packages/server/src/html.ts#renderBoard"] });
    const b = board(reduce(await store.read()), "human");
    expect(b.seams.map((x) => x.id)).toContain("seam:t-242+t-248");
    const html = await getPage();
    expect(html).toContain("t-242");
    expect(html).toContain("packages/server/src/html.ts");
  });
});
