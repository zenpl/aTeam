/**
 * t-293 判据 8②：**凡命令以非零码结束，游标一律不动。**
 *
 * qa 06:33 那一格的后半句：被改写的游标之后，**那次命令随后崩了，而游标已经改掉**——一次失败移动了读位置。
 * 两半分开修：前半句是「改写成谁的 id」（判据 8①，按服务器隔离），这一半是「失败了还算不算移动」。
 *
 * 失败发生在**交付之后**的那一种，才是这条判据真正要判的——交付之前失败，t-240 已经保住了。所以这里用的是
 * 一条真会这样的命令：`ateam init` 先 `sync`（那一批真的印出来了），再取角色手册；手册那一路 500 ⇒ 整条命令
 * 非零结束。此时位置必须一个字节没动，而**那一批也不许丢**——下一次跑它照旧拿得到（这正是 t-240 立的方向：
 * 重放是安全的那一头，丢失不是）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serverKey, deferredCursor } from "../src/main.js";
import type { CursorStore } from "../src/loop.js";

const CLI = resolve(__dirname, "..", "dist", "main.js");
const ID = (n: number) => `01M6100000000000000000${String(n).padStart(4, "0")}`;
const LOG = Array.from({ length: 5 }, (_, i) => ({ id: ID(i), at: "2026-10-30T06:00:00.000Z", kind: "note", actor: "pm", body: `第 ${i} 条` }));

/** 手册那一路回 500，于是 init 在 sync 交付之后失败。 */
let manualBreaks = true;
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/events" && req.method === "GET") {
      const after = url.searchParams.get("after");
      const rest = after ? LOG.filter((e) => e.id > after) : LOG;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ shape: 2, events: rest, for_me: [], cursor: rest.length ? rest[rest.length - 1].id : after, owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [] }));
      return;
    }
    if (url.pathname.startsWith("/manual/")) {
      if (manualBreaks) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "boom" })); return; }
      res.writeHead(200, { "content-type": "text/markdown" }); res.end("# 手册\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
const run = (dir: string, ...argv: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
  const c = spawn(process.execPath, [CLI, ...argv], { cwd: dir, env });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (out += d));
  c.on("exit", (code) => done({ code, out }));
});
const cursorOf = (dir: string) => {
  const f = join(dir, ".ateam", `cursor.dev.${serverKey(base)}`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
};

/** 一个只在内存里的 inner，用来单独判 deferredCursor 自己的三条。 */
const mem = (init: string | null) => {
  const s = { value: init, writes: 0, read: () => s.value, write: (c: string | null) => { s.value = c; s.writes += 1; } };
  return s as CursorStore & { value: string | null; writes: number };
};

describe("t-293 判据 8② · 失败的命令不许移动读位置", () => {
  it("真命令：init 的 sync 交付了那一批，之后手册 500 ⇒ 非零退出、游标一个字节没动、那一批下次照旧拿得到", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t293-fail-"));
    try {
      manualBreaks = true;
      const bad = await run(dir, "init", "--me", "dev", "--url", base, "--token", "k");
      expect(bad.code, "手册 500 ⇒ 整条命令非零").not.toBe(0);
      expect(bad.out, "那一批真的交付了（印出来了）").toContain(ID(0));
      expect(cursorOf(dir), "失败的命令不许移动读位置").toBe("");

      manualBreaks = false;
      const good = await run(dir, "sync");
      expect(good.code).toBe(0);
      expect(good.out, "那一批没丢——重放是安全的那一头").toContain(ID(0));
      expect(cursorOf(dir), "这一次成了，位置才落盘").toBe(ID(LOG.length - 1));
    } finally { manualBreaks = false; rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("deferredCursor：写只进内存，commit 才落到里层", () => {
    const inner = mem("01M10000000000000000000001");
    const d = deferredCursor(inner);
    d.write("01M20000000000000000000002");
    expect(inner.value, "还没 commit，里层一个字没动").toBe("01M10000000000000000000001");
    expect(d.read(), "同一个进程里读得见还没落盘的那个值").toBe("01M20000000000000000000002");
    d.commit();
    expect(inner.value).toBe("01M20000000000000000000002");
  });

  it("commit 时拿里层的值再比一次单调：两个进程抢同一个文件，旧值仍然盖不掉新值（t-049）", () => {
    const inner = mem("01M10000000000000000000001");
    const d = deferredCursor(inner);
    d.write("01M20000000000000000000002");
    inner.value = "01M90000000000000000000009";   // 另一个进程在这中间写了一个更新的
    d.commit();
    expect(inner.value, "旧值不许盖掉新值").toBe("01M90000000000000000000009");
  });

  it("没 commit 就什么也没发生——这正是「非零码一个位置都不提交」靠的那一条", () => {
    const inner = mem(null);
    const d = deferredCursor(inner);
    d.write("01M20000000000000000000002");
    expect([inner.value, inner.writes]).toEqual([null, 0]);
  });

  it("commit 两次只落一次：第二次没有待写的东西", () => {
    const inner = mem(null);
    const d = deferredCursor(inner);
    d.write("01M20000000000000000000002");
    d.commit();
    d.commit();
    expect(inner.writes).toBe(1);
  });
});
