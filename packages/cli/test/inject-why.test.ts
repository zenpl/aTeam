/**
 * t-350 · **它说「build 没过」时要说出是谁红的，并且把编译器原样说的话带上。**
 *
 * 出处是 dev 22:50 自己栽的那一处：它看得见的只有「换一个注入点」，而真相是它自己那棵树本来就是红的——
 * 于是它去指控这个工具误报，两小时后才发现。一句话把两件不同的事说成了同一件，代价是两小时加一张撤掉的单（t-348）。
 *
 * 三种处境在这里各一格，**分法是量出来的**：build 没过时脚本把注入还原回去再 build 一次，
 * 还原之后过了＝这次注入的责任（判据②第一句）／还原之后仍然红＝这棵树自己红（第二句）／
 * 两次里一条编译器诊断都没有＝不是编译器在说话（第三句）。
 *
 * 断言里的句子**从 core 取**，不在这儿抄一份：pd 改一个字，这个文件不用动（t-187 的出处规则）。
 *
 * 这里不跑真的 build（同 t-205 那条的做法）：造一棵临时 git 仓库，把 `pnpm`／`npx` 换成假的，
 * 于是证的是**脚本的控制流与它说的话**，而不是这个仓库此刻编不编得过。快，而且证的正是那件事。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  INJECT_BUILD_BROKE, INJECT_BUILD_OWN_RED, INJECT_BUILD_OWN_RED_DO,
  INJECT_BUILD_NOT_COMPILER, INJECT_BUILD_NOT_COMPILER_DO,
  injectBuildRan, injectBuildRanQuiet, injectBuildMore, injectAbandonedAt,
} from "@ateam/core";

const INJECT = new URL("../../../bin/inject", import.meta.url).pathname;
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** 四行编译器诊断，首末两行是断言要逐字找的那两行；中间两行要被省掉。 */
const DIAG = [
  "src/format.ts(308,42): error TS2339: Property 'branch' does not exist on type 'BoardTask'.",
  "src/a.ts(9,1): error TS2554: Expected 2 arguments, but got 1.",
  "src/b.ts(4,2): error TS2345: Argument of type 'string' is not assignable.",
  "src/c.ts(7,7): error TS2304: Cannot find name 'Event'.",
];
const NOISE = "ERR_PNPM_NO_SCRIPT  Missing script: build";

type Build = "green" | "red-always" | "red-when-injected" | "red-no-diag";

/** 四种假 build。`red-when-injected` 是**只在源码被注入过时才红**的那一种——注入点不对的真样子。 */
function fakeBuild(kind: Build): string {
  const diag = DIAG.map((l) => `echo ${JSON.stringify(l)}`).join("\n");
  const ok = "mkdir -p packages/one/dist\ncp src.ts packages/one/dist/out.ts\n";
  if (kind === "green") return `#!/bin/sh\n${ok}`;
  if (kind === "red-always") return `#!/bin/sh\n${diag}\nexit 1\n`;
  if (kind === "red-no-diag") return `#!/bin/sh\necho ${JSON.stringify(NOISE)} >&2\nexit 7\n`;
  return `#!/bin/sh\nif grep -q BAD src.ts; then\n${diag}\nexit 2\nfi\n${ok}`;
}

