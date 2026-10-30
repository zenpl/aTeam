/**
 * t-290 判据 1 立的那道闸，t-301 把它收到 qa 量出来的那条边界上：
 * **平台代码里不许把一个本项目的任务 id 写死——不分它写成常量还是实参。**
 *
 * 被删掉的那一个是 `ACTED_RULE_TASK = "t-147"`。它为什么是个洞：第二个租户的日志里永远不会有一批含着
 * `t-147`，于是起算点恒算不出来，`owedFull` 据此「一条都不进旁桶」，**他们的全部历史落进活欠账**
 * （读数 repo:owed.legacy.second-tenant = 0）。**一个写死的本项目 id，在别人的租户上是一个静默失效的开关**
 * ——而静默失效的开关是这份日志里数了一整天的那个形状。
 *
 * **t-301 改了什么、为什么**：t-290 那一版按「常量」这个形状判，而 qa 09:37 验它时量出边界——写成实参
 * （`ruleLiveAt(s, "t-147")`）闸绿，而真正没有人挡住的是**在别处新写死一个别的本项目 id**：它既不是常量形状、
 * 也不改任何已有行为，所以没有任何东西会红。pm 08:48 裁定**不加白名单**，判据 2 要的是「两棵 src 树里任何
 * `^t-\d+$` 的字符串字面量都算」。
 *
 * **t-290 本身不动**（判据 5）：它的判据 1 按「形状」那一读法已由 qa 判过通过，这里收紧的是 pm 在它 done
 * 之后新加的要求，所以走新单、不 reopen。
 *
 * 放过的两种，都是按**结构**放过的，不是按文件名、也不是按一份「哪几处放过」的名单（那种要么误伤要么被绕）：
 * · 注释与文档里的例子（`stripComments` 抹掉）——`events.ts` 里讲这个洞的那段注释自己就写着 `"t-147"`；
 * · **落在标识符含 `sample` 的值里**的那些——`READING_SAYINGS[].sample` 与 `core/src/fixture.ts` 的
 *   `sampleBuilder`。示例日志里的 id 是那份示例自己的，它不决定任何真实项目的行为。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sourceFiles, isProductSource, taskIdLiterals, sampleExtents, stripComments } from "../src/index.js";

/**
 * **这道闸看不见的那几种。清单住在这儿而不在 core**（pd 15:45 的决策 01M66QT6GVAAP7BXFCX7F34TWE 选 C 当默认）：
 * 它是写给改这道闸的人的话，不是人可见的文案——而**这一条不靠我声明，靠冻结那道闸自己的口径回答**：
 * 它的范围是 `sourceFiles(SECOND_HOMES_ROOT).filter(isProductSource)`，用例不在里面。
 * 一个靠位置回答的问题比一个靠声明回答的问题可靠，而那正是这道闸自己立足的原则。
 * 与 `packages/cli/test/no-field-names.test.ts` 的 `FIELD_NAME_GATE_BLIND_SPOTS` 同形、同理由。
 *
 * 三条都不是理论上的，每一条下面都有一个会红的断言钉着：哪天它们被收进来了，那条断言会告诉下一个人
 * 闸的范围变宽了，而不是让人以为一直如此。
 */
export const TASK_ID_GATE_BLIND_SPOTS = [
  "经变量绕一手：`const id = \"t-\" + n`——拼出来的 id 不是一个字面量，配不到。",
  "标识符含 sample 的值整段放过：`function sampleFoo() { ... }` 里即便真写死了一个开关，闸也不看——判据定的就是按这个结构放过，代价写在这儿。",
  "只扫 core 与 server 的 src：命令行不在范围里（它本来就跑在某一个项目的检出里），测试与 .d.ts 也不在。",
] as const;

const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
/** 平台代码：判据点名的那两处。命令行不在判据里（它本来就跑在某一个项目的检出里）。 */
const PLATFORM = ["packages/core/src", "packages/server/src"];

const scanned = (): string[] =>
  PLATFORM.flatMap((d) => sourceFiles(`${repo}/${d}`, d).filter(isProductSource));

function hits(): { file: string; line: number; id: string }[] {
  const out: { file: string; line: number; id: string }[] = [];
  for (const f of scanned()) {
    for (const h of taskIdLiterals(readFileSync(`${repo}/${f}`, "utf8"))) out.push({ file: f, ...h });
  }
  return out;
}

describe("t-301 判据 2 · 两棵 src 树里一个写死的本项目任务 id 都没有", () => {
  it("此刻一处都没有——**不分常量还是实参**", () => {
    const found = hits();
    expect(found, `这几处把一个本项目任务 id 写死在平台代码里：${found.map((h) => `${h.file}:${h.line}=${h.id}`).join("、")}`).toEqual([]);
  });

  it("范围是走出来的，不是一份名单：这两个目录底下真的有文件被扫到（判据 4 后半句）", () => {
    // 一个文件都没扫到的闸是绿的，但它什么也没守——t-290 里已经写过这一条，沿用。
    const files = scanned();
    expect(files.length).toBeGreaterThan(10);
    for (const d of PLATFORM) expect(files.some((f) => f.startsWith(`${d}/`)), `${d} 底下一个文件都没扫到`).toBe(true);
  });
});

