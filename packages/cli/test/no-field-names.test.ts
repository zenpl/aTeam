/**
 * t-292 判据 4（pd 05:33 的通则）：**给人读的句子里不出现字段名；字段名只留在给机器的那一份。**
 *
 * 判据 3 那三处是同一个毛病的三个实例，pd 把它写成了通则。一条通则不配闸，过两天就长出第四处——而**第四处
 * 此刻就在那儿**：`format.ts` 的 LATE 那一段，英文句子里印着 `ack_by`。`humanSentences` 只认中文，所以
 * 冻结那道闸从来没看见过它（SAYINGS 的盲点清单第二条写的正是这一类）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fieldNamesInHumanText, isHumanText, FIELD_NAMES_PENDING_PD } from "@ateam/core";

/**
 * 这道闸看不见的那几种。**清单住在这儿而不在 core**：它是写给改这道闸的人的话，不是人可见的文案——
 * 放进 core 会白占三格 pd 的措辞名册（冻结那道闸的口径是产品源码里的中文字面量，不含用例）。
 */
export const FIELD_NAME_GATE_BLIND_SPOTS = [
  "core 里的句子不在口径内：BOARD_SHAPE 就住在 board.ts，而它正是「给机器的那一份」的说明书，里面出现字段名是对的。要连 core 一起扫，得先按声明把 BOARD_SHAPE 切出去。",
  "驼峰写法的字段名抓不到：这个项目的字段一律下划线连写，但哪天有人加一个 ackBy，这条正则看不见它。",
  "拼出来的字段名抓不到：`${\"ack\"}_by` 在字面量里是两段，闸只看得见单个字面量。",
] as const;

/** 人可见的两处渲染器：命令行印的那一份、人打开的那一页。 */
const RENDERERS = ["packages/cli/src/format.ts", "packages/server/src/html.ts"];
const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
const hits = (f: string) => fieldNamesInHumanText(read(f));

describe("t-292 判据 4 · 给人读的句子里不许有字段名", () => {
  it("两处渲染器此刻只剩待 pd 定稿的那几处，一处不多", () => {
    const found = RENDERERS.flatMap((file) => hits(file).flatMap((h) => h.names.map((name) => ({ file, name }))));
    const pending = FIELD_NAMES_PENDING_PD.flatMap((p) => Array.from({ length: p.count }, () => ({ file: p.file, name: p.name })));
    expect(found.slice().sort((a, b) => `${a.file}${a.name}`.localeCompare(`${b.file}${b.name}`)),
      `给人读的句子里出现了字段名：\n${found.map((f) => `  ${f.file}  ${f.name}`).join("\n")}\n` +
      "措辞归 pd：要么 pd 写一句不带字段名的，要么它进 FIELD_NAMES_PENDING_PD；不许在落地时顺手造一句。",
    ).toEqual(pending.slice().sort((a, b) => `${a.file}${a.name}`.localeCompare(`${b.file}${b.name}`)));
  });

  it("那一处确实是 LATE 那一段，而不是别的什么（待办要说得出在说哪一处）", () => {
    const late = hits("packages/cli/src/format.ts");
    expect(late).toHaveLength(2);
    for (const h of late) expect(h.names).toEqual(["ack_by"]);
    expect(late.some((h) => h.text.includes("LATE"))).toBe(true);
  });

  it("**该挡住的那一格**：往另一句人可见的话里塞一个字段名，当场抓到", () => {
    const injected = 'out.push("", `过期还没答（按 ack_by 排）`);';
    expect(fieldNamesInHumanText(injected)).toEqual([{ text: "过期还没答（按 ack_by 排）", names: ["ack_by"] }]);
    // 英文的人可见文案同样抓到——这正是只认中文时漏掉的那一类
    expect(fieldNamesInHumanText('out.push("LATE (past ack_by)");')[0]?.names).toEqual(["ack_by"]);
  });

  it("**不该挡的那几格**：代码里的键、注释、给机器那一份的说明，都不是「一句话」", () => {
    expect(fieldNamesInHumanText('const k = "needs_human";')).toEqual([]);          // 光一个字段名不是话
    expect(fieldNamesInHumanText('b.overdue_by_presence.instructions')).toEqual([]); // 根本不是字面量
    expect(fieldNamesInHumanText('// 过了 ack_by 还没 ack')).toEqual([]);            // 注释写给读代码的人
    expect(fieldNamesInHumanText('const re = /[a-z]_[a-z]/g;')).toEqual([]);         // 正则整段跳过
    // 拒绝话里带字段名是对的：pd 05:30 ④ 自己定稿的那一句就带着 ack_by（人要知道改哪个字段）
    expect(hits("packages/core/src/rules.ts" as string).length).toBeGreaterThan(0);
  });

  it("命令名、开关、路径、sha 都不是字段名（CLAUDE.md 说它们原样保留）", () => {
    for (const s of ['"跑一次 ateam sync 看漏了什么"', '"确实不做了就划掉：ateam sync --clear-refused"',
                     '"改 packages/core/src/rules.ts"', '"生产此刻跑的是 5f6e2b6"', '"--no-seam-check-for"'])
      expect(fieldNamesInHumanText(s), s).toEqual([]);
  });

  it("「是不是一句话」的判准：含中文，或者含空格", () => {
    expect(isHumanText("needs_human")).toBe(false);
    expect(isHumanText("过了期限还没答")).toBe(true);
    expect(isHumanText("past ack_by")).toBe(true);
    expect(isHumanText("ack_by ")).toBe(false);          // 尾随空格不算「词之间有空格」
  });

  it("这道闸说得出自己盲在哪儿", () => {
    expect(FIELD_NAME_GATE_BLIND_SPOTS.length).toBeGreaterThan(0);
    for (const s of FIELD_NAME_GATE_BLIND_SPOTS) expect(s).toMatch(/[一-龥]/);
  });
});
