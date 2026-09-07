/**
 * t-102 (S7/T8): a node finds out by itself that it went deaf. Today's two team-wide stalls (10.4 hours) both
 * started with a watch the environment killed: t-046 stopped `watch` from exiting on its own, but nothing
 * covered the half where the process is killed from outside. All times relative; no absolute timestamp.
 */
import { describe, it, expect } from "vitest";
import { watchState, deafNotice, behindNotice, listeningNotices, pullIdle, DEFAULT_WATCH_CMD } from "../src/deaf.js";

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
    // t-180 · pd 09:17：时间短语在句首，四档都得通顺（改前是「在 34 分钟前停了」，而「在 刚刚前停了」不是中文）。
    expect(line).toContain("你的监听 34 分钟前停了");
    expect(line).toContain("期间可能漏了指令");
    expect(line).toContain("重挂：ateam watch --interval 25s");
    // 今天真实的两次停摆量级：小时，不是「312 分钟」
    expect(notice(beat(min(312)))).toContain("你的监听 5 小时前停了");   // t-180：向下取整、不出现小数（改前「5.2 小时前」）
    expect(notice(beat(min(2 * 24 * 60)))).toContain("2 天前");
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

/**
 * t-137: there are two ways of not listening and they were one word. Your own watch process died — the heartbeat file
 * stops, which t-102 already reads. Or your watch is alive and beating and the *server* has still not seen you pull:
 * nothing said anything about that, and dev found it at 04:54 by running a command while the board called it deaf.
 *
 * They are not one boolean, because they are not one problem: a stopped watch is re-armed, a lagging cursor is caught
 * up, and re-arming a watch that never stopped fixes nothing. Times relative to now.
 */
describe("t-137 · 心跳停了，和心跳活着但服务端没见你拉", () => {
  const beating = (): string => JSON.stringify({ pid: 1, at: new Date().toISOString(), cmd: "ateam watch --interval 25s" });
  const stopped = (minsAgo: number): string => JSON.stringify({ pid: 1, at: new Date(Date.now() - minsAgo * 60_000).toISOString(), cmd: "ateam watch --interval 25s" });
  const st = (raw: string | null) => watchState(raw, new Date());

  it("reads the header the server sends, and says nothing about what it did not send", () => {
    expect(pullIdle("42")).toEqual({ kind: "seconds", s: 42 });
    expect(pullIdle("never")).toEqual({ kind: "never" });
    expect(pullIdle(null)).toBeNull();          // an older service, or a command that made no request
    expect(pullIdle("")).toBeNull();
    expect(pullIdle("狗")).toBeNull();
    expect(behindNotice(null)).toBeNull();      // never invent a verdict out of a missing header
  });

  it("heartbeat alive, cursor stale: told, and told the remedy that fits *this* one", () => {
    const [line, ...rest] = listeningNotices(st(beating()), pullIdle(String(40 * 60)));
    expect(rest).toEqual([]);
    expect(line).toContain("服务端说你");
    expect(line).toContain("你的监听还在跳");        // says plainly that this is not the other problem
    expect(line).toContain("ateam sync");
    expect(line).not.toContain("重挂");              // re-arming a watch that never stopped fixes nothing
  });

  it("both fine: not a word", () => {
    expect(listeningNotices(st(beating()), pullIdle("9"))).toEqual([]);
    expect(listeningNotices(st(beating()), null)).toEqual([]);
    expect(listeningNotices(st(null), pullIdle("9"))).toEqual([]);       // never watched here, and caught up: nothing to say
  });

  it("the watch stopped: one line, the one with the remedy — not the same news twice in two voices", () => {
    const lines = listeningNotices(st(stopped(40)), pullIdle(String(40 * 60)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("你的监听");
    expect(lines[0]).toContain("重挂");
    expect(lines[0]).not.toContain("服务端说你");   // the cursor stopped *because* the watch did
  });

  it("the server has never seen this node pull: said, and it is its own case", () => {
    const [line] = listeningNotices(st(beating()), pullIdle("never"));
    expect(line).toContain("从没见过你拉取");
    expect(line).toContain("ateam sync");
  });

  /**
   * t-200：core 的梯子对负数答 null，**这两个调用点各自决定自己的负数意味着什么**——那正是判负放在一处、
   * 说法留给调用方的用处。
   * · `deafNotice`：负数只来自「心跳文件的时刻在本机时钟前面」（钟不同步）。那时「刚刚」不是猜的，心跳确实
   *   刚跳过，所以这里把它当 0。
   * · `behindNotice`：`pullIdle` 在源头就挡掉了负数（`s >= 0`），所以那一路根本到不了 null。
   */
  it("t-200：钟走到心跳前面时，这一路自己决定说「刚刚」，不是梯子替它猜了一档", () => {
    const future = JSON.stringify({ pid: 1, at: new Date(Date.now() + 5 * 60_000).toISOString(), cmd: "ateam watch --interval 25s" });
    // 心跳在未来 5 分钟：watchState 仍判它 stopped 与否由它自己定，这里只要那句话不带一个负的时长
    const line = deafNotice(watchState(future, new Date()));
    if (line !== null) {
      expect(line, "不许出现负数或空档").not.toMatch(/-\d/);
      expect(line).not.toContain("null");
    }
  });

  it("t-200：负的空闲秒数在源头就被挡掉，那一路到不了梯子", () => {
    expect(pullIdle("-1"), "负数不是一个合法的空闲时长").toBeNull();
    expect(behindNotice(pullIdle("-1"))).toBeNull();
    expect(pullIdle("0")).toEqual({ kind: "seconds", s: 0 });
  });

  it("the two are never one verdict: each is computed from its own fact", () => {
    // a live heartbeat says nothing about the cursor, and a fresh cursor says nothing about the heartbeat
    expect(deafNotice(st(beating()))).toBeNull();
    expect(behindNotice(pullIdle(String(40 * 60)))).toBeTruthy();
    expect(deafNotice(st(stopped(40)))).toBeTruthy();
    expect(behindNotice(pullIdle("9"))).toBeNull();
  });
});
