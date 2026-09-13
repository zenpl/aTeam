/**
 * t-245：**`sync --quiet` 会把那一批吃掉。**
 *
 * `--quiet` 的原意是心跳：拉一次、不吵人、让服务看见这个节点还在。可它拉到的那一批**没有任何人看过**，
 * 而游标照样往前走——于是那一批对这个节点永久消失，之后每次 sync 都诚实地说「nothing new」。
 * 这是 t-240 那道缝的另一条路：那一件修的是「印之前死掉」，这一条是**从一开始就没人打算印**。
 *
 * 修法不是让 `--quiet` 不吵人却也不前进（那会让心跳每次重拉同一批、越拉越大），而是**把那一批落到这里**：
 * 它是这个节点自己的「拉到了、还没人看过」的那一叠。下一次真去看的时候（不带 `--quiet` 的 sync）先印它、
 * 再清掉。**交付的定义没有变**，变的只是「交给谁」：这一次交给磁盘，人来看的时候再交给人。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const unseenFile = (dir: string, me: string): string => join(dir, ".ateam", `unseen.${me}.jsonl`);

/**
 * 落一批没人看过的行。**写不下去就抛**——qa 22:21 判 fail 指的正是这里：第一版把写失败默默吞了，
 * 而调用方在它之后才推进游标，于是**磁盘写不进时，`sync --quiet` 退 0、一声不吭，那一批照样消失**。
 * 这一叠就是 `--quiet` 那一路的「交付」；交付失败不许被当成交付成功——**与游标同一条规矩（t-240）**：
 * 落成了，才算给出去了。
 */
export function stashUnseen(dir: string, me: string, lines: readonly string[]): void {
  if (!lines.length) return;
  mkdirSync(join(dir, ".ateam"), { recursive: true });
  appendFileSync(unseenFile(dir, me), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** 这个节点此刻攒着多少行没人看过的。坏掉的行跳过——一行读不动不该让整叠都印不出来。 */
export function unseenLines(dir: string, me: string): string[] {
  try {
    const p = unseenFile(dir, me);
    if (!existsSync(p)) return [];
    const out: string[] = [];
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try { const v = JSON.parse(raw) as unknown; if (typeof v === "string") out.push(v); } catch { /* 跳过这一行 */ }
    }
    return out;
  } catch { return []; }
}

/** 印完了才清——**与游标同一条规矩**：交付之后才算给出去了（t-240）。 */
export function clearUnseen(dir: string, me: string): void {
  try { rmSync(unseenFile(dir, me), { force: true }); } catch { /* 同上 */ }
}

/** 只留最后 `max` 行：没人来看的那几天里，这个文件不该一直长。丢掉多少会被说出来（`droppedLine`）。 */
export function capUnseen(dir: string, me: string, max: number): number {
  try {
    const lines = unseenLines(dir, me);
    if (lines.length <= max) return 0;
    const keep = lines.slice(lines.length - max);
    writeFileSync(unseenFile(dir, me), keep.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return lines.length - max;
  } catch { return 0; }
}
