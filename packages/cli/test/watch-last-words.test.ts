/**
 * t-300 判据 4：**看守停下来时真的会说那两句——在现场走得到的那条路上。**
 *
 * pd 把我报的那条实现事实立成了判据：**一句话印在哪，由它在现场会不会被执行到决定，不由它在用例里好不好测
 * 决定。** 一句只在用例里出现的话比没有这句话更坏——**因为用例会证明它好用**，于是没有人再去现场看它到底
 * 出不出现。
 *
 * 这件事在这里是具体的：`watch` 自己有一条 `signal.aborted` 的返回路，而**生产上走不到**——`main` 的调用处
 * 不传 AbortSignal，人按 Ctrl-C 走的是 SIGINT handler。所以②那一句的归属地是 handler。
 * 这份用例因此跑**真进程 ＋ 真信号**：它只有在 handler 真的印了那一句时才绿。
 *
 * 判据 4④ 也在这里钉一遍：这几句是**尽力而为，不是契约**——`kill -9` 连 handler 都不走，所以最后一条用例
 * 断言的是「被 SIGKILL 打死时什么都没有」，而不是假装我们能留下话。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WATCH_STOPPED } from "@ateam/core";

const CLI = resolve(__dirname, "..", "dist", "main.js");
let server: Server;
let base = "";
/** 403 那一路：真属于我们的错，看守该停，而且该说出③。 */
let forbid = false;
/**
 * 服务端被问过几次。**这是「看守真的跑起来了」的信号，而不是它的输出**——
 * 第一版我等 stdout 出现东西，而空的拉取**什么都不印**（那是 pd 说的「安静＝活着且没事」，是对的），
 * 于是三条用例各等了 10 秒然后红。等对面被问到，才是等它活着。
 */
let polls = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (forbid) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "forbidden", message: "这把钥匙不是你的" })); return; }
    if (req.method === "POST") { req.on("data", () => {}); req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "01X", at: new Date().toISOString(), kind: "note", actor: "dev", created: true })); }); return; }
    // 没有新事件：看守会挂在长轮询上，正好让我有机会发信号
    polls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: [], for_me: [], cursor: null, owed: { unanswered: [], unseen: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t300-words-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  return dir;
}
const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
const until = async (cond: () => boolean, ms: number) => {
  for (let i = 0; i < ms / 20 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

/** 起一个真看守，等它真的跑起来（第一次长轮询发出去了）。 */
function start(dir: string): { child: ChildProcess; out: () => string } {
  let out = "";
  const child = spawn(process.execPath, [CLI, "watch", "--interval", "60s"], { cwd: dir, env });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  return { child, out: () => out };
}

describe("t-300 判据 4 · 真进程、真信号", () => {
  it("②被中断：SIGINT ⇒ stdout 上就是 pd 定稿那一句（它只能由 handler 印出来）", async () => {
    const dir = checkout();
    const before = polls;
    const { child, out } = start(dir);
    try {
      expect(await until(() => polls > before || child.exitCode !== null, 15_000), "看守要先真的跑起来（等服务端被问到，不是等它印东西）").toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      child.kill("SIGINT");
      await new Promise((r) => child.on("exit", r));
      expect(out(), "pd 10:0x 的定稿，逐字").toContain(WATCH_STOPPED.interrupted("SIGINT"));
      expect(out()).toContain("看守被中断停了（SIGINT）。");
      expect(out(), "②要劝重挂——人或宿主停的，重挂之前先问是不是故意的").toContain("重挂：ateam watch");
      expect(out(), "第二句是必须的：停了是状态，没人叫你才是后果").toContain("从这一行之后没有人会叫醒你");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("②走 stdout，不是只走 stderr——只盯管道的看守读不到 stderr（判据 4③）", async () => {
    const dir = checkout();
    const before = polls;
    let stdout = "";
    const child = spawn(process.execPath, [CLI, "watch", "--interval", "60s"], { cwd: dir, env });
    child.stdout.on("data", (d) => (stdout += d));
    try {
      expect(await until(() => polls > before || child.exitCode !== null, 15_000)).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      child.kill("SIGTERM");
      await new Promise((r) => child.on("exit", r));
      expect(stdout, "SIGTERM 同样说，而且在 stdout 上").toContain("看守被中断停了（SIGTERM）。");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("③出错：真属于我们的那一类（403）⇒ 看守停下来并说出③，而且走 stdout", async () => {
    const dir = checkout();
    try {
      forbid = true;
      const r = await new Promise<{ code: number | null; out: string }>((done) => {
        let out = "";
        const c = spawn(process.execPath, [CLI, "watch", "--interval", "60s"], { cwd: dir, env });
        c.stdout.on("data", (d) => (out += d));
        c.on("exit", (code) => done({ code, out }));
      });
      expect(r.code, "403 是我们的错，看守该停").not.toBe(0);
      expect(r.out, "③在 stdout 上").toContain("看守出错停了：");
      expect(r.out).toContain("从这一行之后没有人会叫醒你");
      expect(r.out).toContain("重挂：ateam watch");
    } finally { forbid = false; rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("判据 4④：SIGKILL 什么都留不下——**所以这几句是尽力而为，不是契约**", async () => {
    const dir = checkout();
    const before = polls;
    const { child, out } = start(dir);
    try {
      expect(await until(() => polls > before || child.exitCode !== null, 15_000)).toBe(true);
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
      expect(out(), "一句临终话都没有——判一个节点在不在听，只能看牌桌按拉取算的在场").not.toContain("看守被中断停了");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  it("①的那一句不劝重挂（pd「二」：它不是故障，做完了被要求的事）", () => {
    expect(WATCH_STOPPED.once()).toBe("看守按 --once 停了：你等的那条指令到了。从这一行之后没有人会叫醒你——新指令要等你下一次 sync 才看得见。");
    expect(WATCH_STOPPED.once(), "不劝重挂").not.toContain("重挂");
    expect(WATCH_STOPPED.interrupted("SIGINT"), "另两种劝").toContain("重挂");
    expect(WATCH_STOPPED.failed("x"), "另两种劝").toContain("重挂");
  });

  it("主语给一次，不给两次，也不给零次（pd 立的通则）", () => {
    for (const line of [WATCH_STOPPED.once(), WATCH_STOPPED.interrupted("SIGINT"), WATCH_STOPPED.failed("x")]) {
      expect(line.startsWith("看守"), `有主语：${line}`).toBe(true);
      expect(line.split("停了").length - 1, `只说一次停：${line}`).toBe(1);
      expect(line, "不许出现模板前缀再接一截").not.toContain("看守停了：");
    }
  });
});
