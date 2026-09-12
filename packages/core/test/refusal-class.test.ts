/**
 * t-233 判据 2、4：**类别是这条拒绝自己带的，不是谁去匹配拒绝话里的字。**
 *
 * 判据 4 的「盘一遍」在这里变成一道闸：仓库里每一处 `new Rejected(` 都被数出来，总数与**标成「已经发生过了」
 * 的那几处**都冻在下面。再加一条拒绝，这道闸就红，加的人必须回答一次「它属哪一类」——
 * **名单是量出来的，不是数出来的**（t-186 那条），否则「都归第一类」会再一次悄悄发生，而那正是本件的来历。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, append, Rejected, type NewEvent } from "../src/index.js";

const ROOT = join(__dirname, "..", "..");
const HUMAN = "human";

/** 仓库里每一处 `new Rejected(`，以及它是不是带了「已经发生过了」那个记号。 */
function sites(): { file: string; line: number; rule: string; already: boolean }[] {
  const out: { file: string; line: number; rule: string; already: boolean }[] = [];
  for (const pkg of ["core", "cli", "server"]) {
    const dir = join(ROOT, pkg, "src");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const text = readFileSync(join(dir, f), "utf8").split("\n");
      for (const [i, l] of text.entries()) {
        const m = /new Rejected\(\s*(?:"([^"]*)"|([A-Za-z_.]+))/.exec(l);
        if (!m) continue;
        // 记号跟在**这一条语句**的收尾上（`, { at: … })`）。所以只读到这条语句自己结束为止——
        // 顺手往下看两行会把下一条拒绝的记号读成这一条的，第一版就是这么把 14 处数成 21 处的。
        let stmt = l.slice(m.index);
        for (let j = i + 1; j < text.length && !/\);/.test(stmt); j++) stmt += text[j];
        out.push({ file: `${pkg}/${f}`, line: i + 1, rule: m[1] ?? m[2], already: /,\s*\{\s*at:/.test(stmt) });
      }
    }
  }
  return out;
}

/** 冻结：此刻一共多少处，其中标成「已经发生过了」的是哪几处（文件＋规则名，不写行号——行号一改就失真）。 */
const TOTAL = 138;
const ALREADY = [
  "cli/decide.ts decide", "core/rules.ts ack", "core/rules.ts decide", "core/rules.ts disown", "core/rules.ts disown",
  "core/rules.ts reading", "core/rules.ts seam", "core/rules.ts seam", "core/rules.ts stand-in", "core/rules.ts task",
  "core/rules.ts untell", "core/rules.ts verify", "core/rules.ts verify", "server/app.ts decide",
];

describe("t-233 判据 4 · 盘一遍：每一处拒绝都被数过，类别是标出来的", () => {
  it("总数冻结：再加一条拒绝这里就红，加的人得先回答「它属哪一类」", () => {
    expect(sites()).toHaveLength(TOTAL);
  });

  it("标成「已经发生过了」的就是这几处，一处不多一处不少", () => {
    expect(sites().filter((s) => s.already).map((s) => `${s.file} ${s.rule}`).sort()).toEqual([...ALREADY].sort());
  });
});

describe("t-233 判据 2、3 · 规则自己说它为什么拒", () => {
  async function world() {
    const s = new MemoryStore();
    const put = (e: NewEvent) => append(s, e, { human: HUMAN });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
    return { s, put };
  }
  const refusal = async (p: Promise<unknown>): Promise<Rejected> => {
    try { await p; } catch (e) { if (e instanceof Rejected) return e; throw e; }
    throw new Error("expected Rejected");
  };

  it("第二次 ack：带「已经发生过了」，时刻就是第一次 ack 落下的那一刻（真样本 qa 16:55）", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "办一件事", ack_by: new Date(Date.now() + 6e5).toISOString() });
    const ok = await w.put({ kind: "ack", actor: "dev", of: i.id });
    const err = await refusal(w.put({ kind: "ack", actor: "dev", of: i.id }));
    expect(err.rule).toBe("ack");
    expect(err.already).toEqual({ at: ok.at });
    expect(err.message).toContain("already acked");
  });

  it("同一个 id 建两次任务：也是那一类，时刻是第一次建的时候", async () => {
    const w = await world();
    const one = await w.put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "题", criteria: ["能用"], no_human_impact: true });
    const err = await refusal(w.put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "又一次", criteria: ["能用"], no_human_impact: true }));
    expect(err.already).toEqual({ at: one.at });
  });

  it("那件事没发生的那一类不带记号：形状不对、缺字段、不是给你的——一个都不许被说成「已经办好了」", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "给 dev 的", ack_by: new Date(Date.now() + 6e5).toISOString() });
    expect((await refusal(w.put({ kind: "ack", actor: "qa", of: i.id }))).already).toBeUndefined();
    expect((await refusal(w.put({ kind: "note", actor: "dev", body: "  " }))).already).toBeUndefined();
    expect((await refusal(w.put({ kind: "instruction", actor: "pm", to: "pm", body: "自己发给自己", ack_by: new Date(Date.now() + 6e5).toISOString() }))).already).toBeUndefined();
  });
});
