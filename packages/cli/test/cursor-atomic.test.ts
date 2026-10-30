/**
 * t-254：**游标写入不是原子的——一次被打断的写留下 0 字节，下一次从日志第一条重放。**
 *
 * 根因是 frontend 00:24 写清楚的：`writeFileSync` 先截断再写，kill 落在两步之间，文件就是空的；
 * `read()` 把空读成 `null`；`null` ⇒ 下一次从头拉。它咬了 qa 两次，第二次赔进 689 条全量重放。
 *
 * 判据 3 要这两条用例**在修之前先红**，所以它们测的是行为、不是实现：
 * 打断一次写之后，`cursor.<me>` 里**仍然是旧值**——不是 0 字节，也不是半条。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCursor, type CursorIo } from "../src/main.js";

const ME = "dev";
const OLD = "01M2AAAAAAAAAAAAAAAAAAAAAA";
const NEW = "01M2BBBBBBBBBBBBBBBBBBBBBB";

let root = "";
const cursorPath = () => join(root, ".ateam", `cursor.${ME}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cursor-"));
  mkdirSync(join(root, ".ateam"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** 真的 io，只是把 `renameSync` 换成「写完就死」——kill 落在写与 rename 之间的那一瞬。 */
const diesBeforeRename: CursorIo = {
  existsSync, readFileSync: (p, e) => readFileSync(p, e), mkdirSync: (p, o) => { mkdirSync(p, o); },
  writeFileSync, renameSync: () => { throw new Error("kill -9"); },
};

describe("t-254 · 游标写入被打断", () => {
  it("判据 1：写与 rename 之间被打断，游标仍是旧值——不是 0 字节，也不是半条", () => {
    writeFileSync(cursorPath(), OLD);
    const c = fileCursor(ME, root, diesBeforeRename);
    // **不断言它抛**——修之前它根本走不到 rename，那样断言红在「没抛」上，看不出真正的伤。
    // 这里只问一句：这一次写不管成没成，**旧值还在不在**。
    try { c.write(NEW); } catch { /* kill 落在两步之间，本来就该是这样 */ }
    expect(readFileSync(cursorPath(), "utf8").trim()).toBe(OLD);
    expect(fileCursor(ME, root).read()).toBe(OLD);
  });

  it("判据 2：write(null) 不落盘——文件已存在时内容不变", () => {
    writeFileSync(cursorPath(), OLD);
    fileCursor(ME, root).write(null);
    expect(readFileSync(cursorPath(), "utf8").trim()).toBe(OLD);
    expect(fileCursor(ME, root).read()).toBe(OLD);
  });

  it('判据 2：write("") 不落盘——文件已存在时内容不变', () => {
    writeFileSync(cursorPath(), OLD);
    fileCursor(ME, root).write("");
    expect(readFileSync(cursorPath(), "utf8").trim()).toBe(OLD);
  });

  it("判据 2：文件不存在时，write(null) 仍然不创建它", () => {
    expect(existsSync(cursorPath())).toBe(false);
    fileCursor(ME, root).write(null);
    expect(existsSync(cursorPath())).toBe(false);
  });

  it("正常写照旧：给一个真值就该记住它，而且下一次读得回来", () => {
    const c = fileCursor(ME, root);
    c.write(NEW);
    expect(c.read()).toBe(NEW);
    expect(readFileSync(cursorPath(), "utf8").trim()).toBe(NEW);
  });

  it("写完不留临时文件——半条状态不许留在那个目录里让下一个人捡到", () => {
    fileCursor(ME, root).write(NEW);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    expect(readdirSync(join(root, ".ateam"))).toEqual([`cursor.${ME}`]);
  });
});
