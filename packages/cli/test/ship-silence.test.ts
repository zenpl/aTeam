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
  it("两句话不一样：一句说「没到服务」，一句说「服务收下了但没有这本账」", () => {
    const a = shipSilenceNotice(streak("unreachable", 3), q(2, ago(2 * DAY)), NOW)!;
    const b = shipSilenceNotice(streak("not-counted", 3), q(2, ago(2 * DAY)), NOW)!;
    expect(a).toContain("那台服务没有这条路");
    expect(b).toContain("counted: false");
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
let mode: "no-route" | "not-counted" | "ok" = "no-route";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/refusals") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
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

/** 一个装着「六天前就卡在这儿」的队列的检出——**日期是造的，形状是真的**（逐字照真文件那几行）。 */
function stuck(days = 6): string {
  const dir = mkdtempSync(join(tmpdir(), "t284-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  const at = new Date(Date.now() - days * DAY).toISOString();
  writeFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"),
    q(3, at).map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}
const run = (dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (err, stdout, stderr) => done({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });

describe("t-284 判据 4 · 真路：第三条命令出声，而它不掀翻任何东西", () => {
  it("头两条一声不吭，第三条说了；退出码与 stdout 一个字不变", async () => {
    mode = "no-route";
    const dir = stuck();
    const a = await run(dir, "log");
    const b = await run(dir, "log");
    const c = await run(dir, "log");
    for (const [i, r] of [a, b, c].entries()) {
      expect(r.status, `第 ${i + 1} 条命令的退出码`).toBe(0);
      expect(r.stdout, `第 ${i + 1} 条命令的 stdout`).toBe(a.stdout);
    }
    expect(a.stderr).not.toContain("捎不上去");
    expect(b.stderr).not.toContain("捎不上去");
    expect(c.stderr, "第三条：连续 3 次、最早一条 6 天、今天没说过").toContain("捎不上去");
    expect(c.stderr).toContain("6 天");
    const d = await run(dir, "log");
    expect(d.stderr, "说过了就一天之内不再说").not.toContain("捎不上去");
    expect(JSON.parse(readFileSync(shipStateFile(dir, "dev"), "utf8")).unreachable.n).toBe(4);
  });

  it("counted:false 那一族说的是另一句，而队照旧一条不划（t-218 那条本件不碰）", async () => {
    mode = "not-counted";
    const dir = stuck();
    let last = { stderr: "", status: 0 as number | null };
    for (let i = 0; i < SHIP_FAIL_STREAK; i++) last = await run(dir, "log");
    expect(last.status).toBe(0);
    expect(last.stderr).toContain("counted: false");
    expect(readFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"), "utf8").trim().split("\n"), "一条都不许划").toHaveLength(3);
  });

  it("捎成了就一句话都没有，队也空了——出声只发生在真的捎不上去时", async () => {
    mode = "ok";
    const dir = stuck();
    for (let i = 0; i < SHIP_FAIL_STREAK + 1; i++) {
      const r = await run(dir, "log");
      expect(r.stderr).not.toContain("捎不上去");
      expect(r.stderr).not.toContain("counted: false");
    }
    expect(existsSync(join(dir, ".ateam", "refused-queue.dev.jsonl")), "捎成了就不留着").toBe(false);
  });
});
