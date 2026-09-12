/**
 * t-241：**部件级被拒不进本地那本账，而它恰好在「一次发多件」的那几条命令上失明。**
 *
 * 「一次发多件」这一族的第三处：① t-228（`done` 那一路退出码只报最后一件，已修已验）；
 * ② t-232（`verify` 那一路没被 t-228 盖住，已修已验）；③ 本件。
 * **前两处管的是「当场印得对不对」，本件管的是「事后查得到查不到」**——终端上那一行只活一秒（t-116），
 * 而本地那本账是下一条 sync 还会再说一遍的那个。
 */
import { describe, it, expect } from "vitest";
import { sendAll } from "../src/send.js";
import { ClientError } from "../src/client.js";
import { readRefusal, refusalNotice } from "../src/rejected.js";
import { PART_NAMES } from "@ateam/core";

const parts = [
  { what: PART_NAMES.done("t-226"), event: { kind: "task", op: "done", task: "t-226" } },
  { what: "解决接缝 t-226+t-070", event: { kind: "task", op: "seam" } },
];

describe("t-241 · 被拒的那几件带得出来", () => {
  it("一件被拒：结果里说得出是哪一件、被哪条规则拒的", async () => {
    const r = await sendAll(parts, async (e) => {
      if ((e as { op: string }).op === "seam") throw new ClientError(409, { error: "rejected", rule: "seam", message: "already resolved" });
      return { id: "01A", line: "01A  task t-226 done" };
    }, () => {}, () => {});
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ what: "解决接缝 t-226+t-070", rule: "seam" });
    expect(r.failed[0].why).toContain("already resolved");
    expect(r.ok, "前面那件成了，事实照旧").toBe(1);
  });

  it("全成：一件都不报，账上不该多出东西", async () => {
    const r = await sendAll(parts, async () => ({ id: "01A", line: "01A ok" }), () => {}, () => {});
    expect(r.failed).toEqual([]);
  });

  it("不是 409 的失败也带出来，规则名说不出就说不出（不编一个）", async () => {
    const r = await sendAll(parts.slice(0, 1), async () => { throw new Error("网络断了"); }, () => {}, () => {});
    expect(r.failed[0]).toMatchObject({ rule: "error" });
    expect(r.failed[0].why).toContain("网络断了");
  });

  it("记进那本账之后，下一次 sync 的提醒说得出**是哪一件**没落下去", () => {
    const record = JSON.stringify({ at: new Date().toISOString(), rule: "seam", cmd: "ateam task done t-226 --evidence …", what: "task done t-226", part: "解决接缝 t-226+t-070" });
    const line = refusalNotice(readRefusal(record), new Date())!;
    expect(line).toContain("解决接缝 t-226+t-070 没有落下去");
    expect(line).toContain("（seam）");
  });
});

/**
 * 真路：真的 `node dist/main.js decide`（一次发两件）、真的 409、真的 `.ateam/` 文件、真的下一条 sync。
 * **这一半是判据 1 说的那件事**：被拒之后**事后查得到**。
 */
describe("t-241 · 真路：一次发两件，第二件被拒 ⇒ 下一条 sync 说得出", () => {
  it("终端上那一行之外，本地那本账也记下了，而且记的是被拒的那一件", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { createServer } = await import("node:http");
    const CLI = resolve(__dirname, "..", "dist", "main.js");
    const ID = "01M2BCA5KHKSFXAQ3MCA43AY8F";
    let posts = 0;
    const server = createServer((req, res) => {
      if (req.method === "POST") {
        posts += 1;
        let body = ""; req.on("data", (c) => (body += c));
        req.on("end", () => {
          if (posts === 1) { res.writeHead(201, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "01A", kind: "ack", actor: "dev", at: new Date().toISOString(), of: ID })); }
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "rejected", rule: "decide", message: `${ID} already decided: B by human` }));
        });
        return;
      }
      const url = req.url ?? "/";
      res.writeHead(200, { "content-type": "application/json" });
      if (url.startsWith("/board")) {
        return res.end(JSON.stringify({ shape: 2, instructions: [{ id: ID, from: "pm", to: "human", body: "A 还是 B？", status: "pending", sent: new Date().toISOString(), options: ["A", "B"], default: "B" }], tasks: {}, needs_human: [], seams: [], readings: [], presence: [] }));
      }
      res.end(JSON.stringify({ shape: 2, events: [], for_me: [], cursor: null, owed: { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 }, sha: "abc1234", deploys: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "t241-"));
    mkdirSync(join(dir, ".ateam"));
    writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: `http://127.0.0.1:${port}`, token: "k" }));
    const env = { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" };
    const run = (...args: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env }, (e, out, err) =>
        done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
    });
    try {
      const r = await run("decide", ID, "A");
      expect(r.code, "一件成一件拒 ⇒ 部分成功").toBe(4);
      expect(r.out).toContain("✗");
      const file = join(dir, ".ateam", "refused.dev");
      expect(existsSync(file), "**事后查得到**：本地那本账记下了").toBe(true);
      const rec = JSON.parse(readFileSync(file, "utf8")) as { rule: string; what: string; part?: string };
      expect(rec.rule).toBe("decide");
      expect(rec.part, "记的是被拒的那一件").toContain(ID);
      expect(rec.what, "而划掉它认的是这条命令的动作").toBe("decide 01M2BCA5KHKSFXAQ3MCA43AY8F A");

      const next = await run("sync");
      expect(next.err, "下一条 sync 再说一遍").toContain("有一次写入被拒（decide）");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 40_000);
});

/**
 * 两条规矩合在一起才成立，各钉一条：
 * ① 记的 `what` 是这条命令的动作 ⇒ **重做同一条命令成了，这条记录才消失**（划掉那条规矩认的是它）；
 * ② 而这条命令自己在部件被拒时**照旧走完**（t-228：被拒不再掀翻整条命令），所以「成了才划掉」那一句
 *    必须看退出码——否则它会把刚记下的当场划掉，**记了等于没记**。
 */
describe("t-241 · 记下来的那条，什么时候才该消失", () => {
  it("提醒印的是被拒的那一件，而重做的命令是整条", () => {
    const rec = JSON.stringify({ at: new Date().toISOString(), rule: "seam", cmd: "ateam task done t-226 --evidence …", what: "task done t-226", part: "解决接缝 t-226+t-070" });
    const line = refusalNotice(readRefusal(rec), new Date())!;
    expect(line).toContain("解决接缝 t-226+t-070 没有落下去");
    expect(line).toContain("重做：ateam task done t-226 --evidence …");
    expect(line, "整条命令不是「没落下去」的那一件").not.toContain("task done t-226 没有落下去");
  });

  it("没有 part 的老记录照旧：印 what（这条路一个字没改）", () => {
    const rec = JSON.stringify({ at: new Date().toISOString(), rule: "seam", cmd: "ateam task done t-113", what: "task done t-113" });
    expect(refusalNotice(readRefusal(rec), new Date())!).toContain("task done t-113 没有落下去");
  });

  it("part 记坏了当没有：不许拿一个读不出的东西去当「哪一件」", () => {
    for (const bad of ["5", '"  "', "null", "{}"]) {
      const rec = JSON.stringify({ at: new Date().toISOString(), rule: "seam", cmd: "c", what: "task done t-1", part: JSON.parse(bad) as never });
      expect(refusalNotice(readRefusal(rec), new Date()), bad).toContain("task done t-1 没有落下去");
    }
  });
});
