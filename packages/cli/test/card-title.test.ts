/**
 * t-265：**给人发卡时，标题会被悄悄弄坏，而发卡的人不知道。**
 *
 * 真样本全是同一个人同一天踩的（pm，判据 5）：一张卡第一句带 `**` 共 32 码点、一张用了冒号被截成四个字、
 * 另两张把 `**` 原样印到人那一页上。**三次都是发出去之后才发现的。**
 *
 * 判据 7 把做法收窄成一句：**把这条卡的标题原样印在终端上**——发卡的人自己就看得出坏在哪，
 * 一个人可见的新字都不加。
 *
 * 这份用例走**真的命令行**（`dist/main.js tell human … --option`）对一台假服务器发，断言终端上那一行。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";

const CLI = resolve(__dirname, "..", "dist", "main.js");
let server: Server, dir = "", port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c));
      req.on("end", () => {
        // 假服务器把发上来的那条原样回一份：命令行印事件行时要读 `to`／`body`，缺字段会变成
        // `Cannot read properties of undefined`——**那种红是夹具坏了，不是本件的伤**。
        const sent = JSON.parse(body || "{}") as Record<string, unknown>;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...sent, id: "01A", actor: "pm", at: new Date().toISOString() }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: [], for_me: [], cursor: null, owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), "t265-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "pm", url: `http://127.0.0.1:${port}`, token: "k" }));
});
afterAll(async () => { rmSync(dir, { recursive: true, force: true }); await new Promise<void>((r) => server.close(() => r())); });

const tell = (body: string, ...extra: string[]) => new Promise<{ out: string; err: string }>((done) => {
  execFile(process.execPath, [CLI, "tell", "human", body, ...extra], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
    (_e, out, err) => done({ out, err }));
});

/** 三种坏法，逐字取自判据 2；第四条是好的那种，用来证明这条提示不是逢发必吵。 */
const LONG = "这是一句特意写得很长很长的第一句话用来测试标题会不会被判成空的情形。细节在这里。";
const MARKDOWN = "**这个洞还开着**，一条命令可能当场关上。细节在这里。";
const COLON = "外呼地址：给一个 https 的地址，我们至今发不出任何消息给你。细节在这里。";
const FINE = "能给一个 https 的外呼地址吗。细节在这里。";

describe("t-265 判据 1、2、7 · 发卡之前，终端说得出这张卡的标题会是什么", () => {
  it("① 第一句超过 30 码点：印出人那一页真正会显示的那个（截断＋…），不是「没有标题」", async () => {
    const { err } = await tell(LONG, "--option", "A", "--option", "B");
    expect(err, "人看到的是截断标题，所以终端也该说截断标题").toContain("这是一句特意写得很长很长的第一句话用来测试标题会不会被判成空…");
  });

  it("② 第一句带 markdown：星号原样出现在标题里，发卡人看得见", async () => {
    const { err } = await tell(MARKDOWN, "--option", "A", "--option", "B");
    expect(err).toContain("**这个洞还开着**，一条命令可能当场关上");
  });

  it("③ 第一句里有冒号：标题在那里被截断，发卡人看得见只剩四个字", async () => {
    const { err } = await tell(COLON, "--option", "A", "--option", "B");
    expect(err).toContain("外呼地址");
    expect(err, "冒号后面那半不在标题里").not.toContain("给一个 https 的地址，我们至今发不出");
  });

  it("好的那种也照印——这条提示说的是「标题会是什么」，不是「你写错了」", async () => {
    const { err } = await tell(FINE, "--option", "A", "--option", "B");
    expect(err).toContain("能给一个 https 的外呼地址吗");
  });

  it("判据 3：三种坏法一条都不许变成拒绝——四条都真的发出去了", async () => {
    for (const body of [LONG, MARKDOWN, COLON, FINE]) {
      const { out } = await tell(body, "--option", "A", "--option", "B");
      expect(out, `${body.slice(0, 12)}… 应当照发不误`).toContain("01A");
    }
  }, 40_000);

  it("不是发给人的卡，不印这一行（这条提示只为人那一页存在）", async () => {
    const r = await new Promise<{ err: string }>((done) => {
      execFile(process.execPath, [CLI, "tell", "qa", MARKDOWN], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
        (_e, _o, err) => done({ err }));
    });
    expect(r.err).not.toContain("这个洞还开着");
  });
});
