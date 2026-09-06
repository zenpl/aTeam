/**
 * t-049: one watch per identity per checkout. A second one is refused while the first is alive and beating.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blockingLock, writeLock, readLock, removeLock } from "../src/lock.js";

const withDir = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "ateam-lock-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const min = (n: number) => n * 60_000;

describe("t-049 · watch lock", () => {
  it("no lock: may start; a fresh lock of a live pid blocks; the same lock is stale after 3 intervals or when the pid is dead", () => withDir((dir) => {
    const path = join(dir, ".ateam", "watch.dev.lock");
    const t0 = new Date(0 + min(60));
    expect(blockingLock(path, t0, min(1), () => true)).toBeNull();
    writeLock(path, 4242, t0);
    expect(readLock(path)).toEqual({ pid: 4242, at: t0.toISOString() });
    expect(blockingLock(path, new Date(t0.getTime() + min(2)), min(3), () => true)).toEqual({ pid: 4242, at: t0.toISOString() });
    expect(blockingLock(path, new Date(t0.getTime() + min(4)), min(3), () => true)).toBeNull();   // heartbeat too old
    expect(blockingLock(path, new Date(t0.getTime() + min(1)), min(3), () => false)).toBeNull();  // pid gone
  }));

  it("a heartbeat refreshes the lock; removal only by the pid that holds it; garbage in the file does not block", () => withDir((dir) => {
    const path = join(dir, ".ateam", "watch.dev.lock");
    const t0 = new Date(min(60));
    writeLock(path, 1, t0);
    writeLock(path, 1, new Date(t0.getTime() + min(5)));
    expect(blockingLock(path, new Date(t0.getTime() + min(6)), min(3), () => true)).toMatchObject({ pid: 1 });
    removeLock(path, 2);
    expect(existsSync(path)).toBe(true);
    removeLock(path, 1);
    expect(existsSync(path)).toBe(false);
    writeLock(path, 7, t0);
    require("node:fs").writeFileSync(path, "not json");
    expect(blockingLock(path, t0, min(3), () => true)).toBeNull();
  }));
});
