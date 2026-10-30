/**
 * t-292 判据 4（pd 05:33 的通则）：**给人读的句子里不出现字段名；字段名只留在给机器的那一份。**
 *
 * 判据 3 那三处是同一个毛病的三个实例，pd 把它写成了通则。一条通则不配闸，过两天就长出第四处——而**第四处
 * 此刻就在那儿**：`format.ts` 的 LATE 那一段，英文句子里印着 `ack_by`。`humanSentences` 只认中文，所以
 * 冻结那道闸从来没看见过它（SAYINGS 的盲点清单第二条写的正是这一类）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fieldNamesInHumanText, isHumanText, withoutPlaceholders, undeclaredFieldNames, wordingHash, FIELD_NAME_SCOPE, FIELD_NAMES_DECLARED } from "@ateam/core";

/**
 * 这道闸看不见的那几种。**清单住在这儿而不在 core**：它是写给改这道闸的人的话，不是人可见的文案——
 * 放进 core 会白占三格 pd 的措辞名册（冻结那道闸的口径是产品源码里的中文字面量，不含用例）。
 */
export const FIELD_NAME_GATE_BLIND_SPOTS = [
  "整份文件一次词法，所以同一份文件里「给机器那一份的说明书」和给人读的句子分不开：判一条命中是不是例外，只能靠 FIELD_NAMES_DECLARED 里一条人写的理由。按声明切片能分开，但切完再逐片词法会从模板串中间开始跑飞（量过）。",
  "驼峰写法的字段名抓不到：这个项目的字段一律下划线连写，但哪天有人加一个 ackBy，这条正则看不见它。",
  "拼出来的字段名抓不到：`${\"ack\"}_by` 在字面量里是两段，闸只看得见单个字面量。",
] as const;

const read = (f: string) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
const hits = (f: string) => fieldNamesInHumanText(read(f));
const scope = () => Object.fromEntries(FIELD_NAME_SCOPE.map((f) => [f, read(f)]));

/**
 * 登记在案的四处，逐条是哪一处、为什么还在名单上。**理由住在这儿而不在 core**：它们是写给改这道闸的人
 * 的话，不是人可见的文案——放进 core 会白占四格 pd 的措辞名册（冻结那道闸的口径是产品源码里的中文字面量）。
 */
const PENDING_PD = [
  // format.ts 原来那两条（LATE 段头与每行）已由 pd 10:31 ③ 定稿落地，不在名单上了。
  // frontend 11:3x 的更正：下面这两条我 10:2x 说成「住在 BOARD_SHAPE 里、是给机器那一份的说明书，所以合规」。
  // **查错了。** 它们住在 DEADLINE_WORDS，而 DEADLINE_WORDS 由 cli 的 main.ts 印在 ateam --help 里，是人读的。
  { hash: "36af0208032d", file: "packages/core/src/board.ts", field: "overdue_by_presence",
    why: "DEADLINE_WORDS 第二句，印在 ateam --help 里。它是一份「字段 → 这一栏覆盖什么」的词条表，所以也可以说字段名正是它的题目——但那一步归 pd 判，我只摆着。" },
  { hash: "4ae707eead07", file: "packages/core/src/board.ts", field: "ack_by",
    why: "DEADLINE_WORDS 第三句，同上。" },
] as const;

describe("t-292 判据 4 · 给人读的句子里不许有字段名", () => {
  it("口径内一句没被登记的都没有——有就是有人新造了一处", () => {
    const left = undeclaredFieldNames(scope());
    expect(left,
      `给人读的句子里出现了没登记过的字段名：\n${left.map((x) => `  ${x.file}  ${x.hash}  ${x.field}\n    ${x.text.slice(0, 90)}`).join("\n")}\n` +
      "措辞归 pd：要么 pd 写一句不带字段名的，要么它进 FIELD_NAMES_DECLARED；不许在落地时顺手造一句。",
    ).toEqual([]);
  });

  it("core 里那份指纹名单，与这里逐条的理由对得上（一边加一条、另一边忘了，就红）", () => {
    expect(PENDING_PD).toHaveLength(2);
    expect([...FIELD_NAMES_DECLARED].sort()).toEqual(PENDING_PD.map((p) => p.hash).slice().sort());
    for (const d of PENDING_PD) expect(d.why, d.hash).toMatch(/[一-龥]/);   // 每一条都要说得出为什么它还在名单上
  });

  it("名单上的指纹确实指向此刻源码里那四句（名单不许指向已经不存在的话）", () => {
    const all = new Map(FIELD_NAME_SCOPE.flatMap((f) => fieldNamesInHumanText(read(f)).map((h) => [wordingHash(h.text), { f, h }])));
    for (const d of PENDING_PD) {
      const got = all.get(d.hash);
      expect(got, `${d.hash} 指向的话不在源码里了：${d.why}`).toBeTruthy();
      expect(got!.f, d.hash).toBe(d.file);
      expect(got!.h.names, d.hash).toContain(d.field);
    }
  });

  it("两条都在 --help 里那张期限词条表；LATE 那两条已经由 pd 定稿换掉了", () => {
    // pd 10:31 ③ 的定稿落地之后，渲染器这一侧一条不剩——**名单缩短的依据是句子真的换了**
    expect(hits("packages/cli/src/format.ts")).toEqual([]);
    const words = hits("packages/core/src/board.ts");
    expect(words).toHaveLength(2);
    // frontend 11:3x 的更正：这两条不是 BOARD_SHAPE（给机器那一份的说明书），是 DEADLINE_WORDS，
    // 由 cli 的 main.ts 印在 ateam --help 里。我 10:2x 把它说成合规，查错了。
    expect(words.some((h) => h.text.startsWith("late：")), "DEADLINE_WORDS 第三句").toBe(true);
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
    // 拒绝话里带字段名是对的：pd 05:30 ④ 自己定稿的那一句就带着 ack_by（人要知道改哪个字段）。
    // 所以 rules.ts 不在口径内，而这是有理由的排除，不是忘了——它确实有命中。
    expect(hits("packages/core/src/rules.ts").length).toBeGreaterThan(0);
    expect(FIELD_NAME_SCOPE).not.toContain("packages/core/src/rules.ts");
    // 说明书整份是占位搭的：`{{watch_interval}}` 在渲染前就被换掉，人读不到那个名字
    expect(withoutPlaceholders("每 {{watch_interval}} 探一次")).toBe("每  探一次");
    expect(fieldNamesInHumanText('const m = "每 {{watch_interval}} 探一次";')).toEqual([]);
    expect(hits("packages/core/src/manual.ts")).toEqual([]);
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
