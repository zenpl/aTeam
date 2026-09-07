/**
 * t-141 判据 3, and t-108's rule once more: the manual teaches commands, and a command it teaches must exist.
 *
 * Prose that names a thing the code does not have is worse than prose that says nothing — the reader types it, it
 * fails, and what they learn is that the manual is not to be trusted. So the manual's command names are checked
 * against the CLI's own dispatch, and one that is not there turns the build red and names itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { manual, manualRoles, welcome } from "../src/index.js";

const MANUAL_DIR = new URL("../manual/", import.meta.url);
const CLI = readFileSync(new URL("../../cli/src/main.ts", import.meta.url), "utf8");

/**
 * The commands the CLI actually dispatches on. Both shapes count: the `case "x":` arms of its switch, and the
 * `cmd === "x"` comparisons that handle the few before it — `init`/`join` are dispatched that way, and reading only
 * the switch made this check accuse the invite page of teaching a command that has existed all along.
 */
function cliCommands(): Set<string> {
  const out = new Set<string>();
  for (const m of CLI.matchAll(/case\s+"([a-z][a-z-]*)"\s*:/g)) out.add(m[1]);
  for (const m of CLI.matchAll(/\bcmd\s*===\s*"([a-z][a-z-]*)"/g)) out.add(m[1]);
  return out;
}

/** Every `ateam <word>` a piece of prose teaches. */
function taughtIn(where: string, text: string): { where: string; cmd: string; sub?: string }[] {
  return [...text.matchAll(/ateam\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)].map((m) => ({ where, cmd: m[1], sub: m[2] }));
}

/** Every `ateam <word>` the prose teaches, with the file it came from. */
function taught(): { where: string; cmd: string; sub?: string }[] {
  const out: { where: string; cmd: string; sub?: string }[] = [];
  const files = readdirSync(MANUAL_DIR, { withFileTypes: true });
  const read = (rel: string) => readFileSync(new URL(rel, MANUAL_DIR), "utf8");
  const texts: [string, string][] = [];
  for (const f of files) {
    if (f.isFile() && f.name.endsWith(".md")) texts.push([f.name, read(f.name)]);
    if (f.isDirectory()) for (const g of readdirSync(new URL(`${f.name}/`, MANUAL_DIR))) if (g.endsWith(".md")) texts.push([`${f.name}/${g}`, read(`${f.name}/${g}`)]);
  }
  for (const [where, text] of texts) {
    out.push(...taughtIn(where, text));
  }
  return out;
}

describe("t-148 · 说明书教的命令必须真的存在", () => {
  it("每一个 `ateam <命令>` 都在 CLI 的分派里", () => {
    const have = cliCommands();
    const missing = taught().filter((t) => !have.has(t.cmd));
    expect(missing, `说明书教了 CLI 没有的命令：${missing.map((m) => `${m.where} 里的 \`ateam ${m.cmd}\``).join("、")}`).toEqual([]);
  });

  it("`ateam task <子命令>` 的子命令也都在", () => {
    const have = cliCommands();
    const missing = taught().filter((t) => t.cmd === "task" && t.sub && !have.has(t.sub));
    expect(missing, `说明书教了 CLI 没有的 task 子命令：${missing.map((m) => `${m.where} 里的 \`ateam task ${m.sub}\``).join("、")}`).toEqual([]);
  });

  /** 判据 2, the half that must fire: a command nobody implemented, put into prose, and caught by name. */
  it("该报的：说明书里放一个不存在的命令，闸报出来并指名", () => {
    const have = cliCommands();
    const bad = taughtIn("造出来的一页.md", "没事做？跑 `ateam summon` 把它叫起来。").filter((t) => !have.has(t.cmd));
    expect(bad.map((b) => [b.where, b.cmd])).toEqual([["造出来的一页.md", "summon"]]);
    expect(have.has("summon")).toBe(false);
  });

  /**
   * 判据 2 的另一半，也是判据 3 的记录：**这道闸第一次跑就冤枉了一页正确的文档。**
   *
   * 06:2x 它指控 invite.md 与 welcome.md 教了不存在的 `ateam join`。`join` 一直都在，只是它和 `init` 由 switch 之前
   * 的一句 `cmd === "…"` 处理，而当时的闸只读 `case "x":`。错的是闸，不是说明书——我差一点据此给 frontend 报一个
   * 不存在的缺陷。留着这一条，是为了不让后来人以为这是一道从没出过错的闸。
   */
  it("不该报的：`ateam join` 走 switch 之前的 if，一直存在——闸第一次把这一页冤枉了", () => {
    const have = cliCommands();
    expect(have.has("join")).toBe(true);
    expect(have.has("init")).toBe(true);
    expect(CLI).toMatch(/cmd === "init" \|\| cmd === "join"/);   // the shape that fooled it
    expect(CLI).not.toMatch(/case\s+"join"\s*:/);
    for (const page of ["invite.md", "welcome.md"]) {
      const text = readFileSync(new URL(page, MANUAL_DIR), "utf8");
      expect(taughtIn(page, text).filter((t) => !have.has(t.cmd))).toEqual([]);
    }
  });

  it("闸本身还活着：说明书与 CLI 都真的读到了", () => {
    expect(taught().length).toBeGreaterThan(10);
    expect(cliCommands().size).toBeGreaterThan(10);
    expect(manualRoles().length).toBeGreaterThan(0);
    expect(manual("dev")).toBeTruthy();
    expect(welcome("https://x")).toBeTruthy();
  });
});
