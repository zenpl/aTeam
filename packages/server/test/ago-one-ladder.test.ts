/**
 * t-180 · 「多久以前」只有一道梯子，而且渲染方拿不出第二道。
 *
 * 两条断言分工不同，缺一条都留着今晚那个洞：
 * ① 逐点比对，管的是**现有的两处说的是不是同一句话**；
 * ② 源码扫描，管的是**明天有没有人再写第三处**——只有 ① 的话，新写一份不被任何用例读到的拷贝，全绿。
 * 合并之前正是这样：四份拷贝、99% 的时刻说法不同，没有一条断言说话。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { ago } from "@ateam/core";
import { UI } from "../src/i18n.js";

const LADDER = ["分钟前", "小时前", "天前", "刚刚"];

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
   */
  it("整个仓库里按量级分档的地方，恰好是 core 那一处", () => {
    // 形状是「一个算出来的数，紧跟一个时间单位」——`${…} 分钟`。光看单位词不行：`events.ts` 里有
    // 「新节点十分钟内…」「有事等你超过半小时」「今天你们手工顶了三次」，那是散文里的时间词，不是分档。
    // 差别正在那个插值：分档一定要先把毫秒算成一个数，散文不用。
    const BANDS = [/\}\s*分钟/, /\}\s*小时/, /\}\s*天/];
    const root = new URL("../../../", import.meta.url);          // 仓库根
    const walk = (dir: URL, rel: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
        if (e.isDirectory()) out.push(...walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`));
        else if (e.name.endsWith(".ts")) out.push(`${rel}${e.name}`);
      }
      return out;
    };
    const srcs = readdirSync(new URL("packages/", root))
      .flatMap((pkg) => {
        const d = new URL(`packages/${pkg}/src/`, root);
        try { return walk(d, `packages/${pkg}/src/`); } catch { return []; }
      });
    const banding = srcs.filter((f) => {
      const src = readFileSync(new URL(f, root), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      return BANDS.filter((re) => re.test(src)).length >= 2;
    });
    expect(srcs.length, "一个文件都没扫到——这条断言此刻什么也没守").toBeGreaterThan(20);
    expect(srcs, "没走进子目录：这条闸曾经因此漏掉放在 cli/src/sub/ 的一份").toContain("packages/core/src/board.ts");
    expect(banding, `按量级分档的地方应当只有 core 一处，实际是：\n${banding.join("\n")}`).toEqual(["packages/core/src/board.ts"]);
  });
});
