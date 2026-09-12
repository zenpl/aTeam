/**
 * t-218：**命令行自己抛的那几种拒绝，写入根本没发出去**，所以 t-212 那本账一条都看不见它们——
 * 它们只活在各人终端里。这份用例走的是真路：**真的 `node dist/main.js`、真的退出码、真的队列文件、
 * 真的一次 HTTP 捎上去**。照 t-211 那次的教训——假的那一路测得再多，翻车的总是真的那一路。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { cliOpOf, readRefusalQueue, queueRefusal, clearRefusals, pendingRefusals, refusalQueueFile, QUEUE_MAX } from "../src/refusalqueue.js";
import { CLI_REFUSAL_OVERFLOW, cliRefusalOp, isCliRefusal, type Refused } from "@ateam/core";

const CLI = resolve(__dirname, "..", "dist", "main.js");

let home = "";
let server: Server;
let base = "";
let got: Refused[] = [];
let counted = true;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/refusals") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const rs = (JSON.parse(body) as { refusals: Refused[] }).refusals;
        if (counted) got.push(...rs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ recorded: counted ? rs.map((r) => r.id) : [], counted }));
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

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t218-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  return dir;
}
/**
 * **异步地跑，不能用 spawnSync**：这份用例里的服务就住在跑用例的这个线程上，同步等子进程会把它自己的事件
 * 循环占死——子进程的请求永远没人接，两边一起等。（第一版正是这么写的，整份用例挂住，一条断言都没跑到。）
 */
