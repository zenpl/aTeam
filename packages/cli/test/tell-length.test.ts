/**
 * t-286：**发之前量得出那个数，而且量的是闸自己那把尺。**
 *
 * 上半段钉「只报告 / 不掀翻 / 出错也出声」三条（判据 4、5）；下半段走真路：真 `node dist/main.js tell`、
 * 真一条 409、**服务端那句话由 core 里那条真规则生成**——所以「预检的数与拒绝话里的数相同」是端到端量的，
 * 不是我自己跟自己对。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tellPrecheck } from "../src/precheck.js";
import { INSTRUCTION_MAX_CHARS, instructionBodyLength } from "@ateam/core";

const rep = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const OVER = rep("中", 300);
const OK = rep("中", INSTRUCTION_MAX_CHARS);

describe("t-286 判据 4、5 · 预检说什么、不说什么", () => {
  it("超了才出声，而且印的是闸会报的那个数与超出量", () => {
    const [line, ...rest] = tellPrecheck(OVER);
    expect(rest, "一句话").toHaveLength(0);
    expect(line).toContain(`${instructionBodyLength(OVER)} 字`);
    expect(line).toContain(`超了 ${instructionBodyLength(OVER) - INSTRUCTION_MAX_CHARS} 字`);
    expect(line, "队规里已有的那条出路：讲道理的那半挪进 note").toContain("note");
  });

  it("没超就一个字都不说（280 正好不超）", () => {
    expect(tellPrecheck(OK)).toEqual([]);
    expect(tellPrecheck("")).toEqual([]);
  });

  it("**判据 5：预检自己出错时出声，不悄悄跳过**", () => {
    const boom = () => { throw new Error("量不出来"); };
    const [line, ...rest] = tellPrecheck(OVER, boom);
    expect(rest).toHaveLength(0);
    expect(line).toContain("没跑成");
    expect(line, "说得出是为什么").toContain("量不出来");
    expect(line, "并且说清这一条照样发出去了").toContain("照样发");
  });

  it("预检只返回话，不做别的：它不截断、不改正文、没有返回一个「改好的 body」这种出口", () => {
    // 第一版我在这里断言 `tellPrecheck.length` 是 3，红了——**`Function.length` 只数第一个默认值之前的参数**，
    // 所以它是 1。断言改成真规则，不是把实现迁就断言：这里要钉的本来就是「它只往外给话」。
    const lines = tellPrecheck(OVER);
    expect(Array.isArray(lines) && lines.every((l) => typeof l === "string"), "出口只有一串话").toBe(true);
    for (const l of lines) expect(l.includes(OVER), "不许把整条正文再印一遍").toBe(false);
    expect(tellPrecheck(OVER), "同一条问两遍答案一样：它不带状态").toEqual(lines);
  });
});

/* ── 真路 ───────────────────────────────────────────────────────────────────── */

const CLI = resolve(__dirname, "..", "dist", "main.js");
let server: Server;
let base = "";
let posts = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").startsWith("/events")) {
      posts += 1;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const e = JSON.parse(raw) as { body?: string };
        const body = e.body ?? "";
        // **拒绝话用 core 里那条真规则的原文**：这里照抄 rules.ts 那一句，数由 instructionBodyLength 算。
        const { INSTRUCTION_MAX_CHARS: MAX, instructionBodyLength: len } = await import("@ateam/core");
        if (len(body) > MAX) {
          res.writeHead(409, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "rejected", rule: "instruction", message: `body is ${len(body)} chars; max ${MAX}. Put the argument in a note and the action here.` }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...e, id: "01M2VX0000000000000000000X", actor: "dev", at: new Date().toISOString() }));
      });
      return;
    }
    if (req.method === "POST") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ recorded: [], counted: true })); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: [], for_me: [], cursor: null, owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "t286-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: base, token: "k" }));
  return dir;
}
const run = (dir: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (e, out, err) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });

describe("t-286 判据 2、4 · 真路：预检的数与服务端拒绝话里的数逐字相同", () => {
  for (const [name, body] of [
    ["纯 ASCII", rep("a", 300)],
    ["纯中文", rep("中", 300)],
    ["中英混合", rep("中a文b", 300)],
    ["含 emoji（代理对）", rep("好👍", 300)],
    ["边界 281", rep("a", INSTRUCTION_MAX_CHARS + 1)],
  ] as const) {
    it(`${name}：两个数相同，而且命令照旧发出去了`, async () => {
      const dir = checkout();
      const before = posts;
      try {
        const r = await run(dir, "tell", "pm", body);
        const mine = /这条 (\d+) 字/.exec(r.err)?.[1];
        const theirs = /body is (\d+) chars/.exec(r.err + r.out)?.[1];
        expect(mine, `${name}：预检报的数`).toBe(String(instructionBodyLength(body)));
        expect(theirs, `${name}：服务端拒绝话里的数`).toBe(mine);
        expect(posts, "**判据 4：不许拒绝发送**——预检出声了，这一条仍然发到了服务端").toBe(before + 1);
        expect(r.code, "被服务端拒了就是 2").toBe(2);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }, 40_000);
  }

  it("280 正好不超：预检一个字不说，服务端也收下了", async () => {
    const dir = checkout();
    try {
      const r = await run(dir, "tell", "pm", OK);
      expect(r.err).not.toContain("超了");
      expect(r.code).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
