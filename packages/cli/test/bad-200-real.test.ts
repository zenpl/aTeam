/**
 * t-293 判据 3、4、5：**一次「200 带解不出的正文」到底对这台机器做了什么——用真进程、真 HTTP 判。**
 *
 * qa 量出的那条链是自我放大的：解不出的回包被兜底成 `{ error: statusText }` ⇒ 它冒充一份 `PullResult`
 * ⇒ `cursor` 是 `undefined`、走过两道只认 `null` 的闸 ⇒ 游标文件被写空 ⇒ 下一轮从第 1 条重放 ⇒ 全量重放让
 * 服务更慢 ⇒ 更容易再解不出。**服务端越慢越容易触发，而触发之后它让服务端更慢。**
 *
 * 三处修法早已在这一支上（判据 1、2 因此是「已成立」而不是「本件新写」，证据里逐条点名）：
 * `client.ts` 解不出就抛 `BadResponse`（t-225）、`advance` 只收 ULID 或 null（t-225）、
 * `cursor.write` 空值根本不落盘（t-254）。**而它们此前只被单元用例钉住过**：没有任何一条用例跑过真的
 * `node dist/main.js`，于是「退出码是几」「游标文件那几个字节动没动」「看守在管道里看得见什么」三件
 * 一件都没被判过——那三件恰恰是这条链在现场被量到的样子。这一份补的就是这一截。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const CLI = resolve(__dirname, "..", "dist", "main.js");
const ID = (n: number) => `01M6000000000000000000${String(n).padStart(4, "0")}`;
/** 十条事件。游标预置在第 7 条，所以「从原位继续」是 3 条，「从第 1 条重放」是 10 条——两个数分得开。 */
const LOG = Array.from({ length: 10 }, (_, i) => ({
  id: ID(i), at: "2026-10-30T06:00:00.000Z", kind: "note", actor: "pm", body: `第 ${i} 条`,
}));
const AT = ID(6);
const REST = LOG.filter((e) => e.id > AT);

/**
 * **按地址下毒，不按次数下毒。** 第一版是「下一次请求坏掉」，而这条命令行在走到自己那一次请求之前还会
 * 发别的（t-211 自报 sha、t-218 捎拒绝账）——那一版的毒会被随便哪一个先到的请求吃掉，用例就随机绿。
 * 一个会随机绿的用例，判不了任何东西。
 */
let poisonPath: string | null = null;
/** 每一次 GET /events 带上来的 after，按顺序记下来——判据 4 判的就是这一串。 */
let asked: (string | null)[] = [];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (poisonPath !== null && url.pathname === poisonPath) {
      // 网关塞回来的那种：200、content-type 说是 JSON、正文是一张 HTML。**正文里故意带 OK**，
      // 这样「消息说出了发生什么」与「消息只是把 OK 转述一遍」分得开。
      res.writeHead(200, { "content-type": "application/json" });
      res.end("<html><body>200 OK</body></html>");
      return;
    }
    if (url.pathname === "/events" && req.method === "GET") {
      const after = url.searchParams.get("after");
      asked.push(after);
      const rest = after ? LOG.filter((e) => e.id > after) : LOG;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        shape: 2, events: rest, for_me: [], cursor: rest.length ? rest[rest.length - 1].id : after,
        owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [],
      }));
      return;
    }
    if (url.pathname === "/board") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ shape: 2, focus: null, tasks: {}, seams: [], readings: [], presence: [], needs_human: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t293-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  // 两处都预置：`sync` 从 seen 往下拉（t-274），cursor 是「送到了」那一处。
  writeFileSync(join(dir, ".ateam", "cursor.dev"), AT);
  writeFileSync(join(dir, ".ateam", "seen.dev"), AT);
  return dir;
}
const bytesOf = (dir: string, f: string) => (existsSync(join(dir, ".ateam", f)) ? readFileSync(join(dir, ".ateam", f)) : null);
const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
type Run = { code: number | null; out: string; err: string };
const run = (dir: string, ...argv: string[]) => new Promise<Run>((done) => {
  const c = spawn(process.execPath, [CLI, ...argv], { cwd: dir, env });
  let out = "", err = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (err += d));
  c.on("exit", (code) => done({ code, out, err }));
});

describe("t-293 · 解不出的 200：真进程、真 HTTP", () => {
  it("判据 3：退出码非零、游标文件一个字节没动、消息说得出「正文不是可解析的 JSON」而不是 OK", async () => {
    const dir = checkout();
    try {
      const before = { cursor: bytesOf(dir, "cursor.dev"), seen: bytesOf(dir, "seen.dev") };
      poisonPath = "/events";
      const r = await run(dir, "sync");
      expect(r.code, "非零——一次失败不许装成成功").not.toBe(0);
      expect(bytesOf(dir, "cursor.dev"), "游标文件逐字节未变").toEqual(before.cursor);
      expect(bytesOf(dir, "seen.dev"), "seen 也逐字节未变").toEqual(before.seen);
      const said = `${r.out}\n${r.err}`;
      expect(said, "说得出发生了什么").toContain("正文不是可解析的 JSON");
      expect(r.out, "死因也要走 stdout——只盯管道的看守否则看不见任何东西（t-225 判据 3）").toContain("正文不是可解析的 JSON");
      expect(said, "不许把一次失败转述成 OK").not.toMatch(/"error"\s*:\s*"OK"/);
    } finally { poisonPath = null; rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("判据 4：正反馈断掉——坏响应之后下一轮仍从原游标继续，不是从第 1 条重放（按条数判）", async () => {
    const dir = checkout();
    try {
      asked = [];
      poisonPath = "/events";
      expect((await run(dir, "sync")).code, "第一次该失败").not.toBe(0);
      poisonPath = null;
      const good = await run(dir, "sync");
      expect(good.code, "这一次该成").toBe(0);
      expect(asked, "它要的是原来那个位置，不是从头").toEqual([AT]);
      // 条数：从原位继续是 REST.length 条；从第 1 条重放会是 LOG.length 条。两个数不相等，所以这一条判得出。
      expect(REST.length).not.toBe(LOG.length);
      const shown = LOG.filter((e) => good.out.includes(e.id)).length;
      expect(shown, `从原位继续 ⇒ ${REST.length} 条；重放 ⇒ ${LOG.length} 条`).toBe(REST.length);
    } finally { poisonPath = null; rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("判据 5：同一个坏响应下，别的命令也说得出发生了什么，不抛一条什么都不说明的 TypeError", async () => {
    const dir = checkout();
    try {
      for (const [argv, path] of [[["board", "--full"], "/board"], [["board"], "/board"], [["log"], "/log"]] as [string[], string][]) {
        poisonPath = path;
        const r = await run(dir, ...argv);
        const said = `${r.out}\n${r.err}`;
        expect(r.code, `${argv.join(" ")} 要非零`).not.toBe(0);
        expect(said, `${argv.join(" ")} 要说出发生了什么`).toContain("正文不是可解析的 JSON");
        expect(said, `${argv.join(" ")} 不许是 Cannot read properties of undefined`).not.toContain("Cannot read properties of undefined");
        expect(said, `${argv.join(" ")} 不许是一条裸 TypeError`).not.toContain("TypeError");
      }
    } finally { poisonPath = null; rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
