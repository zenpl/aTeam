/**
 * t-283：**被拒记录划不掉，因为 `tell` 的动作指纹把整条正文算了进去。**
 *
 * 这一族被拒的唯一成因是正文超长（280 字那道闸），而唯一的修法是改短正文——**于是重发必然换指纹，
 * 那条记录永远划不掉**：在这一类里「重发」与「改指纹」是同一个动作。实测三次（qa 两次、pm 一次）
 * 都是 `what = "tell " + 收件人 + " " + 整条正文`，前缀恰好 8 字（qa 03:12 / pm 03:17 各自量的）。
 *
 * 下面第一组钉修法，第二组钉「对照不许跟着一起松掉」——粒度变粗是有代价的交换，
 * 代价只许落在自由正文那一侧，不许落在 id 与收件人那一侧。
 */
import { describe, it, expect } from "vitest";
import { actionOf } from "../src/rejected.js";

/** 本次真实那两条的形状：同一个收件人、同一件事，只有正文长短不同（316 字被拒版 / 缩短成功版）。 */
const LONG = "答你那条：判据 1 的前提我复核过，两条发车路径逐字都没有 pnpm test……".repeat(12);
const SHORT = "答你那条：前提成立，细节在 note 里。";

describe("t-283 · tell 的指纹不认正文", () => {
  it("判据 1：同一个收件人、正文不同 ⇒ 指纹相同（这就是「缩短后重发」能划掉它的那一步）", () => {
    expect(actionOf(["tell", "qa", LONG])).toBe(actionOf(["tell", "qa", SHORT]));
    expect(actionOf(["tell", "qa", LONG]), "指纹里不许再出现正文").toBe("tell qa");
    expect(LONG.length, "样本确实是超长那一类").toBeGreaterThan(280);
  });

  it("判据 1（另一半）：带选项、带 --body-file 的写法也落在同一个指纹上", () => {
    expect(actionOf(["tell", "qa", LONG, "--ack-by", "15m"])).toBe("tell qa");
    expect(actionOf(["tell", "qa", "--body-file", "/tmp/x.txt"])).toBe("tell qa");
  });

  it("判据 2：收件人仍然进指纹——发给别人不算把这条办了", () => {
    expect(actionOf(["tell", "qa", SHORT])).not.toBe(actionOf(["tell", "dev", SHORT]));
  });

  it("判据 2：任务那一路一个字没松——done 与 claim 仍然是两件事", () => {
    expect(actionOf(["task", "done", "t-113"])).not.toBe(actionOf(["task", "claim", "t-113"]));
    expect(actionOf(["task", "done", "t-113"])).toBe("task done t-113");
    expect(actionOf(["task", "done", "t-113"]), "同一个 op 不同任务也不能混").not.toBe(actionOf(["task", "done", "t-114"]));
  });

  // 这一条第一次跑就红了，红得对：`--reason` 被滤掉，紧跟其后的**理由本身**却当成了第三个位置词。
  // 也就是说同一个病在 `untell` 与 `premise` 上各有一处，而我第一版只修了 `tell`。
  it("判据 2：untell 认的是那条指令的 id，不是理由", () => {
    const id = "01M29YRV80QBCKVADVBVD0PQ5G";
    expect(actionOf(["untell", id, "--reason", "写错了"])).toBe(`untell ${id}`);
    expect(actionOf(["untell", id])).not.toBe(actionOf(["untell", "01M2VTQGQH47A0DW1HEZ416DX7"]));
  });

  it("判据 2：note 整条都是自由正文 ⇒ 只剩子命令；这是有意的粗，代价写在 rejected.ts 的注释里", () => {
    expect(actionOf(["note", "甲"])).toBe(actionOf(["note", "乙"]));
    expect(actionOf(["note", "甲"])).toBe("note");
    expect(actionOf(["note", "甲"]), "但它与别的子命令仍然分得开").not.toBe(actionOf(["say", "甲"]));
  });

  it("判据 3：reading 的键进指纹、值不进——值是数据，改一个值不等于换了一件事", () => {
    expect(actionOf(["reading", "cli.sha.last", "abc"])).toBe(actionOf(["reading", "cli.sha.last", "def"]));
    expect(actionOf(["reading", "cli.sha.last", "abc"])).not.toBe(actionOf(["reading", "seam.dir-only.blocking", "abc"]));
  });
});
