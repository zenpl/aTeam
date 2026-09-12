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
import { storedLine, STORED_ECHO, BOTH_BODY_AND_FILE } from "@ateam/core";

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

describe("t-246 判据 3 · 回执证明它原样进去了", () => {
  it("长正文：报字数与首尾各若干字——**被吃掉一段的，字数与尾巴都对不上**", () => {
    const text = `${"一".repeat(STORED_ECHO * 2 + 10)}末尾这几个字`;   // 超过 STORED_ECHO*2 才会被截，短的本来就整句给全
    const line = storedLine("body", text);
    expect(line).toContain(`落库 ${[...text].length} 字`);
    expect(line).toContain("末尾这几个字");
    expect(line).toContain("…");
    // 被 shell 吃掉一段之后：两条回执不可能相同
    const eaten = text.replace("末尾这几个字", "");
    expect(storedLine("body", eaten)).not.toBe(line);
  });

  it("短的照原样给全，不摆省略号", () => {
    const line = storedLine("body", "短短一句");
    expect(line).toContain("短短一句");
    expect(line).not.toContain("…");
  });

  it("换行压成空格：回执是一行，不许把终端刷满", () => {
    expect(storedLine("evidence", `${"甲".repeat(STORED_ECHO)}\n中间\n${"乙".repeat(STORED_ECHO)}`)).not.toContain("\n");
  });
});
