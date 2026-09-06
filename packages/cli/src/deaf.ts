/**
 * t-102 (S7/T8): a node finds out by itself that it went deaf. `ateam watch` already keeps a heartbeat in
 * .ateam/watch.<me>.lock (t-049); when the environment kills the process, the heartbeat simply stops. Every
 * other command reads that file and, if the beat stopped longer ago than the listening window, says so once
 * in its own output. It is a word to this node only: no event, no log line, nothing the team sees — who is
 * not listening is already on the board (t-047/t-048).
 */
import { LISTEN_WINDOW_MS } from "@ateam/core";
import type { Lock } from "./lock.js";

export const DEFAULT_WATCH_CMD = "ateam watch --interval 25s";

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

function howLong(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${Math.max(m, 1)} 分钟`;
  const h = ms / 3_600_000;
  return h < 24 ? `${h.toFixed(1)} 小时` : `${(h / 24).toFixed(1)} 天`;
}

/** The one line, or null when there is nothing to say. Never mentions a heartbeat that is still beating. */
export function deafNotice(st: WatchState): string | null {
  if (st.kind === "never" || st.kind === "listening") return null;
  const when = st.kind === "stopped" ? `在 ${howLong(st.sinceMs)}前停了` : "停了（心跳文件读不出来，说不出多久）";
  return `⚠ 你的监听${when}，期间可能漏了指令，重挂：${st.cmd}`;
}
