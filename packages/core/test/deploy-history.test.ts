/**
 * t-211（qa 16:11 在生产上判 fail）：**上线名单这一栏后面要交给 git 去问，所以进来之前先问一句「它长得像个 sha 吗」。**
 *
 * 生产上那两条坏数据是真的：
 * ① 字符串 `unreported`——09-06 qa 写的，那时 `/health` 还没有 sha 字段，**当时对世界的描述没错**，
 *    但它进了一个后来被 git 消费的字段，于是此后每个节点每轮都被告知「你旧一次」，而那一次谁也追不上。
 * ② 一条写错的 sha，19 秒后本人已更正——**而更正被七位前缀去重当成「同一个 sha 又量了一遍」跳过了**。
 *
 * **这一组是注入逼出来的**：我先只改了代码，注入「非 sha 照收」时用例一条都没红——我又一次只测了
 * 「拿到名单之后怎么数」，没测「什么进得了这份名单」。
 */
import { describe, it, expect } from "vitest";
import { reduce, deployHistory, type Event } from "../src/index.js";

const A = "a".repeat(40), B = "b".repeat(40);
let n = 0;
const id = () => `01M${String(++n).padStart(23, "0")}`;

/**
 * **直接造事件喂给 reduce，不走 append**：`production:deployed.sha` 今天有形状闸（t-024，
 * `/^([0-9a-f]{7,40}|unknown)$/`），`unreported` 此刻根本写不进去。**而日志里那条是 09-06 写的，
 * 早于那道闸**——历史数据不会因为后来加了闸就消失，它每天仍被读进上线名单。
 */
const history = (values: unknown[]) => {
  const evs: Event[] = [{ kind: "reading", id: id(), actor: "pm", at: "2026-09-06T00:00:00.000Z", surface: "project", key: "roles", value: ["pm", "dev"] } as unknown as Event];
  for (const v of values) {
    evs.push({ kind: "reading", id: id(), actor: "release", at: `2026-09-06T00:${String(evs.length).padStart(2, "0")}:00.000Z`, surface: "production", key: "deployed.sha", value: v, writes: ["production:deployed.sha"] } as unknown as Event);
  }
  return deployHistory(reduce({ events: evs, cursors: [], deliveries: [] }));
};

describe("t-211 · 什么进得了上线名单", () => {
  it("**不是 sha 的值不是一次上线**：`unreported` 不进名单（09-06 写下的那条，形状闸之前）", () => {
    expect(history(["unreported", A]).map((d) => d.sha)).toEqual([A]);
  });

  it("`unknown` 也不进——**它今天还能写进来**（形状闸放它过），而它同样不是一个 git 问得出的对象", () => {
    expect(history(["unknown", A]).map((d) => d.sha)).toEqual([A]);
  });

  it("七位缩写进得来（人手工粘的常是缩写），它确实是一个 sha", () => {
    expect(history(["abc1234", A]).map((d) => d.sha)).toEqual(["abc1234", A]);
  });

  it("同一个 sha 量两次仍然算一次上线——这一半没变", () => {
    expect(history([A, A, B]).map((d) => d.sha)).toEqual([A, B]);
  });

  it("大写与带前后缀的一律不算——**这一栏的每一个值都要能直接喂给 git**", () => {
    expect(history(["DEADBEEF1234", "sha=abc1234", A]).map((d) => d.sha)).toEqual([A]);
  });
});

/**
 * t-230 判据 2：**一次更正不许再被当成重复吞掉。**
 *
 * 真数据：human 09-06 07:29:48 写下 `085624dd6a…`，**19 秒后自己用「curl /health 原样粘贴」改成
 * `085624d04c…`**。两者前七位都是 `085624d`，旧规则把后写的那条当成「同一个 sha 又量了一遍」跳过——
 * **于是牌桌留下了错的那一条、丢掉了对的那一条**，此后每个节点每轮都被告知「你旧一次」，而那一次谁也追不上。
 */
describe("t-230 · 更正取代，重复仍然算一次", () => {
  const TYPO = "085624dd6a9c" + "0".repeat(28), FIXED = "085624d04c" + "1".repeat(30);

  it("**那一对真数据**：后写的取代先写的，仍然只算一次上线", () => {
    const out = history([TYPO, FIXED]);
    expect(out).toHaveLength(1);
    expect(out[0].sha, "留下的是更正后的那个").toBe(FIXED);
  });

  it("同一个 sha 的长短两种写法：留更长的那个，也只算一次", () => {
    const out = history(["085624d", FIXED]);
    expect(out).toHaveLength(1);
    expect(out[0].sha).toBe(FIXED);
  });

  it("更正之后又真上了一次别的：那一次照常是新的一条", () => {
    const out = history([TYPO, FIXED, A]);
    expect(out.map((d) => d.sha)).toEqual([FIXED, A]);
  });

  it("前七位不同的两条照旧是两次上线——这条规则没被放宽", () => {
    expect(history([A, B]).map((d) => d.sha)).toEqual([A, B]);
  });
});