function repo(kind: Build, testExit = 1) {
  const dir = mkdtempSync(join(tmpdir(), "t350-"));
  made.push(dir);
  const run = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "packages/one/dist"), { recursive: true });
  mkdirSync(join(dir, "fake"));
  copyFileSync(INJECT, join(dir, "bin/inject"));
  chmodSync(join(dir, "bin/inject"), 0o755);
  // 一个带符号的源码文件：判据④要留痕的「符号」就是从它这儿走出来的。
  writeFileSync(join(dir, "src.ts"), "export function keeper() {\n  return \"GOOD\";\n}\n");
  writeFileSync(join(dir, "packages/one/dist/out.ts"), "GOOD\n");
  writeFileSync(join(dir, "fake/pnpm"), fakeBuild(kind));
  writeFileSync(join(dir, "fake/npx"), `#!/bin/sh\nexit ${testExit}\n`);
  for (const f of ["pnpm", "npx"]) chmodSync(join(dir, "fake", f), 0o755);
  run("init", "-q", "."); run("config", "user.email", "t@t"); run("config", "user.name", "t");
  run("add", "-A"); run("commit", "-qm", "base");
  const inject = (from = "GOOD", to = "BAD") => {
    const r = spawnSync("sh", ["bin/inject", "src.ts", from, to], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "fake")}:${process.env.PATH}` },
    });
    return { status: r.status, said: `${r.stdout}${r.stderr}` };
  };
  const trail = () => {
    const p = join(dir, ".ateam/inject.abandoned.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  };
  return { dir, inject, trail, ran: (code: string) => injectBuildRan("pnpm -r build", dir, code), quiet: (code: string) => injectBuildRanQuiet("pnpm -r build", dir, code) };
}

describe("t-350 · 三种处境分三句，谁红的说得出来", () => {
  it("判据②第一句＋判据③正向：注入点不对（还原之后就过了）——说「换一个注入点」，并印出编译器原文", () => {
    const w = repo("red-when-injected");
    const r = w.inject();
    expect(r.status, "build 没过这条路，退出码仍是 3").toBe(3);
    expect(r.said).toContain(INJECT_BUILD_BROKE);
    expect(r.said, "这棵树自己没红，不许把责任推给它").not.toContain(INJECT_BUILD_OWN_RED);
    // 判据①：命令、退出码、首条与末条错误，四样都在
    expect(r.said).toContain(w.ran("2"));
    expect(r.said, "首条").toContain(DIAG[0]);
    expect(r.said, "末条").toContain(DIAG[3]);
    expect(r.said).toContain(injectBuildMore("2", join(w.dir, ".ateam/inject.build.log")));
    expect(r.said, "中间那两条省掉了，省了几行自己说").not.toContain(DIAG[1]);
  });

  it("判据②第二句：这棵树注入之前就是红的——红的是那处改动，不是注入点，照旧印原文", () => {
    const w = repo("red-always");
    const r = w.inject();
    expect(r.status).toBe(3);
    expect(r.said, "这正是 22:50 那一处：当时它说的是「换一个注入点」").toContain(INJECT_BUILD_OWN_RED);
    expect(r.said, "pd 定稿：说完量到的那件事，还要给动作").toContain(INJECT_BUILD_OWN_RED_DO);
    expect(r.said, "量到的只是「还原后仍然红」，不许写成指控").not.toContain("红的是你这处改动");
    expect(r.said).not.toContain(INJECT_BUILD_BROKE);
    expect(r.said, "基线那次 build 的退出码").toContain(w.ran("1"));
    expect(r.said).toContain(DIAG[0]);
    expect(r.said).toContain(DIAG[3]);
  });

  it("判据②第三句：一条编译器诊断都没有——不许归因给代码，把命令原样交回去", () => {
    const w = repo("red-no-diag");
    const r = w.inject();
    expect(r.status).toBe(3);
    expect(r.said).toContain(INJECT_BUILD_NOT_COMPILER);
    expect(r.said, "这一档的全部意义就是挡住错误归因").toContain(INJECT_BUILD_NOT_COMPILER_DO);
    expect(r.said).not.toContain(INJECT_BUILD_BROKE);
    expect(r.said).not.toContain(INJECT_BUILD_OWN_RED);
    expect(r.said, "它说了什么就印什么，哪怕不是编译器说的").toContain(NOISE);
    expect(r.said, "这一档不许说「编译器自己的话」：后面跟着的是 pnpm 的噪声").toContain(w.quiet("7"));
    expect(r.said).not.toContain(w.ran("7"));
  });

  it("判据③反向：build 其实是绿的——一句失败都不许报，退出码就是那次测试的", () => {
    const w = repo("green", 1);
    const r = w.inject();
    expect(r.status, "注入之后测试红＝注入成功，这是正常结束").toBe(1);
    for (const s of [INJECT_BUILD_BROKE, INJECT_BUILD_OWN_RED, INJECT_BUILD_NOT_COMPILER]) {
      expect(r.said, "绿的 build 不许说出任何一句「没过」").not.toContain(s);
    }
    expect(w.trail(), "没有放弃任何注入点，就不该留痕").toEqual([]);
  });
});

describe("t-350 判据④ · 被放弃的注入点留得下痕：文件、符号、形状", () => {
  it("注入点不对时记一条——文件、行、符号、形状、放弃的理由都在，并且告诉人记在哪儿", () => {
    const w = repo("red-when-injected");
    const r = w.inject();
    expect(r.said).toContain(injectAbandonedAt(join(w.dir, ".ateam/inject.abandoned.jsonl")));
    const [rec, ...rest] = w.trail();
    expect(rest, "一次注入记一条").toEqual([]);
    expect(rec.file).toBe("src.ts");
    expect(rec.symbol, "符号从源码走出来，不靠人填").toBe("keeper");
    expect(rec.line).toBe(2);
    expect(rec.shape).toEqual({ head: "GOOD", chars: 4, lines: 1 });
    expect(rec.why, "放弃的理由分类，不是一句散文").toBe("site-does-not-compile");
    expect(typeof rec.at).toBe("string");
  });

  it("注入点压根找不到，也是一个被放弃的注入点——「量不到」正是它要堵的那件事", () => {
    const w = repo("green");
    const r = w.inject("这里没有这段字", "X");
    expect(r.status).toBe(2);
    const [rec] = w.trail();
    expect(rec.why).toBe("no-site");
    expect(rec.symbol, "找不到就说不出符号，不编一个").toBeNull();
    expect(rec.line).toBeNull();
    expect(rec.shape.head).toBe("这里没有这段字");
  });

  it("这棵树自己红的那一次，记的理由与注入点不对那一次不是同一个", () => {
    const w = repo("red-always");
    w.inject();
    expect(w.trail()[0].why).toBe("tree-already-red");
  });
});
