/**
 * t-229 判据 1、3 的命令行那一半：**那个数印得出来**，而三个与期限有关的数各自覆盖什么，`--help` 里说得出来。
 * 句子是 core 的（`lateLine`、`DEADLINE_WORDS`），这里只印——命令行自己再写一份，就是第二处措辞。
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { MemoryStore, append, reduce, board, lateLine, DEADLINE_WORDS, LATE_SHOWN, type NewEvent, LATE_HEAD } from "@ateam/core";
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
    expect(text).not.toContain(LATE_HEAD);
  });

  it("名单多的时候只印头几条：数已经在那一句里了", async () => {
    const b = await boardWith(9);
    const text = fmt.board(b, "dev");
    expect(text).toContain(lateLine(b.late));
    const lines = text.split("\n");
    // t-292（pd 10:31 ③）：段头是 pd 定的中文了，所以这里引 core 的常量而不是旧那个英文前缀
    const from = lines.findIndex((l) => l === LATE_HEAD);
    const section = lines.slice(from, from + lines.slice(from).findIndex((l, i) => i > 0 && l === ""));
    const shown = section.filter((l) => l.includes("pm → dev: 第"));
    expect(shown).toHaveLength(LATE_SHOWN);
    expect(shown[0], "最久的在前").toContain("第 8 件");
  });

  /**
   * t-296 判据 4：**这条用例曾经随服务端健康状况随机红，此刻它的红有确定的成因。**
   *
   * 成因不在这个文件里：`ateam help` 此前在末尾替那本捎不掉的拒绝账发一次请求，于是生产上
   * `POST /refusals` 回 404（而那一次 404 要 58.2 秒）时，`help` 在这棵树里量到 47,063 毫秒——
   * 而这条用例没有写 vitest 的超时，走的是默认的 **5 秒上限**，于是它红在一件与期限措辞毫无关系的事上。
   *
   * **修的不是这条用例**：`help` 从此一个请求都不发（`shipsOn` 把它排除），本机实测 91/100/91 毫秒、
   * 与空目录的 95 毫秒同量级，而「一个连接都不建」在 `local-fast.test.ts` 里被直接钉住。
   * 这里只把 `execFile` 的 20 秒**降到**与那道 5 秒上限一致——**没有抬任何上限**（pm 的判据禁的正是抬它），
   * 降下来是为了超时的那一刻红在 `help` 本身，而不是红在一个比它宽四倍的壳上。
   */
  it("`ateam help` 里三个数各自覆盖什么，逐句印得出来（判据 3）", async () => {
    const out = await new Promise<string>((done) => {
      execFile(process.execPath, [resolve(__dirname, "..", "dist", "main.js"), "help"], { encoding: "utf8", timeout: 5_000 }, (_e, stdout, stderr) => done(`${stdout}\n${stderr}`));
    });
    for (const line of DEADLINE_WORDS) expect(out).toContain(line);
  });
});
