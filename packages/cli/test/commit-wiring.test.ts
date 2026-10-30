/**
 * t-300 判据 7（qa 08:55 验 t-293 时找到的缺口）：**闸被判到了，接线没有。**
 *
 * qa 的注入：把调用处 `commitCursorsIfOk(process.exitCode)` 换成 `(0)`——纯换值、构建通过、**488 条一条都没红**。
 * 函数体有三条用例盯着（我把判断单拎出来正是为此），而「忘了把退出码传进去」这种改坏当时没有任何眼睛看得见。
 *
 * **为什么这份用例读源码，而不是跑一个真程序。** qa 说这个缺口是「我自己描述的那个形状往上挪了一层」，
 * 它说得对，而再往上挪一层也一样：把收尾抽成 `finishCommand(exitCode)`，没被判到的就变成
 * `finishCommand(process.exitCode)` 那一行。**每一次抽取都把没被判到的边界往上挪一格，而最后那一行只有两种
 * 东西看得见：一个真跑的进程，或者读源码。**
 *
 * 而真进程此刻到不了那一行：`process.exitCode` 的四处非抛赋值（`finishRelease` 两处、两个多件发送器）
 * **没有一处住在会攒下游标的命令里**——攒游标的只有 `sync` 与 `init`／`join`，而它们不抛就不设退出码
 * （`init` 那条 `.catch` 只印一行、照旧退 0）。所以 pm 判据里举的那个例子（「让命令自己把退出码设成非零
 * 而不抛」）今天造不出来，**除非先改产品行为——而为了让一条用例跑得起来去改产品行为是本末倒置。**
 *
 * 所以这里判两件可判的，外加一条会在「哪天真造得出来」时提醒下一个人的：
 * ① 调用处真的传了当前退出码；② 没有人绕过那道闸直接调 `commitCursors`；
 * ③ 非抛赋值退出码的地方一共几处，冻住——**哪天有人在一条攒游标的命令里加一处，这条会红，
 *    那一刻 qa 要的真进程用例既变得可能、也变成必须。**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MAIN = "packages/cli/src/main.ts";
const src = () => readFileSync(new URL(`../src/main.ts`, import.meta.url), "utf8");

/** 调用处：`commitCursorsIfOk(<实参>)`，不含它自己的声明那一行。 */
const calls = (s: string) =>
  [...s.matchAll(/(?<!function )commitCursorsIfOk\(([^)]*)\)/g)]
    .filter((m) => !/export function/.test(s.slice(Math.max(0, m.index! - 40), m.index!)))
    .map((m) => m[1].trim());

/** `commitCursors(` 出现的每一行（声明与调用都算），用来判「有没有人绕过那道闸」。 */
const bareLines = (s: string) =>
  s.split("\n").map((l, i) => ({ n: i + 1, l })).filter((x) => /\bcommitCursors\(/.test(x.l));

const assigns = (s: string) => [...s.matchAll(/process\.exitCode\s*=/g)].length;

describe("t-300 判据 7 · 接线也要有眼睛看着", () => {
  it("①调用处只有一处，而且传的是当前退出码——不是一个字面量", () => {
    const args = calls(src());
    expect(args, `${MAIN} 里 commitCursorsIfOk 的调用处`).toEqual(["process.exitCode"]);
  });

  it("②没有人绕过那道闸：`commitCursors` 只出现在它自己的声明与 `commitCursorsIfOk` 的函数体里", () => {
    for (const { n, l } of bareLines(src())) {
      const ok = /^export function commitCursors\(/.test(l.trim()) || /commitCursorsIfOk\(/.test(l);
      expect(ok, `${MAIN}:${n} 直接调了 commitCursors，绕过了「非零不提交」那道闸：${l.trim()}`).toBe(true);
    }
  });

  it("①的眼睛是活的：qa 那次注入（换成字面量 0）会红", () => {
    expect(calls(`commitCursorsIfOk(0);`)).toEqual(["0"]);
    expect(calls(`commitCursorsIfOk(0);`)).not.toEqual(["process.exitCode"]);
  });

  it("②的眼睛是活的：在收尾直接调 `commitCursors()` 会红", () => {
    const bypass = `  commitCursors();\n`;
    const bad = bareLines(bypass).filter(({ l }) => !/^export function commitCursors\(/.test(l.trim()) && !/commitCursorsIfOk\(/.test(l));
    expect(bad, "这一行该被抓住").toHaveLength(1);
  });

  it("声明那一行本身不算绕过（不然这道闸自己就红）", () => {
    expect(bareLines(`export function commitCursors(): void { for (const d of x) d.commit(); }`)
      .every(({ l }) => /^export function commitCursors\(/.test(l.trim()))).toBe(true);
  });

  /**
   * 冻住的是**非抛赋值退出码的处数**，不是哪几行（行号一改就失真）。此刻 4 处，没有一处住在会攒游标的
   * 命令里，所以 qa 要的真进程用例今天造不出来。**哪天这个数变了，就该有人回来看一眼它住在哪条命令里**：
   * 若那条命令会攒游标，真进程用例当场变成可能，也变成必须。
   */
  it("③非抛赋值退出码的地方冻在 4 处——变了就该回来看一眼它住在哪条命令里", () => {
    expect(assigns(src()), "多出来或少掉一处：见本条上面那段注释").toBe(4);
  });
});