describe("t-301 判据 2 · 闸认得的那些写法（常量那一种 ＋ t-290 看不见的那些）", () => {
  it("常量：带类型标注、单引号、不 export，都抓得住（t-290 那一版认的就是这一种）", () => {
    for (const src of [`export const ACTED_RULE_TASK = "t-147";`, `const X: string = "t-9";`, `const X = 't-9';`, `export const X = "t-0001";`])
      expect(taskIdLiterals(src).map((h) => h.id), src).toHaveLength(1);
    expect(taskIdLiterals(`export const ACTED_RULE_TASK = "t-147";`)[0]).toEqual({ line: 1, id: "t-147" });
  });

  it("**实参那一种：这是 qa 09:37 量出来的那个缺口，此刻红**", () => {
    expect(taskIdLiterals(`const since = ruleLiveAt(s, "t-147");`), "t-290 那一版对它是绿的").toEqual([{ line: 1, id: "t-147" }]);
  });

  it("**在别处新写死一个别的 id：这是真正没人挡住的那一种**（判据 1 的原话）", () => {
    for (const src of [
      `if (t.id === "t-199") return true;`,
      `const skip = ["t-199", "t-200"];`,
      `return { task: "t-199" };`,
      `obj.task ??= "t-199";`,
      `foo({ of: "t-199" });`,
    ]) expect(taskIdLiterals(src).length, src).toBeGreaterThan(0);
  });

  it("只有整个值就是一个 id 的才算——前后多一个字就不是一个 id 了", () => {
    for (const src of [`const s = "t-1 done";`, `const s = "see t-1";`, `const s = "t-";`, `const s = "batch.t-1";`])
      expect(taskIdLiterals(src), src).toEqual([]);
  });

  it("行号报得对，一份源码里的几处一处不漏", () => {
    const src = `const a = "t-1";\nconst b = foo("t-2");\n// const c = "t-3";\nconst d = ["t-4", "t-5"];\n`;
    expect(taskIdLiterals(src)).toEqual([{ line: 1, id: "t-1" }, { line: 2, id: "t-2" }, { line: 4, id: "t-4" }, { line: 4, id: "t-5" }]);
  });
});

describe("t-301 判据 3 · 示例数据按结构放过，不按文件名、不按名单", () => {
  it("属性名含 sample 的那个值，整段放过——`READING_SAYINGS[].sample` 的形状", () => {
    const src = `{ surface: "x", key: "deploys", saying: { name: "上过线的那几批", sample: { contained: ["t-005", "t-004"], not_contained: ["t-130", "t-131"] } } }`;
    expect(taskIdLiterals(src)).toEqual([]);
  });

  it("函数名含 sample 的那个体，整段放过——`core/src/fixture.ts` 的 `sampleBuilder` 就落在这一种里", () => {
    const src = `export async function sampleBuilder(opts = {}) {\n  await b.task.create("pm", "t-1", "标题", []);\n  await b.task.done("dev", "t-1", {});\n}\nconst real = other("t-7");\n`;
    expect(taskIdLiterals(src), "样本里的两处放过，样本外那一处照抓").toEqual([{ line: 5, id: "t-7" }]);
  });

  it("**放过的是「这个值」，不是「这个文件」**：同一份源码里，sample 之外的照旧抓", () => {
    const src = `const sample = { ids: ["t-1"] };\nconst live = "t-2";\n`;
    expect(taskIdLiterals(src)).toEqual([{ line: 2, id: "t-2" }]);
  });

  it("`sampleExtents` 两种起点都认，而不含 sample 的名字一个都不认", () => {
    expect(sampleExtents(`const sampleX = ["t-1"];`), "赋值").toHaveLength(1);
    expect(sampleExtents(`{ sample: { a: 1 } }`), "属性").toHaveLength(1);
    expect(sampleExtents(`function sampleLog() { }`), "函数").toHaveLength(1);
    expect(sampleExtents(`const live = ["t-1"]; function real() { }`), "名字里没有 sample 的一个都不算").toEqual([]);
  });

  it("注释里的例子不算——讲这个洞的那段注释自己就写着那个 id", () => {
    for (const src of [
      `/** 这里曾经写着 ACTED_RULE_TASK = "t-147"，它被删了。 */`,
      `// const X = "t-147";`,
      `/* so "added" or "t-001" never count */`,
    ]) expect(taskIdLiterals(src), src).toEqual([]);
    expect(stripComments(`const a = "t-1"; // const b = "t-2";`).includes("t-2"), "注释那半句被抹掉了").toBe(false);
  });

  it("真文件上逐处核过：`events.ts` 的 `t-147` 在注释里、`board.ts` 的那几个在 sample 里、`fixture.ts` 的在 sampleBuilder 里", () => {
    const raw = (f: string) => readFileSync(`${repo}/${f}`, "utf8");
    for (const f of ["packages/core/src/events.ts", "packages/core/src/board.ts", "packages/core/src/fixture.ts"]) {
      expect(/(["'])t-\d+\1/.test(raw(f)), `${f} 里本来有这样的字面量，不然这条用例什么都没验`).toBe(true);
      expect(taskIdLiterals(raw(f)), `${f} 里那些都该被放过`).toEqual([]);
    }
  });
});

describe("t-301 · 这道闸看不见什么，说在明处", () => {
  it("三条盲点逐条有一个会红的用例钉着", () => {
    expect(TASK_ID_GATE_BLIND_SPOTS).toHaveLength(3);
    // ① 拼出来的 id 不是字面量
    expect(taskIdLiterals(`const id = "t-" + n;`), "拼接：抓不到").toEqual([]);
    // ② 标识符含 sample 的值整段放过——代价是这一段里真写死了也不看
    expect(taskIdLiterals(`function sampleFoo() { if (t.id === "t-199") return 1; }`), "样本段内：抓不到").toEqual([]);
    // ③ 只扫两棵 src 树
    expect(scanned().every((f) => PLATFORM.some((d) => f.startsWith(`${d}/`))), "范围之外不扫").toBe(true);
    expect(scanned().some((f) => /\.(test|spec)\.ts$/.test(f)), "测试不在范围里").toBe(false);
  });
});
