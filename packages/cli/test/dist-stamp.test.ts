/**
 * t-256 判据 3，**第二版**。qa `09:53` 判 fail，判的不是实现，是护栏：
 *
 * > `HEAD_B` 只是一个字符串常量，整条路径里没有任何代码会去读任何一个 git HEAD——`not.toContain(HEAD_B)`
 * > 这条断言，无论实现怎么写都为真。`distStamp()` 一条用例都没有。
 *
 * 它还用两次注入量了那条用例的力气，两次都在真路上看行为：**L1**（章读不到就退回 cwd 的 HEAD）与
 * **L2**（`distStamp()` 改成按 `process.cwd()` 找）——**两次 `cli-sha.test.ts` 都 5/5 全绿，而病原样回来了。**
 *
 * 所以这一份不递假函数、不用空目录：**一份真的构建放在 A，进程 cwd 设在一棵真的 git 检出 B 里**，
 * 而 B 自己也摆着一份章（sha 是 C）。三个 sha 互不相同，于是「它读的是哪一份」只有一个答案说得通。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";

const CLI_PKG = resolve(__dirname, "..");
const SHA_A = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";   // 跑着的那份构建出身于此
const SHA_C = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";   // 而 cwd 那棵树里**也摆着一份章**，出身于此
let A = "", B = "", shaB = "";

const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  // A：一份真的构建，连它边上的章。node_modules 软链过去，`@ateam/core` 才解析得到。
  A = mkdtempSync(join(tmpdir(), "t256A-"));
  cpSync(join(CLI_PKG, "dist"), join(A, "dist"), { recursive: true });
  symlinkSync(join(CLI_PKG, "node_modules"), join(A, "node_modules"));
  writeFileSync(join(A, "dist", "build.json"), JSON.stringify({ sha: SHA_A, dirty: false, at: "2026-09-14T00:00:00Z" }));

  // B：一棵**真的** git 检出，HEAD 是一个真的 sha；而且它自己也有一份 dist/build.json（sha 是 C）。
  B = mkdtempSync(join(tmpdir(), "t256B-"));
  git(B, "init", "-q", "-b", "main"); git(B, "config", "user.email", "t@t"); git(B, "config", "user.name", "t");
  writeFileSync(join(B, "f.txt"), "b");
  git(B, "add", "."); git(B, "commit", "-qm", "b");
  shaB = git(B, "rev-parse", "HEAD").stdout.trim();
  mkdirSync(join(B, "packages", "cli", "dist"), { recursive: true });
  writeFileSync(join(B, "packages", "cli", "dist", "build.json"), JSON.stringify({ sha: SHA_C, dirty: false, at: "2026-09-14T00:00:00Z" }));
  writeFileSync(join(B, "dist", "build.json".replace("build.json", "")) + "", "", { flag: "a" });   // no-op，保持目录结构简单
});
afterAll(() => { for (const d of [A, B]) rmSync(d, { recursive: true, force: true }); });

/** 在 cwd=B 的**子进程**里，用 A 那份构建自己的 `distStamp` 落一次 `cli.sha`，把发出去的事件收回来。 */
function runInB(): Promise<{ sent: Record<string, unknown>[]; err: string }> {
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(join(A, "dist", "main.js")).href)});
    const sent = [];
    await m.recordCliSha({ emit: async (e) => { sent.push(e); } }, "dev", m.distStamp, process.cwd());
    process.stdout.write("<<" + JSON.stringify(sent) + ">>");
  `;
  return new Promise((done) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { cwd: B, encoding: "utf8", timeout: 30_000 },
      (_e, out, err) => {
        const m = /<<([\s\S]*)>>/.exec(out);
        done({ sent: m ? (JSON.parse(m[1]) as Record<string, unknown>[]) : [], err });
      });
  });
}

describe("t-256 判据 3 · 三个 sha 摆在一起，只有一个答案说得通", () => {
  it("**跑得到 `distStamp()` 那条真路**：落的是 A，不是 cwd 的 HEAD（B），也不是 cwd 树里那份章（C）", async () => {
    const { sent, err } = await runInB();
    expect(err, "子进程不该报错").toBe("");
    expect(sent, "落了恰好一条").toHaveLength(1);
    expect(sent[0].value, "A = 正在执行的这份构建").toBe(SHA_A);
    const all = JSON.stringify(sent);
    expect(all, `B = cwd 的 HEAD（${shaB.slice(0, 7)}），判据 1 明令禁止`).not.toContain(shaB);
    expect(all, "C = cwd 树里那份章，L2 那种改法会读到它").not.toContain(SHA_C);
  }, 40_000);

  it("**章读不到时**：一条都不落，更不拿 cwd 的 HEAD 顶（L1 那种改法会在这里红）", async () => {
    unlinkSync(join(A, "dist", "build.json"));
    try {
      const { sent } = await runInB();
      expect(sent, "说不出是哪一版就不说").toEqual([]);
      expect(JSON.stringify(sent)).not.toContain(shaB);
    } finally {
      writeFileSync(join(A, "dist", "build.json"), JSON.stringify({ sha: SHA_A, dirty: false, at: "2026-09-14T00:00:00Z" }));
    }
  }, 40_000);

  it("场景自证：B 真是 git 检出、HEAD 真解得出、而且三个 sha 互不相同", () => {
    expect(shaB).toMatch(/^[0-9a-f]{40}$/);
    expect(new Set([SHA_A, SHA_C, shaB]).size).toBe(3);
    expect(git(B, "rev-parse", "HEAD").status).toBe(0);
  });
});

/**
 * qa `09:53` 的第 ① 条附带发现，**它不改判决，但它证明我证据里那句「脏树也不假装」是假的**：
 * `bin/stamp-cli` 判脏用的是 `git diff --quiet`，而那一条**只看未暂存的已跟踪改动**。
 * qa 在真树上逐种量过：改了没 add ⇒ `true`（对）；**改了并 `git add` ⇒ `false`；新增未跟踪的源文件 ⇒ `false`**。
 * **三种脏法里有两种它在假装。**
 *
 * 这一组把四种状态都钉住。`.gitignore` 照仓库里那份写（`dist/` `node_modules/` `.ateam/`），
 * 所以**构建自己的产物不会把树弄脏**——不写这一条，这组用例会永远为真。
 */
describe("t-256 · 盖章说「脏」的时候，三种脏法都得算", () => {
  const STAMP = resolve(CLI_PKG, "..", "..", "bin", "stamp-cli");
  let repo = "";
  /**
   * 脚本**按自己所在的位置**找仓库根（`dirname $0/..`），不看 cwd——与 `distStamp()` 同一条道理。
   * 所以要量它，就得把它放进那棵树的 `bin/` 里，只改 cwd 是量不到的（我第一版就是这么错的：
   * 它去盖了**真仓库**的章，temp 树里那个文件始终是空的）。
   */
  const stampDirty = (): boolean => {
    expect(spawnSync("sh", [join(repo, "bin", "stamp-cli")], { cwd: repo, encoding: "utf8" }).status, "盖章本身要成功").toBe(0);
    return JSON.parse(readFileSync(join(repo, "packages/cli/dist/build.json"), "utf8")).dirty as boolean;
  };
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "t256dirty-"));
    git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "t@t"); git(repo, "config", "user.name", "t");
    mkdirSync(join(repo, "packages", "cli", "dist"), { recursive: true });
    mkdirSync(join(repo, "bin"), { recursive: true });
    cpSync(STAMP, join(repo, "bin", "stamp-cli"));
    writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n.ateam/\n");
    writeFileSync(join(repo, "f.txt"), "x");
    git(repo, "add", ".gitignore", "f.txt", "bin/stamp-cli"); git(repo, "commit", "-qm", "c1");
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("干净树：不说脏（构建产物在 .gitignore 里，不会自己把树弄脏）", () => {
    expect(stampDirty()).toBe(false);
  });

  it("改了没 add ⇒ 脏（这一种旧版也对）", () => {
    writeFileSync(join(repo, "f.txt"), "x\ny");
    expect(stampDirty()).toBe(true);
  });

  it("**改了并 `git add` ⇒ 脏**（旧版在这里说 false）", () => {
    git(repo, "add", "f.txt");
    expect(stampDirty()).toBe(true);
  });

  it("**新增未跟踪的源文件 ⇒ 脏**（旧版在这里说 false）", () => {
    git(repo, "reset", "-q", "--hard", "HEAD");
    expect(stampDirty(), "先回到干净").toBe(false);
    writeFileSync(join(repo, "newsrc.ts"), "export const x = 1;");
    expect(stampDirty()).toBe(true);
  });
});
