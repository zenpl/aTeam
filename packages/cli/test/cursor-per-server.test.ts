/**
 * t-293 判据 8①：**读位置按「服务器＋角色」隔离。**
 *
 * qa 06:33 量出的第四种静默改写，与另三种同一个格子：游标文件原来只按角色命名，于是**另一台服务器一个格式
 * 完全正确的回包**就能把它改写成那本日志里的 id。`advance` 的单调闸挡不住——它只问「是不是更大」，而两本
 * 日志的 ULID 之间没有可比性，**「更大」在这里不是「更新」**。
 *
 * 所以这里的反例用的是一个**比原值大的、合法的 ULID**：旧代码会老老实实把它写进去（单调闸认为这是前进），
 * 而那正是静默改写的样子。换成「更小的 id」就验不到东西了——那种旧代码也挡得住。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileCursor, seenCursor, serverKey } from "../src/main.js";

const ME = "dev";
const A = "https://a.example/";
const B = "https://b.example";
/** B 那本日志里的位置**比 A 的大**——旧代码的单调闸会放它过去。 */
const A_AT = "01M50000000000000000000001";
const B_AT = "01M90000000000000000000009";

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "t293-pers-")); mkdirSync(join(root, ".ateam")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const files = () => readdirSync(join(root, ".ateam")).sort();
const legacy = (v: string) => writeFileSync(join(root, ".ateam", `cursor.${ME}`), v);

describe("t-293 判据 8① · 游标按服务器＋角色隔离", () => {
  it("两台服务器各写各的文件，谁也盖不掉谁——即使后者的 id 更大", () => {
    const a = fileCursor(ME, root, undefined, "cursor", serverKey(A));
    const b = fileCursor(ME, root, undefined, "cursor", serverKey(B));
    a.write(A_AT);
    b.write(B_AT);
    expect(a.read(), "A 的位置没被 B 那个更大的 id 改写").toBe(A_AT);
    expect(b.read()).toBe(B_AT);
    expect(B_AT > A_AT, "这个反例要的就是「更大」——否则旧代码也挡得住").toBe(true);
    expect(files()).toEqual([`cursor.${ME}.${serverKey(A)}`, `cursor.${ME}.${serverKey(B)}`].sort());
  });

  it("serverKey 规范化：末尾斜杠与大小写不把同一台算成两台；不同主机算两台", () => {
    expect(serverKey("https://x.fly.dev/")).toBe(serverKey("https://X.fly.dev"));
    expect(serverKey("https://x.fly.dev")).not.toBe(serverKey("https://y.fly.dev"));
  });

  it("seen 那一处同样隔离（它和 cursor 各证各的，t-274）", () => {
    seenCursor(ME, root, undefined, serverKey(A)).write(A_AT);
    seenCursor(ME, root, undefined, serverKey(B)).write(B_AT);
    expect(seenCursor(ME, root, undefined, serverKey(A)).read()).toBe(A_AT);
    expect(seenCursor(ME, root, undefined, serverKey(B)).read()).toBe(B_AT);
  });

  it("旧文件认：只有 cursor.<me>（升级前留下的那个）时，本服务器接过来——不让所有人重放一次", () => {
    legacy(A_AT);
    expect(fileCursor(ME, root, undefined, "cursor", serverKey(A)).read()).toBe(A_AT);
  });

  it("旧文件不猜：目录里已经有另一台服务器的位置，就说明这个检出不止一台——那个旧值是谁的说不出来，从 null 起算", () => {
    legacy(B_AT);
    fileCursor(ME, root, undefined, "cursor", serverKey(B)).write(B_AT);
    expect(fileCursor(ME, root, undefined, "cursor", serverKey(A)).read(), "说不出就不猜").toBeNull();
  });

  it("接过旧文件之后写一次，写的是本服务器那个文件；旧文件一个字节没动（降级回去还读得到）", () => {
    legacy(A_AT);
    const a = fileCursor(ME, root, undefined, "cursor", serverKey(A));
    a.write("01M60000000000000000000006");
    expect(readFileSync(join(root, ".ateam", `cursor.${ME}`), "utf8")).toBe(A_AT);
    expect(a.read()).toBe("01M60000000000000000000006");
  });

  it("临时文件也带服务器那一段：两台各崩在两步之间，留下的是各自一个", () => {
    const dies = (p: string) => ({
      existsSync, readFileSync: (f: string, e: "utf8") => readFileSync(f, e), mkdirSync: (f: string, o: { recursive: true }) => { mkdirSync(f, o); },
      writeFileSync, readdirSync: (f: string) => readdirSync(f),
      renameSync: () => { throw new Error(`死在 rename 之前：${p}`); },
    });
    expect(() => fileCursor(ME, root, dies(A), "cursor", serverKey(A)).write(A_AT)).toThrow();
    expect(() => fileCursor(ME, root, dies(B), "cursor", serverKey(B)).write(B_AT)).toThrow();
    expect(files()).toEqual([`cursor.${ME}.${serverKey(A)}.tmp`, `cursor.${ME}.${serverKey(B)}.tmp`].sort());
    expect(existsSync(join(root, ".ateam", `cursor.${ME}.tmp`)), "没有一个共用的临时文件").toBe(false);
  });

  it("没给服务器身份时沿用旧名字——既有调用方与既有用例因此一个字不用改", () => {
    fileCursor(ME, root).write(A_AT);
    expect(files()).toEqual([`cursor.${ME}`]);
  });
});
