/**
 * t-116 (S7): a refused write is visible for one second — the moment it happens. At 01:11 dev read a successful `tell`
 * and told two people a task was done; the `done` had been refused by the seam gate seconds earlier. Nothing connected
 * the refusal to the two "it's finished" messages that followed it.
 */
import { describe, it, expect } from "vitest";
import { readRefusal, refusalNotice, actionOf, type Refusal } from "../src/rejected.js";

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
    expect(notice(record(20_000))).toContain("你刚刚有一次写入被拒");
    expect(notice(record(min(90)))).toContain("1.5 小时前");
    expect(notice(record(min(60 * 26)))).toContain("1.1 天前");
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
