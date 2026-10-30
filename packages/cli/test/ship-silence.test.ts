/**
 * t-284：**捎不上去是静默的——单次的正确处置被当成了长期的正确处置。**
 *
 * t-218 的 `catch` 没写错：捎遥测不该掀翻用户正在跑的命令。缺的是它与「已经六天没捎成」之间的那个计数。
 * 下半段走真路（真 `node dist/main.js`、真退出码、真队列文件、真一次 HTTP），照 t-218 那份的体例；
 * 上半段是纯函数，把门槛逐条钉住。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterShip, readShipState, shipSilenceNotice, markSaid, shipStateFile,
  SHIP_FAIL_STREAK, SHIP_STUCK_MS, type ShipState,
} from "../src/refusalqueue.js";
import type { Refused } from "@ateam/core";

const NOW = new Date(Date.parse("2026-09-19T04:00:00Z"));
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const DAY = SHIP_STUCK_MS;
const q = (n: number, at: string): Refused[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "refused", id: `01M2VW${String(i).padStart(20, "0")}`, at, who: "dev", rule: "usage", op: "cli note" }));
const fresh = readShipState(null);
const streak = (kind: "unreachable" | "not-counted", n: number): ShipState => {
  let st = fresh;
  for (let i = 0; i < n; i++) st = afterShip(st, kind, NOW);
  return st;
};

describe("t-284 判据 3 · 出声的门槛，三个条件都要", () => {
  it("连续失败不够 ⇒ 不说（一次捎不上去仍然是静默的，t-218 那句话在这里原样成立）", () => {
    for (let n = 0; n < SHIP_FAIL_STREAK; n++) {
      expect(shipSilenceNotice(streak("unreachable", n), q(3, ago(6 * DAY)), NOW), `连续 ${n} 次`).toBeNull();
    }
    expect(shipSilenceNotice(streak("unreachable", SHIP_FAIL_STREAK), q(3, ago(6 * DAY)), NOW)).not.toBeNull();
  });

  it("队里最早那条还不到一天 ⇒ 不说（此刻正好没网，不是「长期」）", () => {
    expect(shipSilenceNotice(streak("unreachable", 9), q(3, ago(DAY - 1000)), NOW)).toBeNull();
    expect(shipSilenceNotice(streak("unreachable", 9), q(3, ago(DAY + 1000)), NOW)).not.toBeNull();
  });

  it("**说过一次就一天之内不再说**——否则前两个条件一旦成立就是每条命令都喊", () => {
    const said = markSaid(streak("unreachable", 9), new Date(NOW.getTime() - DAY / 2));
    expect(shipSilenceNotice(said, q(3, ago(6 * DAY)), NOW)).toBeNull();
    const old = markSaid(streak("unreachable", 9), new Date(NOW.getTime() - DAY - 1000));
    expect(shipSilenceNotice(old, q(3, ago(6 * DAY)), NOW)).not.toBeNull();
  });

  it("队空就没有这回事", () => {
    expect(shipSilenceNotice(streak("unreachable", 99), [], NOW)).toBeNull();
  });

  it("那句话里带得出条数与天数——判据 3 要的「可量」，说给人的也是这两个数", () => {
    const line = shipSilenceNotice(streak("unreachable", 4), q(3, ago(6 * DAY + 3600_000)), NOW)!;
    expect(line).toContain("3 条");
    expect(line).toContain("6 天");
    expect(line).toContain("连续 4 次");
    expect(line.split("\n"), "一行").toHaveLength(1);
  });
});

describe("t-284 判据 5 · 两种失败分开数、分开说", () => {
  it("两句话不一样：一句说「请求没到服务端」，一句说「服务端收下了却没有这本账」", () => {
    const a = shipSilenceNotice(streak("unreachable", 3), q(2, ago(2 * DAY)), NOW)!;
    const b = shipSilenceNotice(streak("not-counted", 3), q(2, ago(2 * DAY)), NOW)!;
    // t-296 改了这两句的字，而**这条用例要钉的「两种失败分开说」一个字没变**。改的是：
    // ① 原句里「请求没到服务**或那台服务没有这条路**」那半句搬进了新的第三格（404 自己一格）——
    //    pd 14:28 定稿的理由是我写的那句：两件事要人做的事相反，合着说等于让读的人分不出该等还是该找人。
    // ② 「counted: false」按 pd 第 ⑮ 条改成「回包里的 counted 是 false」：那个词读它的节点在回包里看得见，
    //    加三个字把一个不透明的词变成一条可查的指路。
    // 断言跟着真句子改，不是反过来；三格互不相同那一条在 ship-backoff.test.ts 里另有一条专钉。
    expect(a).toContain("请求没到服务端");
    expect(b).toContain("回包里的 counted 是 false");
    expect(a).not.toBe(b);
  });

  it("**不许互相顶数**：两种各攒两次，谁都不到门槛，就都不说", () => {
    let st = fresh;
    for (const k of ["unreachable", "not-counted", "unreachable", "not-counted"] as const) st = afterShip(st, k, NOW);
    // 这一条第一次跑就红了，红得对：我写的断言是「两边各攒到 1」，而真规则更严——**最后一次是哪一种，
    // 只有那一种在串上**，另一种当场归零。交替四次之后 unreachable 是 0 不是 1。断言改成真规则，不是反过来。
    expect(st.unreachable.n, "最后一次是 not-counted，unreachable 那串已经断了").toBe(0);
    expect(st.notCounted.n, "只有最后这一种还在串上").toBe(1);
    expect(shipSilenceNotice(st, q(2, ago(6 * DAY)), NOW)).toBeNull();
  });

  it("捎成了 ⇒ 两串一起归零；`since` 记住的是这一串的头，不是最近一次", () => {
    const st = streak("unreachable", 3);
    expect(st.unreachable.since).toBe(NOW.toISOString());
    const later = afterShip(st, "unreachable", new Date(NOW.getTime() + 60_000));
    expect(later.unreachable, "第 4 次仍是同一串").toEqual({ n: 4, since: NOW.toISOString() });
    expect(afterShip(later, "ok", NOW).unreachable).toEqual({ n: 0, since: null });
  });

  it("状态文件读坏了按「没失败过」，不按「说不出」——这本账只决定要不要多说一句话", () => {
    for (const bad of ["{", "null", "[]", '{"unreachable":{"n":"三"}}', '{"unreachable":{"n":5}}']) {
      expect(readShipState(bad).unreachable, bad).toEqual({ n: 0, since: null });
    }
    expect(readShipState('{"unreachable":{"n":5,"since":"不是时间"}}').unreachable, "缺一半就不算一串").toEqual({ n: 0, since: null });
  });
});

/* ── 下半段：真路 ───────────────────────────────────────────────────────────── */

