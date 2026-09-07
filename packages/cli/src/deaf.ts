/**
 * t-102 (S7/T8): a node finds out by itself that it went deaf. `ateam watch` already keeps a heartbeat in
 * .ateam/watch.<me>.lock (t-049); when the environment kills the process, the heartbeat simply stops. Every
 * other command reads that file and, if the beat stopped longer ago than the listening window, says so once
 * in its own output. It is a word to this node only: no event, no log line, nothing the team sees — who is
 * not listening is already on the board (t-047/t-048).
 */
import { LISTEN_WINDOW_MS, WATCH_INTERVAL, ago, span, WATCH_LINES } from "@ateam/core";
import type { Lock } from "./lock.js";

/**
 * t-139, then t-145: the interval this suggests is the CLI's own default, taken from the one constant that decides it
 * (core's WATCH_INTERVAL). It used to be typed here, and typed again in the manual, and again in the help text — four
 * places holding three different numbers, and a reminder teaching a rate the CLI did not use.
 */
export const DEFAULT_WATCH_CMD = `ateam watch --interval ${WATCH_INTERVAL}`;

export type WatchState =
  /** No lock file: this node never started a watch in this checkout, or stopped one on purpose. Say nothing. */
  | { kind: "never" }
  /** The beat is inside the window: the watch is alive. */
  | { kind: "listening" }
  /** The beat stopped: it ran and is gone. */
  | { kind: "stopped"; sinceMs: number; cmd: string }
  /** The file is there but unreadable: it ran, but we cannot say when it stopped. */
  | { kind: "unreadable"; cmd: string };

/** `raw` is the file's contents, or null when there is no file. Pure: no fs, no clock of its own. */
export function watchState(raw: string | null, now: Date, windowMs = LISTEN_WINDOW_MS): WatchState {
  if (raw === null) return { kind: "never" };
  let lock: Partial<Lock> | null = null;
  try { lock = JSON.parse(raw) as Partial<Lock>; } catch { lock = null; }
  const cmd = typeof lock?.cmd === "string" && lock.cmd.trim() ? lock.cmd.trim() : DEFAULT_WATCH_CMD;
  const at = typeof lock?.at === "string" ? Date.parse(lock.at) : NaN;
  if (!lock || typeof lock !== "object" || Number.isNaN(at)) return { kind: "unreadable", cmd };
  const sinceMs = now.getTime() - at;
  if (sinceMs <= windowMs) return { kind: "listening" };
  return { kind: "stopped", sinceMs, cmd };
}

// t-180（qa 09:36 判出的第五道梯子）：这里曾经自己有一份 howLong——四舍五入、带小数、说不出「刚刚」，
// 与 core 的梯子在 99.6% 的时刻说法不同。它没被那条按词扫的检查抓到，是因为它只吐「1.3 小时」，
// 「前」由调用方拼上——按词找和按名字找是同一个毛病。现在两个调用点分别用 core 的 ago 与 span。

/** The one line, or null when there is nothing to say. Never mentions a heartbeat that is still beating. */
export function deafNotice(st: WatchState): string | null {
  if (st.kind === "never" || st.kind === "listening") return null;
  // t-162：句子搬到 core 的 WATCH_LINES 一处，这里只把数据递进去。
  // pd 09:17 的句框规矩仍然成立（时间短语在句首，四档都得通顺），那条规矩现在写在 core 那一处。
  return st.kind === "stopped" ? WATCH_LINES.stopped(ago(st.sinceMs), st.cmd) : WATCH_LINES.unreadable(st.cmd);
}

/**
 * t-137: how long the *server* has gone without seeing this node pull, from the `x-ateam-pull-idle` header every
 * answer carries. `null` when the server did not say (an older service, or a command that made no request).
 */
export type PullIdle = { kind: "seconds"; s: number } | { kind: "never" } | null;

export function pullIdle(header: string | null | undefined): PullIdle {
  if (header === undefined || header === null || header === "") return null;
  if (header === "never") return { kind: "never" };
  const s = Number(header);
  return Number.isFinite(s) && s >= 0 ? { kind: "seconds", s } : null;
}

/**
 * t-137: the second way of not listening, which nothing used to say. Your heartbeat is beating — the watch process is
 * alive — and the server has still not seen you pull. Its remedy is not the other one's: re-arming a watch that never
 * stopped fixes nothing; what you need is to go and read what you missed.
 */
export function behindNotice(idle: PullIdle, windowMs = LISTEN_WINDOW_MS): string | null {
  if (!idle) return null;
  if (idle.kind === "never") return WATCH_LINES.neverPulled;
  if (idle.s * 1000 <= windowMs) return null;
  // 这一句说的是时长不是时刻（「你 12 分钟没拉过了」），所以用 span，不是 ago——同一道梯子，另一个句框。
  return WATCH_LINES.behind(span(idle.s * 1000));
}

/**
 * Both kinds, in one place, never merged into one (t-137 判据 3). They have different causes and opposite remedies:
 * a stopped watch is re-armed, a lagging cursor is caught up. When the watch has stopped, the cursor stopped moving
 * *because of that* — so only the line with the remedy is said, rather than the same news twice in two voices.
 */
export function listeningNotices(st: WatchState, idle: PullIdle, windowMs = LISTEN_WINDOW_MS): string[] {
  const deaf = deafNotice(st);
  if (deaf) return [deaf];
  const behind = behindNotice(idle, windowMs);
  return behind ? [behind] : [];
}
