/**
 * t-296 的 pm 08:44 ① 与 12:43 ①②③：**捎不上去要退避；404 是「服务端没有这条路」，那是永久的，自己一格。**
 *
 * 旧行为是每条命令各重试一次、零退避。于是生产上 `POST /refusals` 回 404（而那一次 404 要 58.2 秒）时，
 * 这台机器后面每一条命令都各付一次那笔钱——**一次正当的拒绝，让这台机器往后每条命令都更贵一点**。
 *
 * 这一份下半段起真进程、真端口，但**不碰真服务端**；时间这一维靠**预置状态文件**控制，而不是靠等。
 * 预置状态与「真的等过了」是同一件事：那个文件就是这台机器记住「下次什么时候再试」的唯一地方。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterShip, readShipState, shouldShip, shipBackoffMs, shipSilenceNotice, shipStateFile,
  SHIP_BACKOFF_MS, SHIP_NO_ROUTE_MS, SHIP_FAIL_STREAK, SHIP_LOUD_STREAK, SHIP_STUCK_MS, type ShipState,
} from "../src/refusalqueue.js";
import type { Refused } from "@ateam/core";

const NOW = new Date(Date.parse("2026-10-30T14:00:00Z"));
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const DAY = SHIP_STUCK_MS;
const q = (n: number, at: string): Refused[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "refused", id: `01M66K${String(i).padStart(20, "0")}`, at, who: "dev", rule: "usage", op: "cli note" }));
const fresh = readShipState(null);
const streak = (kind: "unreachable" | "not-counted" | "no-route", n: number, now = NOW): ShipState => {
  let st = fresh;
  for (let i = 0; i < n; i++) st = afterShip(st, kind, now);
  return st;
};

describe("pm 08:44 ① · 退避的口径写得出来，而且只有一处", () => {
  it("梯子按连续失败次数走：第 1 次不等，之后 1 分、5 分、15 分、1 小时封顶", () => {
    expect(SHIP_BACKOFF_MS).toEqual([0, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]);
    expect(shipBackoffMs("unreachable", 1)).toBe(0);
    expect(shipBackoffMs("unreachable", 2)).toBe(60_000);
    expect(shipBackoffMs("unreachable", 5)).toBe(60 * 60_000);
    expect(shipBackoffMs("unreachable", 500), "封顶之后不再长").toBe(60 * 60_000);
  });

  it("`ok` 没有要等的——捎成了下一条命令立刻可以再捎", () => {
    expect(shipBackoffMs("ok", 9)).toBe(0);
    expect(afterShip(streak("unreachable", 4), "ok", NOW).nextTryAt).toBeNull();
  });

  it("404 不走那道梯子，它走自己那一档（一天一次）", () => {
    expect(shipBackoffMs("no-route", 1)).toBe(SHIP_NO_ROUTE_MS);
    expect(shipBackoffMs("no-route", 99), "次数不改变它——这条路不存在，与试了几次无关").toBe(SHIP_NO_ROUTE_MS);
  });

  it("`shouldShip` 就是这件事的全部判断：没到时刻就一个请求都不发", () => {
    const st = afterShip(fresh, "no-route", NOW);
    expect(shouldShip(st, NOW)).toBe(false);
    expect(shouldShip(st, new Date(NOW.getTime() + SHIP_NO_ROUTE_MS - 1000))).toBe(false);
    expect(shouldShip(st, new Date(NOW.getTime() + SHIP_NO_ROUTE_MS))).toBe(true);
    expect(shouldShip(fresh, NOW), "没记过时刻就是该发（新机器、旧格式、刚成功过）").toBe(true);
    expect(shouldShip({ ...fresh, nextTryAt: "不是时间" }, NOW), "读不出来按该发——不许因为一个坏字段就永远不捎").toBe(true);
  });

  it("旧格式的状态文件读得动：缺 noRoute 与 nextTryAt 就是「没有」，不是「坏账」", () => {
    const old = readShipState(JSON.stringify({ unreachable: { n: 96, since: ago(8 * 3600_000) }, notCounted: { n: 0, since: null }, saidAt: null }));
    expect(old.unreachable.n, "旧那两格照旧读得出").toBe(96);
    expect(old.noRoute).toEqual({ n: 0, since: null });
    expect(old.nextTryAt).toBeNull();
    expect(shouldShip(old, NOW), "旧文件不该让这台机器从此不捎").toBe(true);
  });
});

describe("pm 12:43 ③ · 第三格：服务端答得很清楚，只是没有这条路", () => {
  it("404 那一族不再被算成 unreachable——两格分开数", () => {
    const st = streak("no-route", 3);
    expect(st.noRoute.n).toBe(3);
    expect(st.unreachable.n, "它不该在那一格里").toBe(0);
  });

  it("三句话互不相同，而 unreachable 那句**不再说「没有这条路」**（那半句搬进了第三格）", () => {
    const a = shipSilenceNotice(streak("unreachable", 3), q(2, ago(2 * DAY)), NOW)!;
    const b = shipSilenceNotice(streak("not-counted", 3), q(2, ago(2 * DAY)), NOW)!;
    const c = shipSilenceNotice(streak("no-route", 1), q(2, ago(2 * DAY)), NOW)!;
    expect(a).toContain("请求没到服务端");
    expect(a, "合着说才是那个缺陷：两件事要人做的事相反").not.toContain("没有这条路");
    expect(b).toContain("counted 是 false");
    expect(c).toContain("POST /refusals 回 404");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("**404 一次就够格出声，不看年龄**：它永远不会自己成功，等它变老没有意义", () => {
    const young = q(3, ago(60_000));   // 队里最早那条才一分钟
    expect(shipSilenceNotice(streak("no-route", 1), young, NOW), "第一次就说").not.toBeNull();
    expect(shipSilenceNotice(streak("unreachable", 1), young, NOW), "可能自己好的那一族照旧要攒").toBeNull();
  });

  it("三句话里都说得出「谁能让它消失」（pd 14:28 定稿的第 ② 条）", () => {
    expect(shipSilenceNotice(streak("no-route", 1), q(3, ago(60_000)), NOW)).toContain("要有人把那条路发上线");
    expect(shipSilenceNotice(streak("not-counted", 3), q(3, ago(2 * DAY)), NOW)).toContain("要有人去修服务端那本账");
    expect(shipSilenceNotice(streak("unreachable", 3), q(3, ago(2 * DAY)), NOW)).toContain("网通了会自己补上");
  });
});

describe("pm 12:43 ② · 出声条件按次数与形状分，不只按年龄", () => {
  it("**我这台机器那个现场**：连续 96 次、队里最早那条只有 8 小时——旧条件一句话都不说，新条件说", () => {
    const real = q(3, ago(8 * 3600_000));
    const st = streak("unreachable", 96);
    expect(st.unreachable.n).toBe(96);
    const line = shipSilenceNotice(st, real, NOW);
    expect(line, "这就是那 96 次沉默的成因：条件写成「最早那条 ≥ 24 小时」").not.toBeNull();
    expect(line).toContain("8 小时");
    expect(line, "pd 立的第 ⑱ 条：条件改了，句子里的数要跟着改——「已经 0 天」是语法正确的假话").not.toContain("0 天");
  });

  it("次数这一档的边界：到 SHIP_LOUD_STREAK 才算「次数自己够了」", () => {
    const young = q(3, ago(8 * 3600_000));
    expect(shipSilenceNotice(streak("unreachable", SHIP_LOUD_STREAK - 1), young, NOW)).toBeNull();
    expect(shipSilenceNotice(streak("unreachable", SHIP_LOUD_STREAK), young, NOW)).not.toBeNull();
  });

  it("年龄那一档一个字没变：满一天、连续 3 次，照旧说", () => {
    const old = q(3, ago(DAY + 1000));
    expect(shipSilenceNotice(streak("unreachable", SHIP_FAIL_STREAK - 1), old, NOW)).toBeNull();
    expect(shipSilenceNotice(streak("unreachable", SHIP_FAIL_STREAK), old, NOW)).not.toBeNull();
  });
});

/* ── 真路：真进程、真端口、真状态文件 ─────────────────────────────────────── */

