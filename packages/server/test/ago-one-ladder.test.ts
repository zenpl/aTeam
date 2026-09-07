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
   * **这条闸被 qa 连着凿了三次，每一次漏的方向都一样：它以为自己在看的地方，比它真正看的地方大。**
   * ① 09:36：扫的是「分钟前/小时前/天前/刚刚」这几个**词**，而 `cli/deaf.ts` 那份只吐「1.3 小时」，
   *    「前」由调用方拼——按词找和按名字找是同一个毛病。改成扫**形状**（一个文件同时说两个以上时间单位）。
   * ② 09:54：`roots` 只有 server 与 cli，**core 自己不在里面**——把完整的第五道梯子写进 `core/src/` 就全绿。
   * ③ 09:54：`readdirSync` 不进子目录——同一份放进 `cli/src/sub/` 就全绿，`scanned > 8` 也拦不住。
   *
   * 所以这一版不再问「core 之外有没有第二道」，改成问**整个仓库里按量级分档的地方是不是恰好那一处**：
   * 递归走遍每个包的 src，把符合形状的文件列出来，它必须**正好等于** `core/src/board.ts`。
   * 少了它自己会红（说明梯子被删了或改瞎了），多出任何一个也红——包括多在 core 里的那一个。
   *
   * 它仍然看不见的（写在明处，不靠人记得）：只用一个时间单位的（`缺人 ${n} 分钟` 不是梯子，是一句话，
   * 归 t-144）、用英文写的、以及把汉字拆开拼起来的。
   *
   * **还有一条是我验的时候撞出来的，不是想出来的**：它看的是源码里有没有这些形状，不是这些形状**跑不跑得到**。
   * 把分档条件改成 `sec < 86400000`，分钟那一档吞掉全部，小时与天的字面量还留在源码里 ⇒ 全绿。
   * 要把那两档**删掉**才红。所以「梯子被改瞎了它会红」这句话只在「改法是删」时成立；改法是让它够不着时不成立。
   * 我在 a303cab 的说明里把这句写得太满了，这里是更正。
   */
  /**
   * 合 t-144 时两版撞在一起，取的是 frontend 那版的**判法**加我这版的**范围**，两半各解一个问题：
   * · 判法（frontend）：形状是「一个算出来的数，紧跟一个时间单位」——`${…} 分钟`。光看单位词会误报，因为
   *   events.ts 里「新节点十分钟内…」「有事等你超过半小时」是散文里的时间词。差别正在那个插值：分档一定要
   *   先把毫秒算成一个数，散文不用。我原来是按顶层声明切开来绕过这个误报，这条插值规则更直接。
   * · 范围（t-185）：从 `sourceFiles` 走出来，不在这里再写一份 walk——同一个走法在两处各写一遍，正是 t-185
   *   要根除的那件事。
   */
  it("整个仓库里按量级分档的地方，恰好是 core 那一处", () => {
    const BANDS = [/\}\s*分钟/, /\}\s*小时/, /\}\s*天/];
    const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
    const srcs = sourceFiles(`${repo}/packages`, "packages");
    const banding = srcs.filter((f) => {
      const src = readFileSync(`${repo}/${f}`, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return BANDS.filter((re) => re.test(src)).length >= 2;
    });
    expect(srcs.length, "一个文件都没扫到——这条断言此刻什么也没守").toBeGreaterThan(20);
    expect(srcs, "没走进子目录：这条闸曾经因此漏掉放在 cli/src/sub/ 的一份").toContain("packages/core/src/board.ts");
    expect(banding, `按量级分档的地方应当只有 core 一处，实际是：\n${banding.join("\n")}`).toEqual([LADDER_HOME]);
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

  /**
   * t-199 判据 5：**把那句盲区自白改成一道会红的闸。**
   *
   * 上面那条按中文档位（`}\s*分钟` 之类）找梯子，所以它在注释里自认「用英文写的抓不住」。这不是假设，是账：
   * `cli/format.ts` 那个紧凑记法（`60m`/`1.5h`）就一直住在这句自白后面，一道全绿的闸从它旁边走过去四十天。
   * **写下盲区不等于守住了盲区**——一句自白只是把漏洞记在案，漏洞照旧开着。
   *
   * 这一条换一个不认字的判法：不看它说什么单位，看它**拿什么数在分档**。任何一段把时长分档的代码，无论
   * 中文、英文还是记号，都得知道 60、3600、86400（或它们的毫秒版）里的至少两个——**分档就是拿这些数去比大小**。
   * 于是这条闸对语言免疫：把梯子改写成英文、改成表情符号，它照样红。
   *
   * 判法与上面那条同一个形状（「恰好是 core 那一处」，不是「core 之外没有」），理由也同一个：qa 10:16 那三次
   * 都栽在「以为自己在看的地方比真正看的地方大」。少了 core 那一处也要红——那说明梯子被删了或搬走了，
   * 而不是说明天下太平。
   */
  const MAGNITUDES = [/\b60\b/, /\b3600\b/, /\b86400\b/, /\b60000\b/, /\b3600000\b/, /\b86400000\b/];
  const bandingBy = (src: string) =>
    MAGNITUDES.filter((re) => re.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))).length;

  it("判据 5：按「拿什么数分档」找，整个仓库也恰好只有 core 那一处——这一条不认字", () => {
    const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
    const srcs = sourceFiles(`${repo}/packages`, "packages");
    const banding = srcs.filter((f) => bandingBy(readFileSync(`${repo}/${f}`, "utf-8")) >= 2);
    expect(srcs.length, "一个文件都没扫到——这条断言此刻什么也没守").toBeGreaterThan(20);
    expect(banding, `拿时间量级分档的地方应当只有 core 一处，实际是：\n${banding.join("\n")}`).toEqual([LADDER_HOME]);
  });

  /**
   * pd 06:29：**一道闸交付时要带一个它该抓住的用例，和一个它不该抓住的用例。**两个都在这里，都是真代码不是描述。
   *
   * 该抓住的那个，就是这一件动手前 `cli/format.ts:51-54` 的原文——一字未改抄下来。上面那条中文闸对它是全绿的
   * （0 个中文档位），这条闸看得见（2 个量级常数）。**这两个数并排放在这里，就是那句盲区自白被换成用例的样子。**
   */
  it("判据 5 的两个用例：旧的那一把会被抓住，一句只用一个单位的话不会", () => {
    const THE_OLD_LADDER = [
      "const ago = (iso: string) => {",
      "  const s = Math.round((now - Date.parse(iso)) / 1000);",
      "  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;",
      "};",
    ].join("\n");
    expect(bandingBy(THE_OLD_LADDER), "旧的那一把要被这条闸抓住").toBeGreaterThanOrEqual(2);
    // 同一段代码在上面那条中文闸眼里是干净的——这正是它注释里那句自白，现在有数了
    expect([/\}\s*分钟/, /\}\s*小时/, /\}\s*天/].filter((re) => re.test(THE_OLD_LADDER)).length,
      "中文那条闸本来就看不见它，所以才需要这一条").toBe(0);

    // 不该抓住的：只知道一个量级的不是分档。超时判断、轮询间隔都长这样，它们不该被叫去改。
    expect(bandingBy("const WATCH_INTERVAL = 60;"), "只有一个量级常数，不是梯子").toBeLessThan(2);
    expect(bandingBy('const s = `缺人 ${n} 分钟`;'), "一句只说一个单位的话，不是梯子").toBeLessThan(2);
  });
});
