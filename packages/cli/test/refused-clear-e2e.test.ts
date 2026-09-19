/**
 * t-285：**「划掉那件事」全仓库零用例。**
 *
 * t-283 把指纹修对了，qa 03:43 手跑证明了行为今天是对的——**但手跑不是护栏**：明天谁把 `noteRefusal`
 * 里那行改回去，`cli` 照样全绿。t-283 那两条函数层的红（注入 A）量的是 `identityOf`／`actionOf` 的返回值，
 * **不是盘上那一格**：那两条绿着，文件仍然可以一次都没被删过（本件第一次跑就是这么证的，见判据 3 那段）。
 *
 * 所以这里走真路：真 `node dist/main.js`、真 `.ateam/refused.<me>`、真一次成功的写入。
 * **断言落在文件在不在、以及它的字节上，不落在命令输出上**（判据 4）——输出可以写得像划掉了而其实没划，
 * 这与 t-282 判据 8 那条「拼接后的字符串把两种情况渲染成一个样子」是同一族。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SPECIMENS, open } from "./specimens.js";

const CLI = resolve(__dirname, "..", "dist", "main.js");
/** 标本① 是 qa 那台的，`what` 是 `tell pm …`——所以这个检出的身份必须是 qa，否则文件名都对不上。 */
const SPECIMEN = SPECIMENS[0];
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "POST" && url === "/refusals") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ recorded: [], counted: true }));
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const e = JSON.parse(body) as Record<string, unknown>;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...e, id: "01M2VWZZZZZZZZZZZZZZZZZZZZ", actor: "qa", at: new Date().toISOString() }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ shape: 2, events: [], for_me: [], cursor: null, owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** 一个装着那份真标本的检出。**字节是标本的字节**：判据 2 要的两层 hash 由 `open()` 在写盘之前验过。 */
function withSpecimen(): { dir: string; file: string; bytes: Buffer } {
  open(SPECIMEN);                                    // 先验两层 hash，对不上当场红
  const bytes = Buffer.from(SPECIMEN.b64, "base64");
  const dir = mkdtempSync(join(tmpdir(), "t285-"));
  mkdirSync(join(dir, ".ateam"));
  writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "qa", url: base, token: "k" }));
  const file = join(dir, ".ateam", "refused.qa");
  writeFileSync(file, bytes);
  return { dir, file, bytes };
}
const run = (dir: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> =>
  new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (e, out, err) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("t-285 · 盘上那一格：缩短后重发成功 ⇒ 它真的被删掉", () => {
  it("正题：同一个收件人、正文改短、这一次成功 ⇒ `.ateam/refused.qa` 没了", async () => {
    const { dir, file } = withSpecimen();
    try {
      expect(existsSync(file), "起手它在").toBe(true);
      const r = await run(dir, "tell", "pm", "改短之后的正文");
      expect(r.code, "这一次是成功的写入").toBe(0);
      expect(existsSync(file), "**断言落在文件上**：它必须真的不在了").toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("反题：换一个动作成功 ⇒ 它还在，而且一个字节没变", async () => {
    const { dir, file, bytes } = withSpecimen();
    try {
      const r = await run(dir, "note", "一条与它无关的成功写入");
      expect(r.code).toBe(0);
      expect(existsSync(file), "别的动作办成了，不算把这条办了").toBe(true);
      expect(sha(readFileSync(file)), "留着的必须是原样的那几个字节").toBe(sha(bytes));
      expect(sha(readFileSync(file))).toBe(SPECIMEN.sha256);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  it("反题之二：发给另一个人成功 ⇒ 也不算（收件人仍然进指纹）", async () => {
    const { dir, file, bytes } = withSpecimen();
    try {
      const r = await run(dir, "tell", "dev", "改短之后的正文");
      expect(r.code).toBe(0);
      expect(existsSync(file)).toBe(true);
      expect(sha(readFileSync(file))).toBe(sha(bytes));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
