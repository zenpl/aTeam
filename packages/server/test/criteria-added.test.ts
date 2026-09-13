/**
 * t-248 · 判据的「追加标记」回到人那一页。
 *
 * 这一格 `06276f8`（t-025）加过，我 `2c98e55`（牌桌 v2 重写）删掉了——**距 qa 那次 pass 三十五分钟**，
 * 之后缺了六天，直到 t-025 在生产表面重验才被抓到。所以这份用例守的不只是「印不印」，还有
 * **「下一次重写会不会再把它铺平」**：第三条按下标基数钉死，抄错隔壁就红。
 *
 * **判据 2 那个坑，两个下标就挨着，基数却不同：**
 * · `criteria_moved.index` 是 **1 基**——`rules.ts` 的拒绝话原文写着「{index: <判据序号，从 1 起>}」。
 * · `criteria_added.index` 是 **0 基**——`reduce.ts` 里 `index: t.criteria.length - 1`，就是数组下标。
 * 照着上一行抄 `i + 1`，整列标记会整体错一条：**第一条追加的不带标，它后面那条平白多一个标。**
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, reduce, board, append, type NewEvent } from "@ateam/core";
import { renderTask } from "../src/html.js";

const HUMAN = "human";
const ORIGINAL = ["原来就有的第一条", "原来就有的第二条"];
const ADDED_ONE = "后来追加的那一条";
const ADDED_TWO = "再后来追加的那一条";

async function fixture() {
  const store = new MemoryStore();
  let t = Date.parse("2026-09-06T06:00:00Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-900", title: "样本件", criteria: [...ORIGINAL], no_human_impact: true });
  return { store, emit };
}
const pageOf = async (store: MemoryStore) => {
  const state = reduce(await store.read());
  return renderTask(board(state, HUMAN), state, "t-900", { sha: "abc1234", human: HUMAN, base: "" })!;
};
/** 只取判据那一列的 <li>，免得页面别处的列表混进来。 */
const items = (html: string) =>
  [...html.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)].map((m) => m[0]).filter((li) => /原来就有的|追加的那一条/.test(li));
/** 一条 <li> 上有没有追加标记。标记形如 `+ <谁> · <多久以前>`。 */
const hasMark = (li: string) => /\+\s/.test(li) && /<span class="meta">/.test(li);

describe("t-248 · 追加标记印在人那一页上", () => {
  it("没有人追加过时，一条标记都没有——不然下面两条什么也没守", async () => {
    const { store } = await fixture();
    const html = await pageOf(store);
    const lis = items(html);
    expect(lis.length, "两条原判据都该列出来").toBe(2);
    expect(lis.some(hasMark), "没人追加过，不该有任何标记").toBe(false);
  });

  it("追加之后：那一条带标记、说得出是谁加的，原有的两条不带", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "criteria", actor: "pd", task: "t-900", add: [ADDED_ONE] });
    const html = await pageOf(store);
    const lis = items(html);
    expect(lis.length).toBe(3);
    const marked = lis.filter(hasMark);
    expect(marked.length, "只有追加的那一条该带标记").toBe(1);
    expect(marked[0], "带标记的必须是追加的那一条").toContain(ADDED_ONE);
    expect(marked[0], "标记要说得出是谁加的").toContain("pd");
    expect(lis[0] + lis[1], "原有的两条不该被标成追加").not.toMatch(/\+\s.*<\/span>/);
  });

  /**
   * **判据 2：把 0 基／1 基钉死。**
   *
   * 造一条**只有第二条是追加的**的样本（第一条原有、第二、三条追加），于是两种基数的结果不重叠：
   * · 0 基（对的）：标记落在第 2、3 条，也就是两条追加的那些。
   * · 1 基（抄隔壁 `criteria_moved` 的写法）：标记落在第 3 条与一条不存在的第 4 条 ⇒ **只标出一条，且第一条追加的漏标。**
   * 所以下面这条断言只在 0 基下成立；把 `a.index === i` 改成 `a.index === i + 1`，它当场红。
   */
  it("判据 2：追加标记按 0 基对齐，抄隔壁 moved 的 1 基就会整体错一条", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "criteria", actor: "pd", task: "t-900", add: [ADDED_ONE, ADDED_TWO] });
    const html = await pageOf(store);
    const lis = items(html);
    expect(lis.length).toBe(4);
    const markedText = lis.filter(hasMark).map((li) => (/追加的那一条/.test(li) ? li : "其他"));
    expect(markedText.length, "两条追加的都要带标记；只有一条＝用了 1 基").toBe(2);
    expect(lis[2], "第一条追加的（数组下标 2）必须带标记——1 基下正是它漏掉").toMatch(/\+\s/);
    expect(lis[3], "第二条追加的也要带").toMatch(/\+\s/);
    expect(hasMark(lis[0]) || hasMark(lis[1]), "原有的两条一个都不许带").toBe(false);
  });

  /** 与 `criteria_moved` 同时出现时两个标记各自归位，互不吞掉（它们在同一个 <li> 上拼接）。 */
  it("同一条既被追加又被搬走时，两个标记都在", async () => {
    const { store, emit } = await fixture();
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-901", title: "接手的", criteria: ["接过来"], no_human_impact: true });
    await emit({ kind: "task", op: "criteria", actor: "pd", task: "t-900", add: [ADDED_ONE] });
    await emit({ kind: "task", op: "criteria", actor: "pm", task: "t-900", moved: { index: 3, to: "t-901" } });
    const html = await pageOf(store);
    const li = items(html).find((x) => x.includes(ADDED_ONE))!;
    expect(li, "追加标记还在").toMatch(/\+\s/);
    expect(li, "搬走标记也在").toContain("t-901");
  });
});