const CLI = resolve(__dirname, "..", "dist", "main.js");
let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/refusals") {
      hits++;
      req.on("data", () => {});
      req.on("end", () => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ events: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function checkout(st?: ShipState): string {
  const dir = mkdtempSync(join(tmpdir(), "t296b-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  writeFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"),
    q(3, new Date(Date.now() - 8 * 3600_000).toISOString()).map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (st) writeFileSync(shipStateFile(dir, "dev"), JSON.stringify(st));
  return dir;
}
const run = (dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 25_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (err, stdout, stderr) => done({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });

describe("pm 12:43 ① · 真路：收到 404 就停发，而且只出声一次", () => {
  it("**四条命令，服务端只被打一次**：第一条说了那句，后三条连请求都不发", async () => {
    hits = 0;
    const dir = checkout();
    const first = await run(dir, "log");
    expect(first.status, "顺带说的一句不许改退出码").toBe(0);
    expect(first.stderr, "第一条就说——404 不必等它变老").toContain("POST /refusals 回 404");
    expect(hits, "第一条发了一次").toBe(1);
    for (let i = 0; i < 3; i++) {
      const r = await run(dir, "log");
      expect(r.status, `第 ${i + 2} 条`).toBe(0);
      expect(r.stderr, "说过了就不再说").not.toContain("POST /refusals 回 404");
    }
    expect(hits, "三条命令一次都没再打——这就是判据①要的「不再每条命令都再打一次」").toBe(1);
    const st = readShipState(readFileSync(shipStateFile(dir, "dev"), "utf8"));
    expect(st.noRoute.n, "也没有被误记成第 2、3、4 次失败").toBe(1);
    expect(st.nextTryAt, "停发是靠它").not.toBeNull();
    expect(readFileSync(join(dir, ".ateam", "refused-queue.dev.jsonl"), "utf8").trim().split("\n"),
      "队一条不划（t-218 本件不碰）——停的是重试，不是记账").toHaveLength(3);
  }, 90_000);

  it("**那一天过了就再探一次**：预置一个已到期的 nextTryAt，命令又发了一次", async () => {
    hits = 0;
    const past = new Date(Date.now() - 1000).toISOString();
    const dir = checkout({ unreachable: { n: 0, since: null }, notCounted: { n: 0, since: null }, noRoute: { n: 1, since: past }, saidAt: past, nextTryAt: past });
    await run(dir, "log");
    expect(hits, "到点了就该探——全停会让那条路上线之后队列永远排不空").toBe(1);
    expect(readShipState(readFileSync(shipStateFile(dir, "dev"), "utf8")).noRoute.n).toBe(2);
  }, 60_000);

  it("**没到点就一个连接都不建**，连配置都不必读通", async () => {
    hits = 0;
    const soon = new Date(Date.now() + SHIP_NO_ROUTE_MS).toISOString();
    const dir = checkout({ unreachable: { n: 0, since: null }, notCounted: { n: 0, since: null }, noRoute: { n: 1, since: soon }, saidAt: soon, nextTryAt: soon });
    const r = await run(dir, "log");
    expect(r.status).toBe(0);
    expect(hits).toBe(0);
    expect(existsSync(join(dir, ".ateam", "refused-queue.dev.jsonl")), "队照旧在").toBe(true);
  }, 60_000);
});

describe("t-296 判据 5 · 范围自查：这个环在哪一种文件上成立", () => {
  /**
   * pm 自查时量到这一条在它那台机器上**不复现**（本仓库目录 `help` 109 毫秒），而它 `.ateam/refused.pm`
   * 里确实有一条待捎记录——于是它写进判据：**别照一台机器的现象改成两台机器的规则。**
   *
   * 答案不是版本差异，是**两个不同的文件**（main.ts 里 t-283 判据 7 那段注释写着）：
   * · `refused.<me>`——本地提醒，单槽覆写，**从不发往服务端**；
   * · `refused-queue.<me>.jsonl`——出站遥测，追加式，服务端说记下了才划掉。
   * 这个环只由后者驱动。pm 手上那条在前者里，所以它那台 `shipRefusals` 在读完队列（空）之后就返回了，
   * **一个请求都不发**——109 毫秒正是这个形状，不是「它那一版修好了」。
   *
   * 下面这条用例把这件事钉住，免得下一个人再把两个文件读成一件事。
   */
  it("只有 `refused.dev`（本地提醒）而队列是空的：服务端一次都没被打，而那条提醒照旧在", async () => {
    hits = 0;
    const dir = mkdtempSync(join(tmpdir(), "t296c-"));
    mkdirSync(join(dir, ".ateam"));
    writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
    // 单槽那个文件：逐字照 noteRefusal 写下的形状
    const reminder = join(dir, ".ateam", "refused.dev");
    writeFileSync(reminder, JSON.stringify({ at: new Date(Date.now() - 3600_000).toISOString(), rule: "usage", cmd: "ateam task done t-1", what: "task done t-1" }));
    const r = await run(dir, "log");
    expect(r.status, "命令自己照旧成功").toBe(0);
    expect(hits, "队列是空的 ⇒ 一个请求都不发 ⇒ 这个环压根不成立").toBe(0);
    expect(existsSync(reminder), "本地提醒与出站队列互不影响（t-283 判据 7）").toBe(true);
    expect(existsSync(join(dir, ".ateam", "refused-queue.dev.jsonl")), "它不会因为有提醒就长出一个队列").toBe(false);
  }, 60_000);

  it("把同一条记录放进队列文件，环就成立了——**差别只在文件，不在版本**", async () => {
    hits = 0;
    const dir = checkout();
    await run(dir, "log");
    expect(hits, "队里有东西就会去捎（而这一台的服务端回 404）").toBe(1);
  }, 60_000);
});
