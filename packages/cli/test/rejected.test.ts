/**
 * t-116 (S7): a refused write is visible for one second — the moment it happens. At 01:11 dev read a successful `tell`
 * and told two people a task was done; the `done` had been refused by the seam gate seconds earlier. Nothing connected
 * the refusal to the two "it's finished" messages that followed it.
 */
import { describe, it, expect } from "vitest";
import { readRefusal, refusalNotice, clearsAfterNotice, actionOf, type Refusal } from "../src/rejected.js";

const NOW = new Date(Date.parse("2026-09-07T01:20:00Z"));
const min = (n: number) => n * 60_000;
const record = (agoMs: number, over: Partial<Refusal> = {}): string =>
  JSON.stringify({ at: new Date(NOW.getTime() - agoMs).toISOString(), rule: "seam", cmd: "ateam task done t-113 --evidence \"…\"", what: "task done t-113", ...over });
const notice = (raw: string | null) => refusalNotice(readRefusal(raw), NOW);

describe("t-116 · a refusal is said again on the next turn", () => {
  it("dev 01:11 那一幕：done 被接缝闸拒了，下一条 sync 就说出来", () => {
    const line = notice(record(min(9)))!;
    expect(line).toContain("9 分钟前有一次写入被拒（seam）");
    expect(line).toContain("task done t-113 没有落下去");                     // 哪个动作
    expect(line).toContain('重做：ateam task done t-113 --evidence "…"');      // 原样重做
    expect(line).toContain("划掉：ateam sync --clear-refused");                // 明确划掉的办法
  });

  it("从没被拒过的节点不提示；被拒过又重做成功的也不提示（判据 3）", () => {
    expect(readRefusal(null)).toEqual({ kind: "clean" });
    expect(notice(null)).toBeNull();
    expect(notice("")).toBeNull();                                            // 记录被划掉后留下的空文件
  });

  it("记录损坏时说得出「有过一次」，但不编一个说不出的规则名", () => {
    for (const raw of ["{", "null", "[]", '{"rule":"seam"}', '{"at":"不是时间","rule":"seam","cmd":"x","what":"y"}']) {
      const line = notice(raw);
      expect(line, raw).toContain("你上一次被拒的写入记坏了，说不出是哪一条");
      expect(line, raw).toContain("ateam sync --clear-refused");
      expect(line, raw).not.toMatch(/\d+ 分钟前/);                            // 没量过的事不编一个数字
    }
  });

  it("时长按量级说，不是一律「N 分钟」", () => {
    // t-180 · pd 09:09：这一行过去有自己一份梯子（叫 howLong，所以按 `ago` 去搜找不到它），
    // 会说「1.5 小时前」「1.1 天前」。四档全项目一处、向下取整、不出现小数之后是下面这些。
    expect(notice(record(20_000))).toContain("你刚刚有一次写入被拒");
    expect(notice(record(min(59)))).toContain("59 分钟前");
    expect(notice(record(min(90)))).toContain("1 小时前");
    expect(notice(record(min(60 * 26)))).toContain("1 天前");
    for (const m of [1, 59, 90, 60 * 26, 60 * 24 * 400]) expect(notice(record(min(m)))).not.toMatch(/\d\.\d/);
  });

  it("划掉只认同一个动作：重做 claim 不该划掉一条被拒的 done", () => {
    expect(actionOf(["task", "done", "t-113", "--evidence", "…"])).toBe("task done t-113");
    expect(actionOf(["task", "claim", "t-113", "--touches", "a.ts"])).toBe("task claim t-113");
    expect(actionOf(["task", "done", "t-113"])).not.toBe(actionOf(["task", "claim", "t-113"]));
    expect(actionOf(["sync"])).toBe("sync");
    expect(actionOf(["reading", "roles", "{...}", "--surface", "project"])).toBe("reading roles {...}");
  });

  it("提醒是给本人的一行字：没有事件、没有日志，纯函数只看记录与时间", () => {
    expect(notice(record(min(3)))!.split("\n")).toHaveLength(1);
    expect(refusalNotice).toHaveLength(2);   // (state, now[, clearWith]) — 没有 store、没有 client
    expect(readRefusal).toHaveLength(1);
  });
});

/**
 * t-233：**一次拒绝有两种意思，而提醒只印一种，还叫人重做。**
 *
 * 真样本是 qa 16:55 那次：拒绝话逐字写着「already acked at 16:54:51.880Z」——**那件事其实已经办好了**，
 * 而这份提醒照旧说「没有落下去」，还给出「重做：<原命令>」。重做一次只会再被拒一次。
 */
describe("t-233 · 两类拒绝，提醒各说各的", () => {
  const done = (over: Partial<Refusal> = {}) => record(min(5), { rule: "ack", cmd: "ateam ack 01M2B", what: "ack 01M2B", already: { at: "2026-09-07T01:14:51.880Z" }, ...over });

  it("「已经办好了」那一类：不说「没有落下去」，不给「重做」，并把它发生的时刻印出来（判据 1、3）", () => {
    const line = notice(done())!;
    expect(line).not.toContain("没有落下去");
    expect(line).not.toContain("重做：");
    expect(line).not.toContain("ateam ack 01M2B");          // 那条命令不该再出现在这里：再跑一次只会再被拒一次
    expect(line).toContain("2026-09-07T01:14:51.880Z");
    expect(line).toContain("不用重做");
    expect(line).toContain("ateam sync --clear-refused");     // 自己划的办法还在
  });

  it("说不出时刻时不编一个：说「已经办过了」，其余照旧（缺席与空要分得开）", () => {
    const line = notice(done({ already: { at: null } }))!;
    expect(line).toContain("已经办过了");
    expect(line).not.toMatch(/20\d\d-/);
    expect(line).not.toContain("重做：");
  });

  it("另一类一个字没变：照旧说「没有落下去」、照旧给「重做」", () => {
    const line = notice(record(min(9)))!;
    expect(line).toContain("没有落下去");
    expect(line).toContain("重做：");
  });

  it("类别记坏了就是「没带类别」，按另一类处理——**不许把一件真没落下去的事说成已经办好了**", () => {
    for (const bad of ['{"at": 5}', '{"when":"x"}', '"已经办了"', "[]", "null"]) {
      const line = notice(record(min(5), { already: JSON.parse(bad) as never }))!;
      expect(line, bad).toContain("没有落下去");
    }
  });

  it("「已经办好了」那一类说完就划掉：它没有「重做一次就消失」这条出路", () => {
    expect(clearsAfterNotice(readRefusal(done()))).toBe(true);
    expect(clearsAfterNotice(readRefusal(record(min(9))))).toBe(false);
    expect(clearsAfterNotice({ kind: "clean" })).toBe(false);
    expect(clearsAfterNotice({ kind: "unreadable" })).toBe(false);
  });
});
