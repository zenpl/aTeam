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
   * pd 09:09 把位置规则扩了一格：重复的不只是句子，还有把数变成句子的那段逻辑。所以这一条扫的是
   * 「这几个词出现在 core 之外的源码里」——一处也不许有，包括写在别的名字底下的（命令行那份就叫 howLong，
   * 我一开始 grep `ago` 时因此漏了它，四份数成了两份）。
   */
  it("core 之外的源码里没有第二道梯子的任何一档", () => {
    // 路径从这个文件自己算起，不从 cwd 算：第一版写的是 `process.cwd()/../..`，用 pnpm --filter 跑时
    // 恰好对，从仓库根跑就指到了 /home，扫不到任何文件——**而扫不到文件的扫描器是全绿的**。
    // 所以下面先钉「真的读到了这两处源码」，再钉「里面没有梯子」：一条断言若能在什么都没看的情况下通过，
    // 它守的就不是它声称守的东西（今晚第六次同形）。
    const roots = { "packages/server/src": new URL("../src/", import.meta.url), "packages/cli/src": new URL("../../cli/src/", import.meta.url) };
    const hits: string[] = [];
    let scanned = 0;
    for (const [name, dir] of Object.entries(roots)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
        scanned++;
        const src = readFileSync(new URL(f, dir), "utf-8");
        src.split("\n").forEach((line, i) => {
          for (const w of LADDER) if (line.includes(w)) hits.push(`${name}/${f}:${i + 1}  ${line.trim().slice(0, 70)}`);
        });
      }
    }
    expect(scanned, "一个文件都没扫到——这条断言此刻什么也没守").toBeGreaterThan(8);
    expect(hits, `这几处自己拼了「多久以前」，应当调 core 的 ago：\n${hits.join("\n")}`).toEqual([]);
  });
});
