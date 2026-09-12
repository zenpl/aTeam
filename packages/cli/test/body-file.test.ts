/**
 * t-246：**正文里的反引号被 shell 吃掉**——今天咬了三个人至少五次，而全队的对策是「每个人记得先写文件、
 * 再 `"$(cat …)"`」。pm 17:2x 把这条规矩广播出去，**45 分钟后 qa 就在一条生产判决的证据里踩了同一个坑**；
 * dev 09-07 也立过同一条，只对长 note 执行、短 tell 从没执行。**一条要五个人各自记住的规矩，
 * 今天量到的失效间隔是 45 分钟。**
 *
 * 判据 3 的另一半：**回执要能证明「我写的那句原样进去了」**——此刻「命令跑完了」与「正文原样进去了」
 * 分不开，被吃掉一段的正文落库之后回执长得一模一样。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, fromFiles, UsageError } from "../src/args.js";
import { BOTH_BODY_AND_FILE, TWICE_GIVEN } from "@ateam/core";

const read = (p: string) => (p === "/tmp/x" ? "从文件里读出来的一段：`反引号` 与 $变量 都原样" : "");

describe("t-246 判据 1 · --X-file 从文件读那一段字", () => {
  it("--body-file 变成 --body，文件里的反引号与 $ 原样进去", () => {
    const a = parse(["note", "--body-file", "/tmp/x"]);
    fromFiles(a, read);
    expect(a.flags["body"]).toBe("从文件里读出来的一段：`反引号` 与 $变量 都原样");
    expect(a.flags["body-file"], "用过就不留着，免得两份并存").toBeUndefined();
  });

  it("不只是正文：--evidence-file、--reason-file、--resolution-file 都走同一条", () => {
    const a = parse(["task", "done", "t-1", "--evidence-file", "/tmp/x", "--reason-file", "/tmp/x"]);
    fromFiles(a, read);
    expect(a.flags["evidence"]).toContain("反引号");
    expect(a.flags["reason"]).toContain("反引号");
  });

  it("两条都给了就报用法错，不猜哪个算数", () => {
    const a = parse(["note", "写在命令行上的", "--body", "命令行", "--body-file", "/tmp/x"]);
    expect(() => fromFiles(a, read)).toThrow(UsageError);
    try { fromFiles(a, read); } catch (e) { expect((e as Error).message).toBe(BOTH_BODY_AND_FILE("body")); }
  });

  it("文件末尾那个换行不算正文；正文里的换行一个都不动", () => {
    const a = parse(["note", "--body-file", "/tmp/nl"]);
    fromFiles(a, () => "第一行\n\n第三行\n\n");
    expect(a.flags["body"]).toBe("第一行\n\n第三行");
  });

  it("没有 -file 的时候一个字都不动", () => {
    const a = parse(["note", "就在命令行上", "--task", "t-1"]);
    const before = JSON.stringify(a.flags);
    fromFiles(a, read);
    expect(JSON.stringify(a.flags)).toBe(before);
  });
});

/**
 * 判据 3 的那一半，qa 22:42 量完之后是这样：**回执本来就回显落库内容**——那一行印的是服务返回的事件，
 * 而 `fmt.event` 对 body／evidence／resolution／reason 一个字都不截断。我加的那行「落库 N 字：首…末」
 * **一次都印不出来**（永远已经整句在上面），已删。更要紧的是：**没有任何回执抓得住 shell 吃字**，
 * 它发生在命令行看见这段字之前——抓得住它的是 `--X-file`，也就是上面那几条。
 */

/**
 * t-246 ②（qa 22:42 量到）：**同一个 `--X` 给两次，后一个静默胜出。** 它咬的第一件事就是 `--body-file`：
 * 两份正文里工具替你挑了一份。t-197 那条注释早写过这个形状（`--refs a --refs b` 后一个静默盖掉前一个），
 * 当时的出路是把该重复的加进 REPEATABLE；**不该重复的那些，现在一律当场报用法错。**
 */
describe("t-246 ② · 同一个开关给两次：报错，不静默挑一个", () => {
  it("--body-file 给两个不同文件 ⇒ 用法错，一个字都没发", () => {
    expect(() => parse(["note", "--body-file", "/tmp/a", "--body-file", "/tmp/b"])).toThrow(UsageError);
    try { parse(["note", "--body-file", "/tmp/a", "--body-file", "/tmp/b"]); }
    catch (e) { expect((e as Error).message).toBe(TWICE_GIVEN("body-file")); }
  });

  it("该重复的照旧重复：--refs、--touches 那几个一个字没变", () => {
    const a = parse(["task", "done", "t-1", "--refs", "01A", "--refs", "01B", "--touches", "x.ts", "--touches", "y.ts"]);
    expect(a.flags["refs"]).toEqual(["01A", "01B"]);
    expect(a.flags["touches"]).toEqual(["x.ts", "y.ts"]);
  });

  it("布尔开关写两遍也是两次：同样报错（省得「写两遍等于没写」这种猜法）", () => {
    expect(() => parse(["task", "verify", "t-1", "--pass", "--pass"])).toThrow(UsageError);
  });
});
