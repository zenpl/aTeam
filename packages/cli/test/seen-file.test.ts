/**
 * t-274：**`seen.<me>` 这个文件本身**——它与 `cursor.<me>` 各走各的，而升级那一刻不许倒带。
 *
 * 用真目录、真文件，不用替身：这一格出过事的正是「文件在不在」与「读成了什么」之间的差别（t-254 那 689 条重放）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCursor, seenCursor } from "../src/main.js";

const ME = "qa";
const A = "01M2AAAAAAAAAAAAAAAAAAAAAA";
const B = "01M2BBBBBBBBBBBBBBBBBBBBBB";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "seen-")); mkdirSync(join(root, ".ateam"), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("t-274 · seen.<me> 与 cursor.<me>", () => {
  it("没有 seen 文件就是 null，**不退回 cursor**——「seen 还不存在」正是被咬的那个节点的样子", () => {
    // 我第一版写的是退回 cursor，理由是「升级不该倒带」。真实那一幕当场证伪：qa 与任何还没 sync 过的节点
    // 都没有这个文件，退回去等于把读位置对齐到 watch 推过的位置，那一批照旧丢。这条用例钉的就是那次更正。
    fileCursor(ME, root).write(A);
    expect(existsSync(join(root, ".ateam", `seen.${ME}`)), "此刻还没有这个文件").toBe(false);
    expect(seenCursor(ME, root).read(), "读成 null：从没有人证明读过任何东西").toBeNull();
  });

  it("写只写自己那个文件：写过一次之后两者各走各的", () => {
    fileCursor(ME, root).write(A);
    seenCursor(ME, root).write(B);
    expect(readFileSync(join(root, ".ateam", `seen.${ME}`), "utf8")).toBe(B);
    expect(readFileSync(join(root, ".ateam", `cursor.${ME}`), "utf8"), "cursor 一个字没被动").toBe(A);
    expect(seenCursor(ME, root).read()).toBe(B);
  });

  it("cursor 在前、seen 在后：这正是 watch 吃过一批之后那个节点的样子", () => {
    seenCursor(ME, root).write(A);          // 上次真读到这儿
    fileCursor(ME, root).write(B);          // 后台 watch 又送到了这儿
    expect(seenCursor(ME, root).read(), "读位置不被送达位置带着走").toBe(A);
  });

  it("空文件仍然读成 null——修 t-254 之前留下的 0 字节，这一支也要认得", () => {
    writeFileSync(join(root, ".ateam", `seen.${ME}`), "");
    expect(seenCursor(ME, root).read()).toBeNull();
  });
});
