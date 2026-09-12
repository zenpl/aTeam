/**
 * t-247：**旧命令行把不认得的开关静默吞掉。**
 *
 * t-246 刚给了大家 `--X-file`，而全队多半跑的是不认得它的那一支：qa 22:38 那条两千多字的判决落库时
 * **evidence 是空的**——它那支 CLI 不认得 `--evidence-file`，于是照收、不读、**一个字不说地退 0**。
 * pm 22:47 在另一棵工作树上实测同样：退 0、stderr 一个字都没有，而事件照落、字段为空。
 *
 * 同一支 CLI 上还有一条不对称：**未知开关＋值 ⇒ 静默退 0**，而**已知开关缺值 ⇒ 报一句英文、退 1**。
 * **更难发现的那一种反而更安静。** 两条现在都是用法错。
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, known, UsageError } from "../src/args.js";
import { UNKNOWN_FLAG, FLAG_NEEDS_VALUE } from "@ateam/core";

const CLI = resolve(__dirname, "..", "dist", "main.js");

describe("t-247 判据 1、3 · 两种都出声，而且指名是哪一个", () => {
  it("不认得的开关：报用法错，话里带着它的原文", () => {
    expect(() => parse(["note", "x", "--完全不存在的开关", "值"])).toThrow(UsageError);
    try { parse(["note", "x", "--完全不存在的开关", "值"]); }
    catch (e) { expect((e as Error).message).toBe(UNKNOWN_FLAG("完全不存在的开关")); }
  });

  it("已知开关缺值：也是用法错，也说得出是哪一个（此前是一句英文、退 1）", () => {
    expect(() => parse(["task", "verify", "t-1", "--surface"])).toThrow(UsageError);
    try { parse(["task", "verify", "t-1", "--surface"]); }
    catch (e) { expect((e as Error).message).toBe(FLAG_NEEDS_VALUE("surface")); }
  });

  it("判据 4：那句话里有出路——升级这支命令行，或改用新旧都对的写法", () => {
    const line = UNKNOWN_FLAG("evidence-file");
    expect(line).toContain("git pull && pnpm build");
    expect(line).toContain('--X "$(cat 文件)"');
    expect(line, "而且先说清后果：一个字都没发").toContain("一个字都没发");
  });

  it("判据 2：真开关一个都不被误伤，--X-file 那一族也认得", () => {
    for (const f of ["ack-by", "surface", "evidence", "criteria", "refs", "touches", "quiet", "no-human-impact", "option", "default"]) {
      expect(known(f), f).toBe(true);
    }
    expect(known("evidence-file")).toBe(true);
    expect(known("nope")).toBe(false);
  });
});

describe("t-247 判据 1 · 真路：真的命令、真的退出码、真的 stderr", () => {
  const run = (dir: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((done) => {
    execFile(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000, env: { ...process.env, ATEAM_ME: "", ATEAM_URL: "", ATEAM_TOKEN: "" } },
      (e, out, err) => done({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }));
  });

  it("`--完全不存在的开关 值` ⇒ 非零退出码，stderr 上有它的原文，而且一个事件都没发", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t247-"));
    mkdirSync(join(dir, ".ateam"));
    // 指向一个一定连不上的地址：**真发了才会失败**，所以「退出码是用法错、不是网络错」本身就证明它没发
    writeFileSync(join(dir, ".ateam", "config.json"), JSON.stringify({ me: "dev", url: "http://127.0.0.1:9", token: "k" }));
    try {
      const r = await run(dir, "note", "试一下", "--完全不存在的开关", "值");
      expect(r.code, "非零").toBe(2);
      expect(r.err).toContain("--完全不存在的开关");
      expect(r.err, "带着出路").toContain("git pull && pnpm build");
      const ok = await run(dir, "note", "试一下");
      expect(ok.code, "而一条真的命令死在网络上（退 1），不是死在解析上").toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);
});