const CLI = resolve(__dirname, "..", "dist", "main.js");
let server: Server;
let base = "";
/** 这台服务怎么对 POST /refusals：404（没有这条路，今晚生产那一族）／counted:false／正常记下。 */
/**
 * t-296 多了 \`dead\`：**连接当场断掉**（请求没到服务端）。原来这一段用 404 当「捎不上去」的现场，而 404
 * 此刻归第三格、第一条命令就出声，会把「连续 3 次才说」这条判据测成反的。\`dead\` 只断 \`/refusals\` 这一条路，
 * 其余照旧 200——这样跑的那条命令自己是成功的（退出码 0），只有顺带捎的那一下失败，正是真现场的形状。
 */
let mode: "no-route" | "not-counted" | "ok" | "dead" = "no-route";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/refusals") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (mode === "dead") { req.socket.destroy(); return; }
        if (mode === "no-route") { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
        const rs = (JSON.parse(body) as { refusals: Refused[] }).refusals;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(mode === "ok" ? { recorded: rs.map((r) => r.id), counted: true } : { recorded: [], counted: false }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/**
 * 一个装着「六天前就卡在这儿」的队列的检出——**日期是造的，形状是真的**（逐字照真文件那几行）。
 *
 * t-296 之后多了两样，各有理由：
 * · `url`：可以指到一个**没人在听**的端口。404 从此是另一族（`no-route`），而这一段原本要钉的
 *   「连续 3 次才出声」说的是**可能自己好**的那一族，所以它要一条真的连不上的路，不是一条回 404 的路。
 * · `st`：预置状态文件。退避之后「连跑三条命令」不再等于「连续失败三次」——第 2 次失败就要等 1 分钟，
 *   第 3 条命令会跳过不发。预置状态与「真的等过了」是同一件事：那个文件就是这台机器记住这件事的唯一地方。
 *   **我没有为了让用例好跑去抬退避或绕过它**，那会把判据本身测没了。
 */
function stuck(days = 6, opts: { url?: string; st?: ShipState } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "t284-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: opts.url ?? base, token: "k" }));
  const at = new Date(Date.now() - days * DAY).toISOString();
  writeFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"),
    q(3, at).map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (opts.st) writeFileSync(shipStateFile(dir, "dev"), JSON.stringify(opts.st));
  return dir;
}
const run = (dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (err, stdout, stderr) => done({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });

describe("t-284 判据 4 · 真路：第三条命令出声，而它不掀翻任何东西", () => {
  it("头两条一声不吭，第三条说了；退出码与 stdout 一个字不变", async () => {
    // t-296 之后这条用例换了两处，判的那件事没换：
    // ① `/refusals` 这一条路换成「连接当场断掉」（mode = "dead"）。原来用的是回 404 的那台——而 404
    //    此刻归第三格、**第一条命令就出声**，那会把「连续 3 次才说」这条判据测成反的。这一族要的是
    //    「请求没到服务端」。只断这一条路，所以跑的那条命令自己照旧成功（退出码 0）。
    // ② 预置 nextTryAt = null，让这三条命令真的各发一次。退避是 t-296 新加的，而本条判的是出声门槛；
    //    两件事各有各的用例（退避那条在 ship-backoff.test.ts），不许一条用例同时数两样。
    mode = "dead";
    const dir = stuck(6);
    const runs: { status: number | null; stdout: string; stderr: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const st = readShipState(existsSync(shipStateFile(dir, "dev")) ? readFileSync(shipStateFile(dir, "dev"), "utf8") : null);
      writeFileSync(shipStateFile(dir, "dev"), JSON.stringify({ ...st, nextTryAt: null }));
      runs.push(await run(dir, "log"));
    }
    const [a, b, c] = runs;
    for (const [i, r] of runs.entries()) {
      expect(r.status, `第 ${i + 1} 条命令的退出码`).toBe(0);
      expect(r.stdout, `第 ${i + 1} 条命令的 stdout`).toBe(a.stdout);
    }
    expect(a.stderr).not.toContain("捎不上去");
    expect(b.stderr).not.toContain("捎不上去");
    expect(c.stderr, "第三条：连续 3 次、最早一条 6 天、今天没说过").toContain("捎不上去");
    expect(c.stderr).toContain("6 天");
    const st3 = readShipState(readFileSync(shipStateFile(dir, "dev"), "utf8"));
    writeFileSync(shipStateFile(dir, "dev"), JSON.stringify({ ...st3, nextTryAt: null }));
    const d = await run(dir, "log");
    expect(d.stderr, "说过了就一天之内不再说").not.toContain("捎不上去");
    expect(readShipState(readFileSync(shipStateFile(dir, "dev"), "utf8")).unreachable.n).toBe(4);
  }, 90_000);

  it("counted:false 那一族说的是另一句，而队照旧一条不划（t-218 那条本件不碰）", async () => {
    mode = "not-counted";
    // 预置「已经连续两次」：退避之后第 3 条命令本来会跳过不发，而本条判的是第 3 次失败说什么。
    const seed: ShipState = { unreachable: { n: 0, since: null }, notCounted: { n: SHIP_FAIL_STREAK - 1, since: new Date(Date.now() - 60_000).toISOString() }, noRoute: { n: 0, since: null }, saidAt: null, nextTryAt: null };
    const dir = stuck(6, { st: seed });
    const last = await run(dir, "log");
    expect(last.status).toBe(0);
    expect(last.stderr).toContain("回包里的 counted 是 false");
    expect(readShipState(readFileSync(shipStateFile(dir, "dev"), "utf8")).notCounted.n).toBe(SHIP_FAIL_STREAK);
    expect(readFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"), "utf8").trim().split("\n"), "一条都不许划").toHaveLength(3);
  }, 60_000);

  it("捎成了就一句话都没有，队也空了——出声只发生在真的捎不上去时", async () => {
    mode = "ok";
    const dir = stuck();
    for (let i = 0; i < SHIP_FAIL_STREAK + 1; i++) {
      const r = await run(dir, "log");
      expect(r.stderr).not.toContain("捎不上去");
      expect(r.stderr).not.toContain("counted");
    }
    expect(existsSync(join(dir, ".ateam", "refused-queue.dev.jsonl")), "捎成了就不留着").toBe(false);
  }, 60_000);
});
