/**
 * t-206 判据 2：**印一条事件就带上它的 id，五处一个不漏——而且这条闸不靠名单。**
 *
 * 缺的那一处是 `loop.ts` 的 `report()`，也就是 `sync` 与 `watch` 共用的渲染器：从 watch 的流里读到一条给自己的
 * 指令，手上却没有那串 id，要引用它就得再去查一次日志，不查就只能凭印象敲。pm 今夜为此编造了六次不存在的 id、
 * 六次被服务拒——而规矩要求办掉一条就写下引用。**闸要人做的事，入口就得给得出材料。**
 *
 * `fmt.event` 自己不印 id 是对的（印不印由调用方决定），所以这条闸盯的是**调用方**：源码里每一处 `fmt.event(`
 * 都要在同一行里带上那个事件的 id。名单是扫出来的，不是手写的——今晚已经有四件活栽在手写名单上。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

describe("t-206 · 印事件就带 id，调用方一处不漏", () => {
  it("每一处 fmt.event( 的同一行里都有那个事件的 id", () => {
    const bad: string[] = [];
    let sites = 0;
    for (const f of readdirSync(SRC).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(SRC, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (!/\bfmt\.event\(/.test(line)) return;
        sites++;
        // 同一行里要出现 `${<某个变量>.id}`——印的是哪一条事件，读的人得看得见
        if (!/\$\{\w+\.id\}/.test(line)) bad.push(`${f}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(sites, "一处 fmt.event( 都没扫到：这条闸自己瞎了").toBeGreaterThan(3);
    expect(bad, "这几处印了事件却没印 id——从这里读到一条指令的人，手上没有引用它所需的那个字符串").toEqual([]);
  });
});
