/**
 * t-228：**一条命令做多件事时，每一件各自报结果；退出码不许只反映最后一件。**
 *
 * 真样本是 dev 15:45 那一次：`task done` 已经落库成功，而它随后自动发的「解决接缝 t-226+t-070」被服务端拒了
 * （说那条接缝不存在），终端上只有一行 `REJECTED (seam)` 加退出码 2——**看起来像整条命令失败了**。第一反应
 * 是重交，而重交会撞上「done 之上再 done」再被拒一次（t-034 那次正是这么走的：两次「失败」，事实是第一次就成了）。
 *
 * **frontend 15:47 核准的边界，写在这里免得下一个人读偏**：**不是「被拒也可能落库」**——它核过自己三次被拒
 * 各落 0 条（R0 测试 note、290 字 tell、282 字 tell），**单件命令拒了就是没写**——**是「一条命令发了两件事，
 * 退出码只报最后一件」**。这个区分要紧：读偏了会让人开始怀疑所有拒绝，那比原来的毛病更糟。
 */
import { describe, it, expect } from "vitest";
import { EXIT_PARTIAL, exitCodeLine } from "@ateam/core";
import { sendAll } from "../src/send.js";

/**
 * **测的是真实现，不是替身。** 第一版我把 main.ts 里那段逻辑抄进用例里跑——那正是我今天被 qa 指出过两次的
 * 毛病（替身恰好绕开真实那一路唯一会出错的地方）。所以把它抽成 `src/send.ts`，用例导入的就是命令行在跑的那份。
 */
const run = (items: { what: string; send: () => Promise<string> }[], out: string[] = [], err: string[] = []) =>
  sendAll(items.map((x) => ({ what: x.what, event: x })), async (e) => ({ id: await e.send(), line: `事件行 ${e.what}` }), (l) => out.push(l), (l) => err.push(l))
    .then((r) => ({ ...r, out, err }));

const ok = (id: string) => () => Promise.resolve(id);
const no = (why: string) => () => Promise.reject(new Error(why));

describe("t-228 判据 1、2 · 每一件各自一行，成的在前", () => {
  it("**复现 15:45 那一幕**：done 成了、解决接缝被拒 ⇒ 两行，done 那行在前", async () => {
    const r = await run([
      { what: "t-226 done", send: ok("01MDONE") },
      { what: "解决接缝 t-226+t-070", send: no("REJECTED (seam): no seam between t-226 and t-070") },
    ]);
    expect(r.out).toHaveLength(2);
    expect(r.out[0], "落库成功的那一件有自己的事件行").toContain("t-226 done");
    expect(r.out[1], "被拒的那一件说清是哪一件、规则名是什么").toContain("解决接缝 t-226+t-070");
    expect(r.out[1]).toContain("seam");
    expect(r.out.indexOf(r.out[0]), "成的在前").toBe(0);
  });

  it("退出码是 EXIT_PARTIAL，不是 2——**2 的意思是「什么都没成」，而这里 done 成了**", async () => {
    const r = await run([{ what: "done", send: ok("01M1") }, { what: "接缝", send: no("REJECTED (seam): x") }]);
    expect(r.exit).toBe(EXIT_PARTIAL);
    expect(EXIT_PARTIAL, "不复用 2，也不复用 3（3 是坏响应，t-225）").not.toBe(2);
    expect(EXIT_PARTIAL).not.toBe(3);
  });
});

describe("t-228 判据 4 · 两端不许弄乱", () => {
  it("全成功 ⇒ 0，每一件仍各自印一行", async () => {
    const r = await run([{ what: "done", send: ok("01M1") }, { what: "接缝", send: ok("01M2") }]);
    expect(r.exit).toBe(0);
    expect(r.out, "两件各一行事件行").toHaveLength(2);
  });

  it("全失败 ⇒ 2", async () => {
    const r = await run([{ what: "done", send: no("a") }, { what: "接缝", send: no("b") }]);
    expect(r.exit).toBe(2);
  });

  it("只发一件且成功 ⇒ 0；只发一件且被拒 ⇒ 2（单件命令的口径一个字没变）", async () => {
    expect((await run([{ what: "note", send: ok("01M1") }])).exit).toBe(0);
    expect((await run([{ what: "note", send: no("REJECTED (shape): …") }])).exit).toBe(2);
  });
});

describe("t-228 判据 3 · 退出码口径说得出来", () => {
  it("--help 里那一行把四个值都说清了", () => {
    for (const part of ["0", String(EXIT_PARTIAL), "2", "3"]) expect(exitCodeLine).toContain(part);
    expect(exitCodeLine).toContain("部分成功");
  });
});
