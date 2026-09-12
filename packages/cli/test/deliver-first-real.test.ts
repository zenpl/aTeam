/**
 * t-240 判据 2 的真路一半：**真的 `node dist/main.js sync`、真的 HTTP、真的被 SIGKILL 打死在「已拉到、尚未交付」之间。**
 *
 * 第一版这份用例验不到东西，记在这儿：我按「延时若干毫秒后杀掉」去撞那个窗口，而**注入之后它仍然全绿**——
 * 那些「没印出东西就死了」的进程，多半是**连响应都还没收到**就死了，那一态在旧代码里游标同样没动。
 * **一个在注入下也绿的用例，不是这条修法的证据。**
 *
 * 现在窗口是真的、也撞得上：这份用例**不读子进程的 stdout**，而那一批比管道缓冲区大——于是子进程卡在
 * 「写出去了、还没流出去」那一步（这正是 t-240 说的「交付」：读它的那一头还没拿到）。这时杀掉它，
 * 游标必须一个字没动。注入（推进挪回交付之前）会让它当场红。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const CLI = resolve(__dirname, "..", "dist", "main.js");
// **远大于管道缓冲区（64 KiB）**：2,000 条、每条正文上百字节 ≈ 300 KB。
// 第一版取 400 条 ≈ 60 KB，正好卡在缓冲区边上：单跑绿，整套并行跑时偶尔整批被缓冲区吃下去、子进程跑完了，
// 于是断言「游标没动」当场红。**一个会随机红的用例，教的是所有人忽略红。**
const IDS = Array.from({ length: 2000 }, (_, i) => `01M5000000000000000000${String(i).padStart(4, "0")}`);
const BATCH = IDS.map((id, i) => ({
  id, at: "2026-09-12T21:00:00.000Z", ack_by: "2026-09-12T21:30:00.000Z",
  kind: "instruction", actor: "pm", to: "dev", body: `第 ${i} 条：${"请你去做这件事".repeat(10)}`,
}));

let server: Server;
let base = "";
let served = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const after = new URL(req.url ?? "/", "http://x").searchParams.get("after");
    const rest = after ? BATCH.filter((e) => e.id > after) : BATCH;
    served += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: rest, for_me: rest, cursor: rest.length ? rest[rest.length - 1].id : after, owed: { unanswered: [], untouched: [], legacy_before_acted_rule: [] }, sha: "abc1234", deploys: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t240-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  return dir;
}
const cursorOf = (dir: string) => (existsSync(join(dir, ".ateam", "cursor.dev")) ? readFileSync(join(dir, ".ateam", "cursor.dev"), "utf8").trim() : "");
const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
const until = async (cond: () => boolean, ms: number) => {
  for (let i = 0; i < ms / 10 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  return cond();
};

describe("t-240 判据 2 · 真进程死在「已拉到、尚未交付」之间", () => {
  it("没人读它的 stdout ⇒ 它卡在交付那一步；这时打死它，游标一个字没动，重启之后那一批照旧拿得到", async () => {
    const dir = checkout();
    try {
      served = 0;
      // **故意不读 stdout**：管道填满之后，那一批就停在「写了、还没流出去」——读它的那一头一个字节都没拿到
      const child = spawn(process.execPath, [CLI, "sync"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      expect(await until(() => served > 0, 10_000), "服务端要先真的发出过那一批").toBe(true);
      await new Promise((r) => setTimeout(r, 1_000));         // 给它足够时间走完「收到、解析、写」，再确认它确实卡住了
      expect(child.exitCode, "它应该卡在交付那一步，而不是跑完了").toBeNull();
      expect(cursorOf(dir), "没交到手就不许推进").toBe("");
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
      expect(cursorOf(dir), "被打死之后仍然一个字没动").toBe("");

      // 重启（这一次有人读）：**判的是这个节点拿不拿得到**（判据 7）
      const out = await new Promise<string>((done) => {
        const c2 = spawn(process.execPath, [CLI, "sync"], { cwd: dir, env });
        let o = ""; c2.stdout.on("data", (d) => (o += d)); c2.on("exit", () => done(o));
      });
      expect(out).toContain(IDS[0]);
      expect(out).toContain("第 0 条");
      expect(cursorOf(dir), "这一次交付了，游标才动").toBe(IDS[IDS.length - 1]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("没被打死的那一次：交付了，游标才推进，第二次就真的没有新的", async () => {
    const dir = checkout();
    try {
      const run = () => new Promise<string>((done) => {
        const c = spawn(process.execPath, [CLI, "sync"], { cwd: dir, env });
        let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("exit", () => done(o));
      });
      expect(await run()).toContain(IDS[0]);
      expect(cursorOf(dir)).toBe(IDS[IDS.length - 1]);
      expect(await run()).toContain("nothing new");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});
