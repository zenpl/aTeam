/**
 * t-211（qa 16:06 判 fail 时点名的那一格）：**判据 5 的一正一反用的是假的 Behind，真实那一路
 * `main.ts → realBehind → git` 一行测试都没有。** 于是「本地根本没有这个对象」该算什么，用例问都没问过——
 * 而那正是它翻车的地方：只跑 ateam、从不 fetch 的节点，六次上线全被算成「说不出」，整句不说。
 *
 * 这份用例造真的 git 仓库，跑真的 realBehind。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { realBehind, buildIsCurrent } from "../src/release.js";
import { behindDeploys } from "@ateam/core";

let root = "";
let shas: string[] = [];
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "t211-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(root, `f${i}.txt`), String(i));
    git(root, "add", ".");
    git(root, "commit", "-qm", `c${i}`);
    shas.push(git(root, "rev-parse", "HEAD").stdout.trim());
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("t-211 · 真 git，不是假的 Behind", () => {
  it("头就是最新那次上线：不落后", () => {
    const b = realBehind(root);
    expect(b.head()).toBe(shas[2]);
    expect(behindDeploys(b.head(), shas, b.has)).toBe(0);
  });

  it("退回第一个提交：落后两次，数得出来", () => {
    git(root, "checkout", "-q", shas[0]);
    const b = realBehind(root);
    expect(behindDeploys(b.head(), shas, b.has)).toBe(2);
    git(root, "checkout", "-q", "main");
  });

  it("**本地根本没有那个 sha（从不 fetch 的那种树）：算「我没有」，不是说不出**", () => {
    const b = realBehind(root);
    const stranger = "0".repeat(40);                    // 这棵树里不存在的对象
    expect(b.has(stranger)).toBe(false);                // 不是 null
    expect(behindDeploys(b.head(), [stranger, ...shas], b.has)).toBe(1);
  });

  it("不是 git 检出：说不出，整句不说", () => {
    const bare = mkdtempSync(join(tmpdir(), "t211-nogit-"));
    try {
      const b = realBehind(bare);
      expect(b.head()).toBeNull();
      expect(behindDeploys(b.head(), shas, b.has)).toBeNull();
    } finally { rmSync(bare, { recursive: true, force: true }); }
  });
});

describe("t-211 · dist 跟不跟得上源码，也用真文件量", () => {
  const mk = (base: string, pkg: string, srcAge: number, distAge: number) => {
    for (const [dir, age] of [["src", srcAge], ["dist", distAge]] as const) {
      mkdirSync(join(base, "packages", pkg, dir), { recursive: true });
      const f = join(base, "packages", pkg, dir, "x.js");
      writeFileSync(f, "x");
      const t = Date.now() / 1000 - age;
      utimesSync(f, t, t);
    }
  };

  it("产物比源码新：跟得上", () => {
    const base = mkdtempSync(join(tmpdir(), "t211-b-"));
    try { mk(base, "core", 100, 10); expect(buildIsCurrent(base, ["core"])).toBe(true); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("**源码比产物新（只 pull 不重编）：跟不上**", () => {
    const base = mkdtempSync(join(tmpdir(), "t211-b2-"));
    try { mk(base, "core", 10, 100); expect(buildIsCurrent(base, ["core"])).toBe(false); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("根本没有 dist：说不出（null），不是「跟不上」也不是「跟得上」", () => {
    const base = mkdtempSync(join(tmpdir(), "t211-b3-"));
    try {
      mkdirSync(join(base, "packages", "core", "src"), { recursive: true });
      writeFileSync(join(base, "packages", "core", "src", "x.ts"), "x");
      expect(buildIsCurrent(base, ["core"])).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
