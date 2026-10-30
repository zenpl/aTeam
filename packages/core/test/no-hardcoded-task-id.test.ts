/**
 * t-290 判据 1：**平台代码里不许把一个本项目的任务 id 当常量。**
 *
 * 被删掉的那一个是 `ACTED_RULE_TASK = "t-147"`。它为什么是个洞：第二个租户的日志里永远不会有一批含着
 * `t-147`，于是起算点恒算不出来，`owedFull` 据此「一条都不进旁桶」，**他们的全部历史落进活欠账**
 * （读数 repo:owed.legacy.second-tenant = 0）。**一个写死的本项目 id，在别人的租户上是一个静默失效的开关**
 * ——而静默失效的开关是这份日志里数了一整天的那个形状。
 *
 * 闸只认判据点名的那个形状：**一个常量，它的值整个就是一个任务 id**。它不碰另外两种，而那两种都不是开关：
 * · 注释与文档里的例子（`board.ts` 里「so "added" or "t-001" never count」那一句）；
 * · 示例数据里的 id（`READING_SAYINGS` 的 `sample`、`fixture.ts` 里那个演示日志的 `t-1`）——
 *   **示例日志里的 id 是那份示例自己的**，它不决定任何真实项目的行为。
 * 换句话说：这不是一份「哪几处放过」的名单（那种要么误伤要么被绕），是一条按形状判的规则。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sourceFiles, isProductSource } from "../src/index.js";

const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
/** 平台代码：判据点名的那两处。命令行不在判据里（它本来就跑在某一个项目的检出里）。 */
const PLATFORM = ["packages/core/src", "packages/server/src"];
/** `const X = "t-123"` / `export const X: Foo = "t-9"`：值整个就是一个任务 id 的常量。 */
const HARDCODED = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*["'](t-\d+)["']/g;

function hits(): { file: string; name: string; id: string }[] {
  const out: { file: string; name: string; id: string }[] = [];
  for (const dir of PLATFORM) {
    for (const f of sourceFiles(`${repo}/${dir}`, dir).filter(isProductSource)) {
      const src = readFileSync(`${repo}/${f}`, "utf8");
      for (const m of src.matchAll(HARDCODED)) out.push({ file: f, name: m[1], id: m[2] });
    }
  }
  return out;
}

describe("t-290 判据 1 · 平台代码里不许写死本项目任务 id", () => {
  it("此刻一处都没有", () => {
    expect(hits(), `这几处把一个本项目任务 id 当成了平台常量：${hits().map((h) => `${h.file}#${h.name}=${h.id}`).join("、")}`).toEqual([]);
  });

  it("闸抓得住被删掉的那一个——不然它只是一句空话", () => {
    const src = `export const ACTED_RULE_TASK = "t-147";\n`;
    expect([...src.matchAll(HARDCODED)].map((m) => [m[1], m[2]])).toEqual([["ACTED_RULE_TASK", "t-147"]]);
  });

  it("写法变一下也抓得住：带类型标注、单引号、不 export", () => {
    for (const src of [`const X: string = "t-9";`, `const X = 't-9';`, `export const X = "t-0001";`])
      expect([...src.matchAll(HARDCODED)], src).toHaveLength(1);
  });

  it("不碰注释里的例子与示例数据里的 id——那两种都不是开关", () => {
    for (const src of [
      `/** so "added" or "t-001" never count */`,
      `const SAMPLE = { contains: ["t-130", "t-131"] };`,
      `await b.task.create("pm", "t-1", "标题", []);`,
      `const PREFIX = "batch.";`,
    ]) expect([...src.matchAll(HARDCODED)], src).toHaveLength(0);
  });

  /**
   * **这道闸看不见什么，说在明处**（同 LITERAL_CHECK_BLIND_SPOTS 那条规矩）：判据点名的形状是「常量」，
   * 所以把 id 直接写成实参的那种它抓不到——`ruleLiveAt(s, "t-147")` 一样是写死，而闸是绿的。
   * 我反向注入时撞到了这一点：那次注入红的是分桶那条用例，不是这道闸。
   *
   * 不顺手收紧，理由有二：① 收紧就必须放过 `fixture.ts` 的 `t-1` 与 `READING_SAYINGS` 的 `sample`，
   * 那又回到一份「哪几处放过」的名单（要么误伤要么被绕）；② 判据怎么收归 pm，不归我顺手。
   * **缺口写下来，下一个人不必再撞一次。**
   */
  it("看不见的那一种：id 直接当实参写死时闸是绿的——缺口在这儿，不在别处", () => {
    expect([...`const since = ruleLiveAt(s, "t-147");`.matchAll(HARDCODED)], "它抓不到").toHaveLength(0);
    expect([...`const ACTED = "t-147";`.matchAll(HARDCODED)], "这一种抓得到").toHaveLength(1);
  });

  it("范围是走出来的，不是一份名单：这两个目录底下真的有文件被扫到", () => {
    const n = PLATFORM.reduce((a, d) => a + sourceFiles(`${repo}/${d}`, d).filter(isProductSource).length, 0);
    expect(n, "一个文件都没扫到的闸是绿的，但它什么也没守").toBeGreaterThan(10);
  });
});
