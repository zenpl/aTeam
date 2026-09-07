/**
 * t-187 · `bin/inject` 那八句话与 core 对得上（pd 10:21）。
 *
 * pd 的裁定是「副本可以存在，只要它不能独自漂移」：脚本里的字面量**不**改成运行时读 core——它要能在
 * core 坏掉的时候照样跑，而它的用处恰恰是回答「core 坏了没有」。所以出处仍只有一个，脚本那份被这条测试钉住。
 *
 * **找句子的办法要小心，pd 10:22 特意立了规矩**：不许按 `echo` 之类的语句形状找。qa 10:20 数到六句，
 * 少的两句嵌在脚本里那段 python 里、用 `sys.exit` 打出来——**一个文件里嵌了第二种语言，按第一种语言的
 * 形状去数一定少数**。所以这里按「引号里的中文」找：引号是两种语言共有的，而「谁把它打出来」不是。
 *
 * 它假定了什么，写在明处：`#` 起注释、引号成对。两种语言在这个文件里都满足。它看不见的是不带引号
 * 又会被打印的中文（例如 heredoc 正文直接输出）——所以第三条反过来钉：引号之外的中文必须全在注释里。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SAYINGS } from "../src/sayings.js";
import * as core from "../src/index.js";

const HAN = /[一-鿿]/;
const SCRIPT = new URL("../../../bin/inject", import.meta.url);
/** 填进占位符的哨兵：只要它不出现在任何一句话里，是什么形状都行。 */
const HOLE = "§HOLE§";

/** 把一行切成「引号里的片段」与「引号外的正文」，并认出 # 起的注释。shell 与 python 在这里同规则。 */
function split(line: string): { strings: string[]; bare: string } {
  const strings: string[] = [];
  let bare = "", i = 0, q = "", buf = "";
  while (i < line.length) {
    const c = line[i];
    if (q) {
      if (c === "\\") { buf += line.slice(i, i + 2); i += 2; continue; }
      if (c === q) { strings.push(buf); buf = ""; q = ""; i++; continue; }
      buf += c; i++; continue;
    }
    if (c === '"' || c === "'") { q = c; i++; continue; }
    if (c === "#") break;                       // 这一行剩下的是注释
    bare += c; i++;
  }
  if (q) strings.push(buf);                     // 行尾还没闭合：当成一段字符串，宁可多算不漏算
  return { strings, bare };
}

/** 一句登记过的话去掉占位符之后剩下的固定片段。占位符用哨兵填，所以不必知道它是 $x 还是 {x}。 */
function fixedParts(from: string): string[] {
  const v = (core as Record<string, unknown>)[from];
  const text = typeof v === "function" ? (v as (...a: string[]) => string)(HOLE, HOLE) : String(v);
  return text.split(HOLE).filter((x) => x.length > 0);
}

describe("t-187 · bin/inject 说的话，出处在 core", () => {
  const lines = readFileSync(SCRIPT, "utf-8").split("\n");
  const scriptStrings = lines.flatMap((l) => split(l).strings).filter((t) => HAN.test(t));
  const scripts = SAYINGS.filter((s) => s.where.includes("script"));

  it("脚本里带中文的引号串，正好就是登记为 script 的那些——不多不少", () => {
    expect(scripts.length, "一句都没登记的话，下面两条就什么也没守").toBeGreaterThan(0);
    expect(scriptStrings.length, "脚本里 " + scriptStrings.length + " 句、登记了 " + scripts.length + " 句").toBe(scripts.length);
  });

  it("逐句对得上：core 那句改了而脚本没跟上，这条就红", () => {
    const unmatched = [...scriptStrings];
    for (const s of scripts) {
      const parts = fixedParts(s.from);
      expect(parts.length, s.key + " 的 from=" + s.from + " 在 core 里取不到").toBeGreaterThan(0);
      const hit = unmatched.findIndex((t) => {
        let at = 0;
        return parts.every((p) => { const k = t.indexOf(p, at); if (k < 0) return false; at = k + p.length; return true; });
      });
      expect(hit, "core 的 " + s.key + "（" + s.from + "）在 bin/inject 里找不到对应的一句。core 那句是：" + parts.join(" … ")).toBeGreaterThanOrEqual(0);
      unmatched.splice(hit, 1);
    }
    expect(unmatched, "脚本里这几句没有登记：" + unmatched.join(" / ")).toEqual([]);
  });

  /**
   * 反过来的一条：上面两条只看引号里的东西，所以它们对「不带引号却会被打印的中文」是瞎的。
   * 这一条把那个口子堵上——引号之外的中文只许出现在注释里。pm 10:24 问的第 33 行
   * （trap restore … # 注入中途出任何事都还原）正是这一类：它是注释，跑起来不会被打印，
   * 我另外跑了一次脚本核实输出里确实没有它。
   */
  it("引号之外的中文，只许在注释里——不然就是一句没登记的话", () => {
    const loose = lines
      .map((l, i) => ({ n: i + 1, bare: split(l).bare }))
      .filter((x) => HAN.test(x.bare))
      .map((x) => "bin/inject:" + x.n + "  " + x.bare.trim().slice(0, 70));
    expect(loose, "这几处中文在引号外、又不在注释里：" + loose.join(" / ")).toEqual([]);
  });
});
