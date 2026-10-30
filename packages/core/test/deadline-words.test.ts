/**
 * t-292（pd 11:4x 的判准 ＋ pd 14:19 新立的第 ⑰ 条）：**那张期限词条表与牌桌上的三个段头必须对得上，
 * 而解释不许复述它的键。**
 *
 * 这道闸是被两次返工逼出来的。pd 11:40 定「词条表是字段名的合法住处，但只对人在别处看得见的名字合法」，
 * 于是 12:57 把三个键换成段头——**而为了让键对上段头，它把解释写成了段头的同义句**，14:19 自己读出来：
 * 「一张词条表里的解释复述了它的键，就什么都没教给人。」
 *
 * 两条里只有一条钉得死：**键与段头逐字相同**，这里钉它。「解释不许复述键」是人的判断，钉不死；
 * 能钉的那一半是**解释里不许再出现键本身**，那是复述最蠢的那一种形状，下面也钉上。
 */
import { describe, it, expect } from "vitest";
import { DEADLINE_WORDS, DEADLINE_WORDS_HEAD, UNANSWERED_HEAD, NOBODY_ACTED_HEAD, LATE_HEAD } from "../src/index.js";

/** 三栏的顺序：人欠的答案 → 收到了没动 → 角色之间过了该回的时间。词条表按同一顺序排。 */
const HEADS = [UNANSWERED_HEAD, NOBODY_ACTED_HEAD, LATE_HEAD];

describe("期限词条表与牌桌段头", () => {
  it("三条一一对应，键与段头逐字相同——读的人才对得上号", () => {
    expect(DEADLINE_WORDS).toHaveLength(HEADS.length);
    HEADS.forEach((head, i) => {
      expect(DEADLINE_WORDS[i].startsWith(`${head}：`), `第 ${i + 1} 条的键不是段头逐字：\n  键 ${DEADLINE_WORDS[i].split("：")[0]}\n  段头 ${head}`).toBe(true);
    });
  });

  it("解释里不许再出现键本身（复述最蠢的那一种，pd 第 ⑰ 条）", () => {
    HEADS.forEach((head, i) => {
      const why = DEADLINE_WORDS[i].slice(head.length + 1);
      expect(why, `第 ${i + 1} 条的解释里又出现了键`).not.toContain(head);
      expect(why.length, `第 ${i + 1} 条没有解释`).toBeGreaterThan(0);
    });
  });

  it("键里不许出现字段名——这正是 pd 11:40 要换掉它们的理由", () => {
    for (const line of DEADLINE_WORDS) expect(line.split("：")[0], line).not.toMatch(/\b[a-z][a-z0-9]*_[a-z0-9]+\b/);
  });

  it("标题不重复第二条键里已经说了的那一句（pd 14:19 二）", () => {
    // 旧标题是「…其中两栏看期限，一栏不看：」，而第二条的键自己带着「（不看期限）」。
    expect(DEADLINE_WORDS_HEAD).not.toContain("一栏不看");
    expect(NOBODY_ACTED_HEAD).toContain("不看期限");
  });
});
