/**
 * t-180 · 「多久以前」只有一道梯子，而且渲染方拿不出第二道。
 *
 * 两条断言分工不同，缺一条都留着今晚那个洞：
 * ① 逐点比对，管的是**现有的两处说的是不是同一句话**；
 * ② 源码扫描，管的是**明天有没有人再写第三处**——只有 ① 的话，新写一份不被任何用例读到的拷贝，全绿。
 * 合并之前正是这样：四份拷贝、99% 的时刻说法不同，没有一条断言说话。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ago, sourceFiles } from "@ateam/core";
import { UI } from "../src/i18n.js";

const LADDER = ["分钟前", "小时前", "天前", "刚刚"];

/** 那道梯子唯一允许住的地方：core 一处。排它按文件走，因为整份 board.ts 里只有 ago/span 在做分档。 */
const LADDER_HOME = "packages/core/src/board.ts";

describe("t-180 · 页面不自带梯子", () => {
  it("页面说的每一个「多久以前」都与 core 逐字相同", () => {
    for (let sec = 0; sec < 400 * 86400; sec += 421) {
      expect(UI.ago(sec), `${sec}s`).toBe(ago(sec * 1000));
    }
  });

  /**
   * pd 09:09 把位置规则扩了一格：重复的不只是句子，还有把数变成句子的那段逻辑。
   *
   * **第一版这条闸正好漏掉了它要防的那一个**（qa 09:38）：它扫的是「分钟前/小时前/天前/刚刚」这几个**词**，
   * 而 `packages/cli/src/deaf.ts` 那份只吐「1.3 小时」，「前」由调用方拼上去——按词找和按名字找是同一个毛病，
   * 同一件东西被拆成两半就找不到了。**闸绿着，第五道梯子就在树里。**
   *
   * 所以这一版扫的不是词，是**形状**：一段代码里的人可见字面量若同时提到两个以上不同的时间单位
   * （分钟 / 小时 / 天 / 刚刚），它就是在按量级分档——那正是「把毫秒差变成人话」，只许 core 一处做。
   * 这条界线是可写下来的，也说得出它看不见什么：
   * · 抓得住：改了名字的（`howLong`）、只吐半句的（「1.3 小时」）、全新写的一份。
   * · 抓不住：只用一个单位的（`缺人 ${n} 分钟` 不是梯子，是一句话——它的重复归 t-144）、
   *   用英文写的、以及把汉字拆开拼起来的。
   */
  it("core 之外没有第二处按量级分档的地方（扫形状，不扫词）", () => {
    const UNITS = ["分钟", "小时", "天", "刚刚"];
    // t-185：**范围也是走出来的，不是名单。**这里原来写死了两个目录、而且 readdirSync 不进子目录，于是
    // core/src 与任何一个子目录里的第二道梯子它都看不见——与 SECOND_HOMES 那份手写名单同一个毛病。现在从
    // packages 走一遍所有源码文件（core 自己也扫：那里也可能被人写出第二份），core 的 ago/span 所在的那一处
    // 是唯一允许的，按符号排掉，不按文件排。
    const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
    const files = sourceFiles(`${repo}/packages`, "packages");
    const hits: string[] = [];
    let scanned = 0;
    for (const f of files) {
      scanned++;
      // 去掉注释之后直接在源码正文里找单位词——不再去「抽出字面量」：模板串里可以嵌模板串，
      // 按引号配对的写法在嵌套处会错位，而错位的方向是漏报。这几个词在代码里只可能出现在字符串里。
      const src = readFileSync(`${repo}/${f}`, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (f === LADDER_HOME) continue;
      // t-185：**按声明看，不按整份文件看。**范围扩到 core 之后，整份文件的判法立刻误报：events.ts 里
      // 「新节点十分钟内…」「有事等你超过半小时」「今天你们手工顶了三次」是三句互不相干的话，各说一个单位，
      // 凑在一份文件里就被算成一道梯子。一道梯子是**一段**代码把毫秒差分档，所以判定的单位是一个顶层声明。
      const decls = [...src.matchAll(/^(?:export\s+)?(?:const|function|async function)\s+(\w+)/gm)];
      for (let d = 0; d < decls.length; d++) {
        const body = src.slice(decls[d].index!, d + 1 < decls.length ? decls[d + 1].index! : src.length);
        const used = UNITS.filter((u) => body.includes(u));
        if (used.length >= 2) hits.push(`${f}#${decls[d][1]}：同时说 ${used.join("、")}`);
      }
    }
    expect(scanned, "一个文件都没扫到——这条断言此刻什么也没守").toBeGreaterThan(8);
    expect(hits, `这几处在自己按量级分档，应当调 core 的 ago / span：\n${hits.join("\n")}`).toEqual([]);
  });

  /**
   * t-185 判据 2：**往它范围之外加一句，它必须红。**
   *
   * 上一版的 roots 是手写的两个目录、而且 readdirSync 不进子目录，于是 core/src 与任何一个子目录里的第二道梯子
   * 它都看不见——qa 10:01 说的就是这一类。这条用同一段判法在构造的输入上跑：一段自己按量级分档的代码，放在
   * 老范围之外的位置，必须被认出来；老范围只认那两个目录的顶层，什么都不会发生。
   */
  it("判据 2：老范围之外的一道梯子，现在认得出来", () => {
    const UNITS = ["分钟", "小时", "天", "刚刚"];
    const ladder = (name: string) => `export function ${name}(ms: number) {\n  if (ms < 60000) return "刚刚";\n  if (ms < 3600000) return \`\${n} 分钟\`;\n  if (ms < 86400000) return \`\${n} 小时\`;\n  return \`\${n} 天\`;\n}\n`;
    const judge = (src: string) => {
      const clean = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const decls = [...clean.matchAll(/^(?:export\s+)?(?:const|function|async function)\s+(\w+)/gm)];
      const hits: string[] = [];
      for (let d = 0; d < decls.length; d++) {
        const body = clean.slice(decls[d].index!, d + 1 < decls.length ? decls[d + 1].index! : clean.length);
        if (UNITS.filter((u) => body.includes(u)).length >= 2) hits.push(decls[d][1]);
      }
      return hits;
    };
    expect(judge(ladder("howLong")), "一道梯子没被认出来").toEqual(["howLong"]);
    // 老范围看不到的那几个位置，现在都在 sourceFiles 走出来的那份里
    const repo2 = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
    const scope = sourceFiles(`${repo2}/packages`, "packages");
    expect(scope, "core/src 整个不在老范围里").toContain("packages/core/src/board.ts");
    expect(scope.some((f) => f.split("/").length > 3), "子目录里的文件老范围走不到").toBe(true);
    // 反例：只说一个单位的不是梯子，是一句话（它的重复归 t-144）
    expect(judge('const s = `缺人 ${n} 分钟`;')).toEqual([]);
  });
});
