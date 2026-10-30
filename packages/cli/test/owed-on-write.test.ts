/**
 * t-290 判据 4 的位置那一半（pd 07:57，pm 08:05 写进判据）：**对一个不拉的节点，唯一能说话的地方是它自己
 * 写入的回包。**
 *
 * 它不拉，所以 `sync` 的出口对它永远不存在；而它在写，所以每一次写都是一次可用的信道。这正是外部那份 P0
 * 复盘「如果只能做三件」里的第一件。
 *
 * **到本件之前这条路是断的，而断点不在服务端**：服务端从 t-227 起就在回包里送 `for_me` 与 `owed`，而
 * `client.emit` 的返回类型写的是 `Event`——**那两样在类型层面就被扔掉了，一次都没有到过任何调用方手里。**
 * 所以这份用例跑的是真进程、真 HTTP：它判的不是「服务端送了没有」（那是 post-reply.test.ts 的事），
 * 而是**那句话有没有真的到那个节点的屏幕上**。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const CLI = resolve(__dirname, "..", "dist", "main.js");
const ID = (n: number) => `01M6300000000000000000${String(n).padStart(4, "0")}`;
/** 三条点名找 dev 的指令，最久那条发出来已经 25 分钟——pd 用的就是这个样本（field-report F1／F2 的真数）。 */
const SENT = new Date(Date.now() - 25 * 60_000).toISOString();
const OWED = {
  unanswered: [],
  unseen: [0, 1, 2].map((i) => ({ instruction: ID(i), from: "pm", body: `第 ${i} 条`, sent: i === 0 ? SENT : new Date(Date.now() - 60_000).toISOString() })),
  untouched: [],
  legacy_before_acted_rule_count: 0,
};
let server: Server;
let base = "";
/** 旧服务端那一路：回包里根本没有 owed。新命令行对着它不许崩（t-080）。 */
let oldServer = false;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.method === "POST") {
      await new Promise<void>((r) => { req.on("data", () => {}); req.on("end", () => r()); });
      res.writeHead(201, { "content-type": "application/json" });
      const ev = { id: ID(9), at: new Date().toISOString(), kind: "note", actor: "dev", body: "我在写，但我从不拉" };
      res.end(JSON.stringify(oldServer ? ev : { ...ev, created: true, for_me: [], owed: OWED }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: [], for_me: [], cursor: null, owed: OWED, sha: "abc1234", deploys: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t290-write-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  return dir;
}
const run = (dir: string, ...argv: string[]) => new Promise<{ code: number | null; out: string; err: string }>((done) => {
  const c = spawn(process.execPath, [CLI, ...argv], { cwd: dir, env });
  let out = "", err = "";
  c.stdout.on("data", (d) => (out += d));
  c.stderr.on("data", (d) => (err += d));
  c.on("exit", (code) => done({ code, out, err }));
});

describe("t-290 判据 4 · 那句话的归属地是写入的回包", () => {
  it("一个从不拉的节点写一条 note ⇒ 它自己的屏幕上就看得见那句话，pd 的定稿逐字", async () => {
    const dir = checkout();
    try {
      const r = await run(dir, "note", "我在写，但我从不拉");
      expect(r.code).toBe(0);
      expect(r.out, "pd 07:57 的定稿，逐字").toContain("有 3 条指令在等你，你还没拉过它们；最久的一条等了 25 分钟。跑 ateam sync 就拿得到。");
      expect(r.out, "① 主语是「你还没拉」，不是「还没送到你眼前」").not.toContain("还没送到你眼前");
      expect(r.out, "③ 动作写成那条命令本身").toContain("ateam sync");
      expect(r.out, "去掉的那半句不许回来").not.toContain("你一直在写");
      // 它确实一次都没拉过：游标文件不存在
      expect(existsSync(join(dir, ".ateam", "cursor.dev")), "它没拉过").toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("② 必须带最久那条的时长，用的是同一把梯子", async () => {
    const dir = checkout();
    try {
      const r = await run(dir, "note", "再写一条");
      expect(r.out).toMatch(/最久的一条等了 (不到 1 分钟|\d+ (分钟|小时|天))。/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("没有账要还的那一次，写入的回执不该多出一行", async () => {
    const dir = checkout();
    try {
      const saved = OWED.unseen;
      (OWED as { unseen: unknown[] }).unseen = [];
      const r = await run(dir, "note", "我不欠什么");
      (OWED as { unseen: unknown[] }).unseen = saved;
      expect(r.out.trim().split("\n"), "只有那一行回执").toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("对着一台还没上这一版的服务端（回包里没有 owed）不许崩——t-080 那条规矩", async () => {
    const dir = checkout();
    try {
      oldServer = true;
      const r = await run(dir, "note", "对着旧服务端写一条");
      oldServer = false;
      expect(r.code, "照旧退 0").toBe(0);
      expect(`${r.out}\n${r.err}`, "不许是一条读 undefined 的崩溃").not.toContain("Cannot read properties of undefined");
      expect(r.out, "一句都不说，而不是说错").not.toContain("在等你");
    } finally { oldServer = false; rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
