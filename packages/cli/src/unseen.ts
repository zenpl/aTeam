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

/**
 * t-290／t-293：**这一叠里还有另一种行：我们对人说的话。** 它们不算进那个数。
 *
 * pd 07:39 定的口径，pm 07:35 批了：**一个数只许数一种东西。** 「还没人看过的」数的是日志里的事件；
 * 通知是我们对人说的话，不是日志里的事件。两者混在一个数里之后，人拿那个数做的判断（我落下了多少）
 * 就不再对应那个数算的东西（屏幕上有多少行）。
 *
 * 这不是一条新加的洁癖：`UNSEEN_DROPPED` 那一行从一开始就是通知，而它一直被数进去。
 *
 * 落盘的形状：事件照旧是一个 JSON 字符串（**老文件一个字节不用动**），通知是 `{"notice": "…"}`。
 */
export function stashNotice(dir: string, me: string, lines: readonly string[]): void {
  if (!lines.length) return;
  mkdirSync(join(dir, ".ateam"), { recursive: true });
  appendFileSync(unseenFile(dir, me), lines.map((l) => JSON.stringify({ notice: l })).join("\n") + "\n");
}

/** 一叠里的两种行，按落盘顺序各自成一串。坏掉的行跳过——一行读不动不该让整叠都印不出来。 */
export function unseenRows(dir: string, me: string): { notices: string[]; events: string[] } {
  const out = { notices: [] as string[], events: [] as string[] };
  try {
    const p = unseenFile(dir, me);
    if (!existsSync(p)) return out;
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        const v = JSON.parse(raw) as unknown;
        if (typeof v === "string") out.events.push(v);
        else if (v && typeof v === "object" && typeof (v as { notice?: unknown }).notice === "string") out.notices.push((v as { notice: string }).notice);
      } catch { /* 跳过这一行 */ }
    }
  } catch { /* 同上 */ }
  return out;
}

/**
 * 这个节点此刻攒着多少行没人看过的**事件**。通知不算（`unseenRows().notices` 另给）——
 * 这个函数的返回值就是那个数的分母，所以它只许数一种东西。
 */
export const unseenLines = (dir: string, me: string): string[] => unseenRows(dir, me).events;

/** 印完了才清——**与游标同一条规矩**：交付之后才算给出去了（t-240）。 */
export function clearUnseen(dir: string, me: string): void {
  try { rmSync(unseenFile(dir, me), { force: true }); } catch { /* 同上 */ }
}

/** 只留最后 `max` 行：没人来看的那几天里，这个文件不该一直长。丢掉多少会被说出来（`droppedLine`）。 */
export function capUnseen(dir: string, me: string, max: number): number {
  try {
    const { notices, events } = unseenRows(dir, me);
    if (events.length <= max) return 0;
    const keep = events.slice(events.length - max);
    // 通知一条都不丢：上限管的是事件那一串（它是会长的那一串），而通知说的是「这一叠本身出了什么事」。
    const rows = [...notices.map((n) => JSON.stringify({ notice: n })), ...keep.map((l) => JSON.stringify(l))];
    writeFileSync(unseenFile(dir, me), rows.join("\n") + "\n");
    return events.length - max;
  } catch { return 0; }
}
