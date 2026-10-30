/**
 * t-292 判据 7 · 一次「报成失败、其实落库了」之后，提醒说的是 pd 定稿那句，而且不叫人重做。
 *
 * **真样本（qa 06:38）**：它发 `ateam ack 01M65R25…`，命令行打出 `fetch failed`；它按已经吃过的教训先去日志
 * 查它落没落——**落了，06:38:58**。随后故意重发一次，拿到 `already acked at 06:38:58`。
 *
 * 两个方向都错且错法相反：读的方向，解不出的 200 被报成成功；写的方向，落了的写入被报成失败。
 * **而「报成失败」的自然反应就是重发**——所以在一台不稳的服务器上重发是正确的反应，这条提醒不许把一个
 * 正确的反应说成一次多余的操作，也不许叫他再去做一遍（pd 06:42 的通则：**一句话的全部用意是「你不用做任何
 * 事」，它就不许以要人做一件事结尾**）。
 */
import { describe, it, expect } from "vitest";
import { readRefusal, refusalNotice, clearsAfterNotice, type Refusal } from "../src/rejected.js";
import { alreadyDoneNotice, ago } from "@ateam/core";

const NOW = new Date("2026-09-07T01:19:51.880Z");
const LANDED_AT = "2026-09-07T01:14:51.880Z";      // 五分钟前，正是 pd 举的那个例子
const base: Refusal = { at: NOW.toISOString(), rule: "ack", cmd: "ateam ack 01M65R25", what: "ack 01M65R25" };

const noticeFor = (r: Refusal) => refusalNotice(readRefusal(JSON.stringify(r)), NOW);

describe("t-292 判据 7 · 「已经办好了」那一类的提醒", () => {
  it("带时刻：说出相对与绝对两个，且一个字都不提重做", () => {
    const line = noticeFor({ ...base, already: { at: LANDED_AT } })!;
    expect(line, "pd 定稿那句的出处在 core，这里只核它被印出来").toContain(alreadyDoneNotice(ago(NOW.getTime() - Date.parse(LANDED_AT)), LANDED_AT));
    expect(line, "相对那半句要在").toContain("5 分钟前");
    expect(line, "绝对那串进括号，是去日志对账的钥匙").toContain(`（${LANDED_AT}）`);
    expect(line, "不许说没有落下去").not.toContain("没有落下去");
    expect(line, "不许给重做").not.toContain("重做：");
    expect(line, "不许以要人做一件事结尾（pd 06:42 通则）").not.toContain("--clear-refused");
  });

  it("说不出时刻：照实说说不出，并把原因写进那一句", () => {
    const line = noticeFor({ ...base, already: { at: null } })!;
    expect(line).toContain("我说不出是什么时候");
    expect(line, "没有时刻就不许编一个").not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(line).not.toContain("重做：");
  });

  /** 反面：**没带 already 的那一类不许被说成「已经办好了」**——那会让人不去重做一件真没落下去的事。 */
  it("没带 already：仍然说没有落下去、仍然给重做", () => {
    const line = noticeFor(base)!;
    expect(line).toContain("没有落下去");
    expect(line).toContain("重做：");
    expect(line).not.toContain("已经办好了");
  });

  it("「已经办好了」那一类说完就退场，不劳人动手", () => {
    expect(clearsAfterNotice(readRefusal(JSON.stringify({ ...base, already: { at: LANDED_AT } })))).toBe(true);
    expect(clearsAfterNotice(readRefusal(JSON.stringify(base))), "真没落下去的那一类要留着").toBe(false);
  });
});
