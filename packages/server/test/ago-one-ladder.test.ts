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
    const roots = { "packages/server/src": new URL("../src/", import.meta.url), "packages/cli/src": new URL("../../cli/src/", import.meta.url) };
    const hits: string[] = [];
    let scanned = 0;
    for (const [name, dir] of Object.entries(roots)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
        scanned++;
        // 去掉注释之后直接在源码正文里找单位词——不再去「抽出字面量」：模板串里可以嵌模板串，
        // 按引号配对的写法在嵌套处会错位，而错位的方向是漏报。这几个词在代码里只可能出现在字符串里。
        const src = readFileSync(new URL(f, dir), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        const used = UNITS.filter((u) => src.includes(u));
        if (used.length >= 2) hits.push(`${name}/${f}：同时说 ${used.join("、")}`);
      }
    }
    expect(scanned, "一个文件都没扫到——这条断言此刻什么也没守").toBeGreaterThan(8);
    expect(hits, `这几处在自己按量级分档，应当调 core 的 ago / span：\n${hits.join("\n")}`).toEqual([]);
  });
});
