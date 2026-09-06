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
