/**
 * t-049: one watch per identity per checkout. Two watches sharing .ateam/cursor.<me> overwrite each other's
 * cursor and replay old instructions. The lock is a small JSON file with the pid and a heartbeat; a heartbeat
 * older than `staleMs` (3 intervals) or a dead pid means the previous watch is gone.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** `cmd` (t-102) is what to re-run when this watch turns out to be gone; older locks have none. */
export interface Lock { pid: number; at: string; cmd?: string }

export function readLock(path: string): Lock | null {
  try { return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Lock) : null; } catch { return null; }
}

export function writeLock(path: string, pid: number, now = new Date(), cmd?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, at: now.toISOString(), ...(cmd ? { cmd } : {}) }));
}

export function removeLock(path: string, pid: number): void {
  const l = readLock(path);
  if (l && l.pid === pid) { try { unlinkSync(path); } catch { /* already gone */ } }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Null when a watch may start; otherwise the lock that stands in the way (alive pid and fresh heartbeat). */
export function blockingLock(path: string, now: Date, staleMs: number, isAlive: (pid: number) => boolean = processAlive): Lock | null {
  const l = readLock(path);
  if (!l || typeof l.pid !== "number" || typeof l.at !== "string") return null;
  if (now.getTime() - Date.parse(l.at) > staleMs) return null;
  if (!isAlive(l.pid)) return null;
  return l;
}
