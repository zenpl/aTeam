/**
 * t-296 判据 1 与 2，以及 pm 08:44 的 ②：**纯本地命令不为捎这本拒绝账等服务端，而队列长度不改变它的用时。**
 *
 * 现场是我这台机器：`POST /refusals` 在生产上回 404（那一次 404 花了 58.2 秒），而队里有 3 条捎不掉的记录，
 * 于是 `ateam help` 在这棵树里量到 **47,063 毫秒**，在空目录里 **127 毫秒**——差的那 47 秒全是替一本账等一台
 * 服务。`help` 与 `fixture` 一个字都不需要服务端。
 *
 * **这份用例不碰真服务端**（判据 4 要的「红有确定的成因」就从这儿来）：它自己起一个**接下来就不回话**的
 * TCP 端口。真路径若还发请求，这几条命令会挂到超时；它不发，就在毫秒级返回。于是「快」不是碰巧，
 * 而是「一个连接都没有」——**那一条才是真正要钉的，计时只是它的影子**。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { shipsOn, LOCAL_ONLY } from "../src/main.js";
import type { Refused } from "@ateam/core";

const CLI = resolve(__dirname, "..", "dist", "main.js");

describe("t-296 判据 1 · 哪些命令该捎，是一个纯函数说的", () => {
  it("名单上那两条、以及任何印 HELP 的调用，都不捎", () => {
    for (const argv of [["help"], ["fixture"], ["fixture", "--step", "1m"], [], ["--help"], ["board", "--help"], ["task", "done", "t-1", "--help"]]) {
      expect(shipsOn(argv), JSON.stringify(argv)).toBe(false);
    }
  });

  it("真要通信的那些照旧捎——**跳过的是名单，不是这件事本身**（t-218 的账一条都不许少记）", () => {
    for (const argv of [["board"], ["sync"], ["log"], ["note", "x"], ["task", "done", "t-1"], ["tell", "pm", "x"], ["watch"]]) {
      expect(shipsOn(argv), JSON.stringify(argv)).toBe(true);
    }
  });

  it("名单就是 help 与 fixture 两条，写在一处", () => {
    expect([...LOCAL_ONLY].sort()).toEqual(["fixture", "help"]);
  });
});

/* ── 真路：一个接下来就不回话的端口 ───────────────────────────────────────── */

let server: Server;
let base = "";
let conns = 0;
const held: Socket[] = [];

beforeAll(async () => {
  // 收下连接，然后**什么都不回**——真发请求的命令会一直等到自己超时。
  server = createServer((s) => { conns++; held.push(s); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => { for (const s of held) s.destroy(); server.close(() => r()); }));

const q = (n: number): Refused[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "refused", id: `01M66K${String(i).padStart(20, "0")}`, at: new Date(Date.now() - 3600_000).toISOString(), who: "dev", rule: "usage", op: "cli note" }));

/** 一个检出，队里 n 条捎不掉的记录。n=0 时连队列文件都没有——那就是「空目录」那一头。 */
function checkout(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "t296-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  if (n) writeFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"), q(n).map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

const timed = (dir: string, ...args: string[]): Promise<{ ms: number; status: number | null; stdout: string }> =>
  new Promise((done) => {
    const t0 = Date.now();
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 25_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (err, stdout) => done({ ms: Date.now() - t0, status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout }));
  });

describe("t-296 判据 2 与 pm 08:44 ② · 队列长度不改变纯本地命令的用时", () => {
  it("**一个连接都不建**：队里 0 条、1 条、5 条，`help` 的输出逐字相同、用时同量级", async () => {
    const runs: { n: number; ms: number; out: string }[] = [];
    for (const n of [0, 1, 5]) {
      conns = 0;
      const r = await timed(checkout(n), "help");
      expect(r.status, `队里 ${n} 条时 help 的退出码`).toBe(0);
      expect(conns, `队里 ${n} 条时 help 建的连接数——这一条才是判据，用时只是它的影子`).toBe(0);
      runs.push({ n, ms: r.ms, out: r.stdout });
    }
    expect(runs[1].out, "输出逐字相同").toBe(runs[0].out);
    expect(runs[2].out).toBe(runs[0].out);
    // 同量级：以空队列那一次为尺，最多 3 倍。真发请求的那一版在这里是 20 秒以上（它会等到自己超时），
    // 所以这条断言分得开「跳过了」与「发了但碰巧快」——而上面那条连接数断言已经把它钉死了。
    const base0 = Math.max(runs[0].ms, 1);
    for (const r of runs.slice(1)) expect(r.ms, `队里 ${r.n} 条 ${r.ms}ms vs 空队列 ${base0}ms`).toBeLessThan(base0 * 3 + 500);
  }, 90_000);

  it("`fixture` 同样一个连接都不建——它整条命令连配置都不读", async () => {
    conns = 0;
    const r = await timed(checkout(5), "fixture");
    expect(r.status).toBe(0);
    expect(conns).toBe(0);
    expect(r.stdout.length, "它照旧印出那份样本").toBeGreaterThan(100);
  }, 60_000);

  it("**打错字那一次也不建连接**，而它走的是另一条路：用法错抛 UsageError，顶层 catch 从不捎（量过才这么写）", async () => {
    conns = 0;
    const r = await timed(checkout(5), "tel", "pm", "hi");
    expect(r.status, "用法错不是 0").not.toBe(0);
    expect(conns, "印用法那一次也不该为一本账去连服务端").toBe(0);
  }, 60_000);
});
