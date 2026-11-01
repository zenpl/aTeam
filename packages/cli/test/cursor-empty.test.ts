/**
 * t-351（pd 要求㉝㉞，decision `01M6A3XSQKSZHP8BSHZWEQ87C1`）：**空不是「没有」；一次「从头全量」必须出声。**
 *
 * pm 23:14 的现场（它量的，我按归属引）：崩溃重起的窗口里 `.ateam/cursor.pm` 读出来是空的，于是 `--after=`
 * 空着发出去，**服务端把整份日志 14375 条、414 KB 全给了它**；一分钟后同一个文件读出的是正常游标。
 * 读数 `repo:cursor.file.read.empty.during.restart`。
 *
 * pd 把它与它自己 18:51 那次并成一对：那次是「读不出来却算读过了」，这次是「读到空却算从没读过」——
 * **一个空的值和一个「没有值」长得一模一样**。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync, watch } from "../src/loop.js";
import { fileCursor, cursorForCommand, seenCursor } from "../src/main.js";
import { CURSOR_UNREADABLE, fullPullLine, type PullResult, type Event } from "@ateam/core";

const ME = "pm";
const ev = (id: string): Event => ({ id, at: "2026-10-31T23:14:00.000Z", actor: "pd", kind: "note", body: "一条" } as unknown as Event);

/** 一个真的 `.ateam/` 目录：三种处境各造一次。 */
function tree(kind: "none" | "empty" | "value") {
  const root = mkdtempSync(join(tmpdir(), "ateam-cursor-"));
  mkdirSync(join(root, ".ateam"));
  if (kind === "empty") writeFileSync(join(root, ".ateam", `cursor.${ME}`), "");
  if (kind === "value") writeFileSync(join(root, ".ateam", `cursor.${ME}`), "01M6A3Z8EMQCST1DKZ3H7AC1DK");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const puller = (events: Event[]) => {
  const calls: (string | null)[] = [];
  return { calls, pull: async (after: string | null) => { calls.push(after); return { events, cursor: events.at(-1)?.id, owed: undefined } as unknown as PullResult; } };
};

describe("t-351 · 游标文件在而读出来是空的，与连文件都没有，是两件事", () => {
  it("**判据 4、7**：三种处境各有自己的表示，不共用", () => {
    for (const kind of ["none", "empty", "value"] as const) {
      const t = tree(kind);
      try {
        expect(fileCursor(ME, t.root).state?.(), kind).toBe(kind);
      } finally { t.cleanup(); }
    }
  });

  it("**判据 7**：`read()` 对前两档照旧都给 null——所以分得出两档的是 state()，而老调用方一个字没改", () => {
    for (const kind of ["none", "empty"] as const) {
      const t = tree(kind);
      try { expect(fileCursor(ME, t.root).read()).toBeNull(); } finally { t.cleanup(); }
    }
  });

  /**
   * 重交补的那一格（pd 10:45 报的方向）：**上面那一格喂给 `sync()` 的是裸的 `fileCursor`，而真实路径上
   * 它永远是 `cursorForCommand()` 包过的那一层**——而那一层上一版只转发 `read`／`write`／`commit`，
   * 把 `state` 丢了。于是判据 2 在用例里成立、在真路径上不成立：空游标被读成「没有游标」，从头拉。
   *
   * 本地实测过那个后果：`cursor.<me>.<key>` 与 `seen.<me>.<key>` 都清成 0 字节，`sync` 从头拉了 909 条。
   * 所以这一格钉的是**经过包装之后还认不认得空**，而不是 `sync()` 自己的判断（那一格在上面）。
   */
  /**
   * 第三格（端到端量出来的）：**看守走的是另一条路。** 两个游标文件都清成 0 字节之后，`sync` 按定稿拒了，
   * 而 `watch --once` 照旧从头拉了 909 条——它走 `pullBatch`，压根没经过 `sync()` 里那道闸。
   * 而看守是每个节点一直在跑的那个东西，所以这一格比上面两格更贴近真实伤害（pd 10:45 撞的就是它）。
   *
   * 处置按定稿那三句的字面：不拉、不推进、过一会儿再试。`once` 的调用方直接拿回空结果（用例靠它收场）。
   */
  it("**判据 2，看守那条路**：空游标 ⇒ 看守也一条都不拉，而且说同样那三句", async () => {
    const t = tree("empty");
    try {
      const p = puller([ev("01A"), ev("01B")]);
      const out: string[] = [];
      const cur = cursorForCommand(fileCursor(ME, t.root));
      const r = await watch(p as never, ME, cur as never, 60_000, (l) => out.push(l), { once: true, sleep: async () => {} });
      expect(p.calls, "看守也没有发出那一次拉取").toEqual([]);
      expect(r.events).toEqual([]);
      expect(out.join("\n")).toContain(CURSOR_UNREADABLE.split("\n")[0]);
    } finally { t.cleanup(); }
  });

  it("**判据 2，真路径**：按 main.ts 那个组合（两层包装 ＋ seen）喂进去，空游标照样一条都不拉", async () => {
    const t = tree("empty");
    try {
      // 真路径上 sync() 收到的就是这两个：cursor 与 seen 各自 fileCursor → seenCursor → cursorForCommand，
      // 而它读的是 `seen ?? cursor`。所以这一格把两边都造成「文件在、读出来是空的」。
      writeFileSync(join(t.root, ".ateam", `seen.${ME}`), "");
      const p = puller([ev("01A"), ev("01B")]);
      const out: string[] = [];
      const cur = cursorForCommand(fileCursor(ME, t.root));
      const seen = cursorForCommand(seenCursor(ME, t.root));
      expect(cur.state?.(), "送到了那一层答得出「空」").toBe("empty");
      expect(seen.state?.(), "读过了那一层也要答得出「空」——sync 读的是它").toBe("empty");
      const r = await sync(p as never, ME, cur as never, 0, (l) => out.push(l), undefined, undefined, seen as never);
      expect(p.calls, "一次拉取都没有发生").toEqual([]);
      expect(r.events).toEqual([]);
      expect(out.join("\n")).toContain(CURSOR_UNREADABLE.split("\n")[0]);
    } finally { t.cleanup(); }
  });

  it("**判据 2**：文件在而读出空 ⇒ 一条都不拉，当场说话", async () => {
    const t = tree("empty");
    try {
      const p = puller([ev("01A"), ev("01B")]);
      const out: string[] = [];
      const cur = fileCursor(ME, t.root);
      const r = await sync(p as never, ME, cur as never, 0, (l) => out.push(l));
      expect(p.calls, "**一次拉取都没有发生**：那个空的 after 根本没出门").toEqual([]);
      expect(r.events).toEqual([]);
      expect(out, "当场说话——pd 23:29 定稿那三行，照抄").toContain(CURSOR_UNREADABLE);
      // pd 点名：第一行必须**同时**说「没拉」和「游标也没有动」——只说没拉，读的人会以为自己又丢了一批
      expect(CURSOR_UNREADABLE).toContain("一条都没拉，游标也没有动");
      expect(CURSOR_UNREADABLE).toContain("过一会儿再试");
      expect(CURSOR_UNREADABLE).toContain("从哪儿重新开始得由人定");
      // 而它不许给一个此刻并不存在的入口（pd 刻意没写）
      expect(CURSOR_UNREADABLE).not.toMatch(/--(full|from-start|all)\b/);
      expect(existsSync(join(t.root, ".ateam", `cursor.${ME}`)), "也没有把那个文件删掉或写坏").toBe(true);
    } finally { t.cleanup(); }
  });

  it("**对照**：连文件都没有（刚加入）⇒ 照常从头拉，一个字都不多说", async () => {
    const t = tree("none");
    try {
      const p = puller([ev("01A")]);
      const out: string[] = [];
      await sync(p as never, ME, fileCursor(ME, t.root) as never, 0, (l) => out.push(l));
      expect(p.calls, "从头拉是对的：这个节点真的没有游标").toEqual([null]);
      expect(out.some((l) => l.includes("原因：游标读出来是空的")), "而它不该被说成「游标读出来是空的」").toBe(false);
      expect(out).not.toContain(CURSOR_UNREADABLE);
    } finally { t.cleanup(); }
  });

  it("**判据 6（要求㉞）**：若真的因空游标拉了全量，当场印 pd 定稿那两行（条数与字节用真实值）", async () => {
    // 这一格走的是「挡不住的那一侧」：一个只有 read()、没有 state() 的游标（别的客户端、老路），
    // 它把空读成 null 发了出去。两道都在是刻意的：一道挡，一道在挡不住时出声。
    const events = [ev("01A"), ev("01B"), ev("01C")];
    const p = puller(events);
    const out: string[] = [];
    const legacy = { read: () => "", write: () => {} };   // 读出空字符串：既不是 null，也不是有效位置
    await sync(p as never, ME, legacy as never, 0, (l) => out.push(l));
    const line = out.find((l) => l.startsWith("这次从头拉了全部"));
    expect(line, "那一句必须出现").toBeTruthy();
    expect(line).toBe(fullPullLine(3, JSON.stringify(events).length));
    expect(line).toContain("原因：游标读出来是空的");
    expect(line).toContain("你不是刚加入的话，这是个毛病");
  });

  it("**判据 3**：写入中途读一万次，一次都不许读到空（先写临时文件再 rename，t-254 已落）", () => {
    const t = tree("value");
    try {
      const cur = fileCursor(ME, t.root);
      const f = join(t.root, ".ateam", `cursor.${ME}`);
      for (let i = 0; i < 10_000; i++) {
        cur.write(`01M6A3Z8EMQCST1DKZ3H7AC${String(i % 10)}DK`);
        expect(readFileSync(f, "utf8").trim(), `第 ${i} 次`).not.toBe("");
      }
      expect(cur.state?.()).toBe("value");
      // 「没有游标可记」不落盘，所以它也不会制造那个 0 字节状态
      cur.write(null);
      expect(readFileSync(f, "utf8").trim()).not.toBe("");
    } finally { t.cleanup(); }
  });
});
