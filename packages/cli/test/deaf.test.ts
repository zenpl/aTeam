/**
 * t-102 (S7/T8): a node finds out by itself that it went deaf. Today's two team-wide stalls (10.4 hours) both
 * started with a watch the environment killed: t-046 stopped `watch` from exiting on its own, but nothing
 * covered the half where the process is killed from outside. All times relative; no absolute timestamp.
 */
import { describe, it, expect } from "vitest";
import { watchState, deafNotice, DEFAULT_WATCH_CMD } from "../src/deaf.js";

const NOW = new Date(Date.parse("2026-09-06T12:00:00Z"));
const min = (n: number) => n * 60_000;
const beat = (agoMs: number, cmd?: string) => JSON.stringify({ pid: 4242, at: new Date(NOW.getTime() - agoMs).toISOString(), ...(cmd ? { cmd } : {}) });
const state = (raw: string | null) => watchState(raw, NOW, min(5));
const notice = (raw: string | null) => deafNotice(state(raw));

describe("t-102 · a node notices its own watch died", () => {
  it("fresh heartbeat: the watch is alive, so nothing is said", () => {
    expect(state(beat(min(1)))).toEqual({ kind: "listening" });
    expect(notice(beat(min(1)))).toBeNull();
    expect(notice(beat(min(5)))).toBeNull();      // exactly at the window is still listening
  });

  it("stale heartbeat: says how long ago it stopped and the command to re-run, verbatim as it was started", () => {
    const raw = beat(min(34), "ateam watch --interval 25s");
    expect(state(raw)).toEqual({ kind: "stopped", sinceMs: min(34), cmd: "ateam watch --interval 25s" });
    const line = notice(raw)!;
    expect(line).toContain("你的监听在 34 分钟前停了");
    expect(line).toContain("期间可能漏了指令");
    expect(line).toContain("重挂：ateam watch --interval 25s");
    // 今天真实的两次停摆量级：小时，不是「312 分钟」
    expect(notice(beat(min(312)))).toContain("你的监听在 5.2 小时前停了");
    expect(notice(beat(min(2 * 24 * 60)))).toContain("2.0 天前");
    // 老的心跳文件没有 cmd：仍要给一条能照抄的命令
    expect(notice(beat(min(30)))).toContain(`重挂：${DEFAULT_WATCH_CMD}`);
  });

  it("no heartbeat file: never started a watch here, so it is not nagged (判据 4)", () => {
    expect(state(null)).toEqual({ kind: "never" });
    expect(notice(null)).toBeNull();
  });

  it("a corrupt heartbeat file: it did run, so it is told — but not told a duration nobody measured", () => {
    for (const raw of ["", "{", "null", '{"pid":4242}', '{"pid":4242,"at":"不是时间"}']) {
      const line = notice(raw);
      expect(line, raw).not.toBeNull();
      expect(line, raw).toContain("重挂：");
      expect(line, raw).not.toMatch(/\d+ (分钟|小时|天)前停了/);   // 没量过的事不编一个数字
      expect(line, raw).toContain("说不出多久");
    }
    expect(state('{"pid":4242,"at":"不是时间","cmd":"ateam watch --interval 10s"}')).toEqual({ kind: "unreadable", cmd: "ateam watch --interval 10s" });
  });

  it("the reminder is for this node only: it is one line of text, and produces no event", () => {
    const line = notice(beat(min(30)))!;
    expect(line.split("\n")).toHaveLength(1);
    expect(watchState).toHaveLength(2);                       // pure: (raw, now[, windowMs]) — no store, no client
    expect(deafNotice).toHaveLength(1);
  });
});
