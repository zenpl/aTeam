import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * Lexicographically sortable, time-ordered, monotonic within a process:
 * two ids minted in the same millisecond still sort in minting order.
 * The log is ordered by id, so this is what makes "append order" meaningful.
 */
/**
 * An id whose time bits are exactly `ms`, with a fresh random tail: for building a log at chosen times (t-062), where
 * the process-wide monotonic guard would otherwise carry a later time forward. Not for a live server.
 *
 * t-278：**同一毫秒里连造两个的时候，它们之间也要排得出先后。** 上一版每次都换一条全新的随机尾巴，于是
 * 同一毫秒的两条按 id 排序是随机的——而日志是按 id 排序的，「append 顺序」这句话就不成立了。`ulid` 早就
 * 有这道保险（同一毫秒把随机部分加一），`ulidAt` 没有；样本以前每步隔 1 秒，所以这个洞一直没被踩到，直到
 * 服务在同一刻连发两张卡：built 与 served 两边同一对事件排出了相反的顺序，t-062 因此**时红时绿**
 * （单独跑绿、整包跑红，取决于别的用例把进程里的随机数推到了哪儿）。
 * 时间位仍然逐字是 `ms`，只是同一毫秒里第二条起在前一条的尾巴上加一。
 */
let lastAtMs = -1;
let lastAtRandom: number[] = [];
export function ulidAt(ms: number): string {
  if (ms === lastAtMs) {
    for (let i = lastAtRandom.length - 1; i >= 0; i--) {
      if (lastAtRandom[i] < 31) { lastAtRandom[i]++; break; }
      lastAtRandom[i] = 0;
    }
  } else {
    lastAtMs = ms;
    lastAtRandom = Array.from(randomBytes(16), (b) => b % 32);
  }
  return encodeTime(ms, 10) + lastAtRandom.map((x) => ALPHABET[x]).join("");
}

export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    now = lastTime;
    // increment the 80-bit random part
    for (let i = lastRandom.length - 1; i >= 0; i--) {
      if (lastRandom[i] < 31) { lastRandom[i]++; break; }
      lastRandom[i] = 0;
    }
  } else {
    lastTime = now;
    const bytes = randomBytes(16);
    lastRandom = Array.from(bytes, (b) => b % 32);
  }
  return encodeTime(now, 10) + lastRandom.map((v) => ALPHABET[v]).join("");
}
