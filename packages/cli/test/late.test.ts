/**
 * t-229 判据 1、3 的命令行那一半：**那个数印得出来**，而三个与期限有关的数各自覆盖什么，`--help` 里说得出来。
 * 句子是 core 的（`lateLine`、`DEADLINE_WORDS`），这里只印——命令行自己再写一份，就是第二处措辞。
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { MemoryStore, append, reduce, board, lateLine, DEADLINE_WORDS, LATE_SHOWN, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function boardWith(n: number) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  for (let i = 0; i < n; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `第 ${i} 件`, ack_by: at(-60 - i).toISOString() }, -200);
  return board(reduce(await s.read(), at(0), HUMAN), HUMAN, at(0));
}

describe("t-229 · 命令行把那个数印出来", () => {
  it("有过期的角色间指令时印那一行，数与「最久多久」都来自 core 那一句", async () => {
    const b = await boardWith(2);
    const text = fmt.board(b, "dev");
    expect(text).toContain(lateLine(b.late));
    expect(text).toContain("pm → dev: 第 0 件");
  });

  it("一条都没有就一个字都不印——空栏目是噪音", async () => {
    const text = fmt.board(await boardWith(0), "dev");
    expect(text).not.toContain("LATE (");
  });

  it("名单多的时候只印头几条：数已经在那一句里了", async () => {
    const b = await boardWith(9);
    const text = fmt.board(b, "dev");
    expect(text).toContain(lateLine(b.late));
    const lines = text.split("\n");
    const from = lines.findIndex((l) => l.startsWith("LATE ("));
    const section = lines.slice(from, from + lines.slice(from).findIndex((l, i) => i > 0 && l === ""));
    const shown = section.filter((l) => l.includes("pm → dev: 第"));
    expect(shown).toHaveLength(LATE_SHOWN);
    expect(shown[0], "最久的在前").toContain("第 8 件");
  });

  it("`ateam help` 里三个数各自覆盖什么，逐句印得出来（判据 3）", async () => {
    const out = await new Promise<string>((done) => {
      execFile(process.execPath, [resolve(__dirname, "..", "dist", "main.js"), "help"], { encoding: "utf8", timeout: 20_000 }, (_e, stdout, stderr) => done(`${stdout}\n${stderr}`));
    });
    for (const line of DEADLINE_WORDS) expect(out).toContain(line);
  });
});
