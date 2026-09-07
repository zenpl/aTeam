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
    for (const m of text.matchAll(/ateam\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) out.push({ where, cmd: m[1], sub: m[2] });
  }
  return out;
}

describe("t-141 · 说明书教的命令必须真的存在", () => {
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

  it("写一个不存在的命令进说明书就会红：这条断言自己能被证伪", () => {
    const have = cliCommands();
    expect(have.has("sync")).toBe(true);              // a real one, from the switch
    expect(have.has("join")).toBe(true);              // a real one, dispatched before the switch
    expect(have.has("summon")).toBe(false);           // an invented one
    // the check is over the real files, so a bad line anywhere in them fails the first test above
    expect(taught().length).toBeGreaterThan(10);
    expect(manualRoles().length).toBeGreaterThan(0);
    expect(manual("dev")).toBeTruthy();
    expect(welcome("https://x")).toBeTruthy();
  });
});
