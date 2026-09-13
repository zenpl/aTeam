/**
 * t-245：**`sync --quiet` 会把那一批吃掉，而 `--help` 里 `--quiet` 一个字都没有。**
 *
 * 它的原意是心跳：拉一次、不吵人、让服务看见这个节点还在。可它拉到的那一批没有任何人看过，
 * 游标照样往前走——**那一批对这个节点永久消失，之后每次 sync 都诚实地说「nothing new」。**
 * 与 t-240 同族、另一条路：那一件修的是「印之前死掉」，这一条是**从一开始就没人打算印**。
 *
 * 这份用例走真路：真的 `node dist/main.js sync --quiet`、真的 HTTP、真的 `.ateam/` 文件。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { QUIET_HELP, UNSEEN_HEAD } from "@ateam/core";

const CLI = resolve(__dirname, "..", "dist", "main.js");
const IDS = Array.from({ length: 3 }, (_, i) => `01M5000000000000000000000${i}`);
const BATCH = IDS.map((id, i) => ({
  id, at: "2026-09-12T21:00:00.000Z", ack_by: "2026-09-13T21:00:00.000Z",
  kind: "instruction", actor: "pm", to: "dev", body: `第 ${i} 条：做一件事`,
}));

let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    const after = new URL(req.url ?? "/", "http://x").searchParams.get("after");
    const rest = after ? BATCH.filter((e) => e.id > after) : BATCH;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: rest, for_me: rest, cursor: rest.length ? rest[rest.length - 1].id : after, owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t245-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  return dir;
}
const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
const run = (dir: string, ...args: string[]): Promise<string> =>
  new Promise((done) => execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env }, (_e, out) => done(out)));
const unseen = (dir: string) => join(dir, ".ateam", "unseen.dev.jsonl");

describe("t-245 · --quiet 拉到的那一批不再消失", () => {
  it("心跳拉一次（不印）⇒ 那一批攒在本地；下一次真去看时先印它，印完才清", async () => {
    const dir = checkout();
    try {
      const quiet = await run(dir, "sync", "--quiet");
      expect(quiet.trim(), "--quiet 就是不吵人").toBe("");
      expect(existsSync(unseen(dir)), "**但它没有消失**").toBe(true);
      expect(readFileSync(unseen(dir), "utf8")).toContain("第 0 条");

      const out = await run(dir, "sync");
      expect(out).toContain(UNSEEN_HEAD(3));
      for (const id of IDS) expect(out, "三条一条不少").toContain(id);
      expect(existsSync(unseen(dir)), "印完了才清").toBe(false);

      const again = await run(dir, "sync");
      expect(again, "清干净之后不再重复").not.toContain(UNSEEN_HEAD(3));
      expect(again).toContain("nothing new");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("连着几次心跳：攒在一起，一次看完", async () => {
    const dir = checkout();
    try {
      await run(dir, "sync", "--quiet");
      await run(dir, "sync", "--quiet");          // 第二次没有新的，攒的还是那三条
      const out = await run(dir, "sync");
      expect(out).toContain("第 2 条");
      expect(out.match(/第 2 条/g), "不该攒出两份").toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("判据 2：`--quiet` 在 --help 里说得出它会怎样", async () => {
    const dir = checkout();
    try {
      const out = await run(dir, "help");
      expect(out).toContain("--quiet");
      expect(out).toContain(QUIET_HELP);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
});

/**
 * qa 22:21 判 fail 时用的那具量具，收进用例：**它不注入代码，只让那次写真的失败**（用一个同名目录占住文件名
 * ⇒ EISDIR，替「磁盘满」）。第一版在这里退 0、一声不吭，游标照走，那一批永久消失——**我刚在 t-240 修过同一
 * 形状的东西，转手又在自己的修法里做了一遍**：交付与推进之间有缝，缝里丢的东西不留痕。
 */
describe("t-245 · 那一叠写不下去时，游标不许动", () => {
  it("落盘失败 ⇒ 这条命令掀翻、游标一个字没动，下一次照样拿得到那一批", async () => {
    const dir = checkout();
    try {
      mkdirSync(join(dir, ".ateam", "unseen.dev.jsonl"));   // 用目录占住那个文件名：写它必然失败
      const out = await run(dir, "sync", "--quiet");
      const cursor = join(dir, ".ateam", "cursor.dev");
      expect(existsSync(cursor) && readFileSync(cursor, "utf8").trim(), "没落盘就不许推进").toBeFalsy();
      expect(out, "而且不许一声不吭地成功").not.toContain("nothing new");

      rmSync(join(dir, ".ateam", "unseen.dev.jsonl"), { recursive: true, force: true });
      const again = await run(dir, "sync");
      for (const id of IDS) expect(again, "那一批还在").toContain(id);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
