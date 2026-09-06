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
 */
export function ulidAt(ms: number): string {
  return encodeTime(ms, 10) + Array.from(randomBytes(16), (b) => ALPHABET[b % 32]).join("");
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