const run = (dir: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (err, stdout, stderr) => done({ status: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
const queued = (dir: string) => pendingRefusals(dir, "dev");

describe("t-218 判据 1、2 · 真路：被拒 → 进队 → 下一次通信捎上去", () => {
  // 这一段是一个故事的两步（被拒 → 下一条命令捎上去），所以第一步放在这里跑一次，两条断言各看一头
  let refused: { status: number | null } = { status: null };
  beforeAll(async () => {
    got = []; counted = true;
    home = checkout();
    refused = await run(home, "tell");                // 缺参数：UsageError，一个字节都没发出去
  });

  it("命令行自己抛的那一次：退出码 2，队里多一条，带规则名与「哪种写入」，不含正文", () => {
    const dir = home;
    expect(refused.status, "被拒就是 2").toBe(2);
    const q = queued(dir);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "refused", who: "dev", rule: "usage", op: cliRefusalOp("tell") });
    expect(q[0].id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.stringify(q[0]), "不存被拒的正文，也不存任务 id").not.toMatch(/tell .*--/);
  });

  it("下一条跑通的命令把它捎上去，服务说记下了才划掉", async () => {
    const before = queued(home);
    expect(before).toHaveLength(1);
    const r = await run(home, "log");
    expect(r.status, "捎东西不该改变这条命令的成败").toBe(0);
    expect(got.map((x) => x.id)).toEqual([before[0].id]);
    expect(got[0]).toMatchObject({ rule: "usage", op: cliRefusalOp("tell"), who: "dev" });
    expect(existsSync(refusalQueueFile(home, "dev")), "捎成了就不留着").toBe(false);
  });

  it("服务说「这儿没有这本账」（counted false）⇒ 一条都不划，下次再捎", async () => {
    const dir = checkout();
    counted = true;
    await run(dir, "tell");
    expect(queued(dir)).toHaveLength(1);
    counted = false;
    const r = await run(dir, "log");
    expect(r.status).toBe(0);
    expect(queued(dir), "没记下就还在队里").toHaveLength(1);
    counted = true;
    await run(dir, "log");
    expect(queued(dir)).toHaveLength(0);
  });

  it("服务端那一路的 409 不进这个队：它在服务端已经记过一次了", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t218b-"));
    mkdirSync(join(dir, ".ateam"));
    // 一台只会回 409 的服务：命令行拿到的是 ClientError，不是本地抛的 Rejected
    const s = createServer((_req, res) => { res.writeHead(409, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "rejected", rule: "done", message: "nope" })); });
    await new Promise<void>((up) => s.listen(0, "127.0.0.1", up));
    writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, token: "k" }));
    const r = await run(dir, "note", "x");
    expect(r.status, "服务拒了：退出码 2").toBe(2);
    expect(queued(dir), "同一次拒绝不许数两遍").toHaveLength(0);
    await new Promise<void>((done) => s.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("t-218 · 队本身：哪种写入、坏行、只划掉捎上去的那几条、满了也不悄悄变小", () => {
  it("op 只取命令词，第三个词（任务 id、人名）不进去", () => {
    expect(cliOpOf(["task", "done", "t-113", "--evidence", "abc"])).toBe(cliRefusalOp("task done"));
    expect(cliOpOf(["decide", "01M2B", "A"])).toBe(cliRefusalOp("decide"));
    expect(cliOpOf([])).toBe(cliRefusalOp("?"));
    expect(isCliRefusal(cliOpOf(["decide"]))).toBe(true);
    expect(isCliRefusal("POST /decide"), "服务端那一路不该被认成客户端的").toBe(false);
  });

  it("坏掉的一行跳过，其余照捎——一行读不动不该让整队捎不上去", () => {
    const rs = readRefusalQueue(`{"id":"01AAAAAAAAAAAAAAAAAAAAAAAA","at":"2026-09-12T00:00:00.000Z","who":"dev","rule":"usage","op":"cli tell"}\n{坏\n\n`);
    expect(rs).toHaveLength(1);
    expect(rs[0].rule).toBe("usage");
  });

  it("只划掉捎上去的那几条：这中间新追进来的还在队里", () => {
    const dir = mkdtempSync(join(tmpdir(), "t218c-"));
    queueRefusal(dir, "dev", { at: new Date().toISOString(), rule: "usage", op: cliRefusalOp("tell") });
    const first = pendingRefusals(dir, "dev")[0];
    queueRefusal(dir, "dev", { at: new Date().toISOString(), rule: "decide", op: cliRefusalOp("decide") });
    clearRefusals(dir, "dev", [first.id]);
    const rest = pendingRefusals(dir, "dev");
    expect(rest).toHaveLength(1);
    expect(rest[0].rule).toBe("decide");
    rmSync(dir, { recursive: true, force: true });
  });

  it("满了：扔最旧的，而「扔了几条」自己变成队里的一条——账不许悄悄变小", () => {
    const dir = mkdtempSync(join(tmpdir(), "t218d-"));
    const many: Refused[] = [];
    for (let i = 0; i < QUEUE_MAX; i++) many.push({ kind: "refused", id: `01AAAAAAAAAAAAAAAAAAAAAA${String(i).padStart(2, "0")}`.slice(0, 26), at: "2026-09-12T00:00:00.000Z", who: "dev", rule: "usage", op: cliRefusalOp("tell") });
    mkdirSync(join(dir, ".ateam"), { recursive: true });
    writeFileSync(refusalQueueFile(dir, "dev"), many.map((r) => JSON.stringify(r)).join("\n") + "\n");
    queueRefusal(dir, "dev", { at: "2026-09-12T01:00:00.000Z", rule: "decide", op: cliRefusalOp("decide") });
    const q = pendingRefusals(dir, "dev");
    expect(q.length).toBe(QUEUE_MAX);
    expect(q[0].rule).toBe(CLI_REFUSAL_OVERFLOW);
    expect(q[0].op, "扔了几条写在账上，谁都数得出此刻差多少").toBe(cliRefusalOp("(dropped 2)"));
    expect(q[q.length - 1].rule, "最新那条在队里").toBe("decide");
    // 再满一次：两次扔掉的合起来算，不是两条溢出记录
    for (let i = 0; i < 3; i++) queueRefusal(dir, "dev", { at: "2026-09-12T02:00:00.000Z", rule: "decide", op: cliRefusalOp("decide") });
    const q2 = pendingRefusals(dir, "dev");
    expect(q2.filter((r) => r.rule === CLI_REFUSAL_OVERFLOW)).toHaveLength(1);
    expect(q2[0].op).toBe(cliRefusalOp("(dropped 5)"));
    rmSync(dir, { recursive: true, force: true });
  });
});
