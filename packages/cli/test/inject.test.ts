/**
 * t-205 · **`bin/inject` 还原源码，但不还原产物。**
 *
 * frontend 13:10 自报（它自己 t-177 写的那个脚本）：一轮注入结束后源码已被 git 还原、`git status` 干净，
 * 而 `dist` 仍是**按注入过的源码**编出来的。下一条不重新 build 的命令读到的，是一棵源码里已经不存在的树——
 * 它据此看到过一次假的「基线 3 failed」，差点当成真失败报上去。
 *
 * 这与那个脚本自己头上记的坑（「一次失败的注入把已经损坏的树备份了进去」）是同一类，**只是坏的不是源码是产物**。
 *
 * 这里不跑真的 build：造一棵临时 git 仓库，把 `pnpm`／`npx` 换成两行假的（build 就是把源码抄进 dist），
 * 于是这条用例证的是**脚本的控制流**——还原之后有没有重编——而不是这个仓库能不能编过。快，而且证的正是那件事。
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const INJECT = new URL("../../../bin/inject", import.meta.url).pathname;
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** 一棵临时仓库：一个源码文件、一个「产物」，外加两个假命令。`testExit` 决定注入之后那次测试跑成什么。 */
function repo(testExit: number, buildExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "t205-"));
  made.push(dir);
  const run = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "packages/one/dist"), { recursive: true });
  mkdirSync(join(dir, "fake"));
  copyFileSync(INJECT, join(dir, "bin/inject"));
  chmodSync(join(dir, "bin/inject"), 0o755);
  writeFileSync(join(dir, "src.txt"), "GOOD\n");
  writeFileSync(join(dir, "packages/one/dist/out.txt"), "GOOD\n");   // 「产物」，按源码编出来的
  // 假的 build：把源码抄进产物，与真 build 一样「产物跟着源码走」
  writeFileSync(join(dir, "fake/pnpm"), `#!/bin/sh\n[ ${buildExit} -ne 0 ] && exit ${buildExit}\nmkdir -p packages/one/dist\ncp src.txt packages/one/dist/out.txt\n`);
  writeFileSync(join(dir, "fake/npx"), `#!/bin/sh\nexit ${testExit}\n`);
  for (const f of ["pnpm", "npx"]) chmodSync(join(dir, "fake", f), 0o755);
  run("init", "-q", "."); run("config", "user.email", "t@t"); run("config", "user.name", "t");
  run("add", "-A"); run("commit", "-qm", "base");
  const inject = () => spawnSync("sh", ["bin/inject", "src.txt", "GOOD", "BAD"], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "fake")}:${process.env.PATH}` },
  });
  const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), "utf8") : null);
  return { dir, inject, read };
}

describe("t-205 · 注入跑完之后，产物也回到跑之前", () => {
  it("判据 1：正常结束——源码还原了，产物也还原了", () => {
    const w = repo(1);                                   // 注入之后测试红，这是「注入成功」的正常样子
    w.inject();
    expect(w.read("src.txt"), "源码这一半上一版就是对的").toBe("GOOD\n");
    expect(w.read("packages/one/dist/out.txt"), "产物还留着注入过的那一版——下一条命令读到的就是它").toBe("GOOD\n");
  });

  it("判据 2：注入之后测试仍然全绿（那是要发现的坏消息）——照样还原", () => {
    const w = repo(0);
    const r = w.inject();
    expect(r.status, "注入之后仍然 0，脚本要把这个退出码原样传出去").toBe(0);
    expect(w.read("src.txt")).toBe("GOOD\n");
    expect(w.read("packages/one/dist/out.txt")).toBe("GOOD\n");
  });

  it("判据 2：中途失败也还原——重编都编不过时，宁可没有产物，也不留一份对不上号的", () => {
    const w = repo(1, 7);                                // build 一开始就失败：注入之后走 exit 3 那条路
    const r = w.inject();
    expect(r.status, "注入之后 build 没过，脚本自己说这不算「断言会红」").toBe(3);
    expect(w.read("src.txt")).toBe("GOOD\n");
    expect(w.read("packages/one/dist/out.txt"), "编不出来就该删掉，让下一条命令报「没有 dist」").toBeNull();
  });
});
