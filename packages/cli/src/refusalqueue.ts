/**
 * t-218：**这几种拒绝是命令行自己抛的，写入根本没发出去**——服务端那本账（t-212）数的是走到它面前的写入，
 * 于是 `decide.ts` 那四条、以及用法错的那几条，一次都没被数过：**它们只活在各人终端里。**
 *
 * 做法照判据 2 的第一条出路：**在下一次通信里捎给服务**。被拒的那一刻只往本地队列里追一行（那一刻很可能
 * 正没有网，或者正是网不通才被拒的），下一条跑通的命令把整队捎上去，服务端记完才划掉——**没捎成就还在队里**。
 *
 * 记的东西与 t-212 判据 1 同一口径：规则名、谁、哪种写入、什么时候，**不存被拒的正文**（那里可能是没落地的
 * 内容，存下来等于让被拒的东西从后门进了日志）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliRefusalOp, cliRefusalDropped, CLI_REFUSAL_OVERFLOW, ulid, type Refused } from "@ateam/core";

/**
 * 队里最多留这么多条。**上限是必须的**：没人跑命令的那几天里这个文件不该一直长。
 * 超了就扔最旧的，**而扔掉这件事自己变成队里的一条**（规则名 `cli-queue-overflow`，op 里写着扔了几条）——
 * 一本会悄悄变小的账，与一本看起来是全集的账是同一个病。
 */
export const QUEUE_MAX = 500;

export const refusalQueueFile = (dir: string, me: string): string => join(dir, ".ateam", `refused-queue.${me}.jsonl`);

/**
 * 被拒的是哪种写入：`cli task done`、`cli decide`。**只取命令词**——第三个词常常是任务 id 或人名，
 * 那已经是「谁被拒于哪一件」，不是「哪种写入」，而这本账按种类分组。
 */
export function cliOpOf(argv: string[]): string {
  const words = argv.filter((a) => !a.startsWith("-"));
  const head = words[0] ?? "";
  if (!head) return cliRefusalOp("?");
  return cliRefusalOp(head === "task" && words[1] ? `${head} ${words[1]}` : head);
}

/** 读队。坏掉的行跳过：一行读不动不该让整队捎不上去，也不该让命令失败。 */
export function readRefusalQueue(text: string | null): Refused[] {
  if (!text) return [];
  const out: Refused[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as Partial<Refused>;
      if (typeof r?.id === "string" && typeof r.at === "string" && typeof r.rule === "string") {
        out.push({ kind: "refused", id: r.id, at: r.at, who: typeof r.who === "string" ? r.who : null, rule: r.rule, op: typeof r.op === "string" ? r.op : null });
      }
    } catch { /* 跳过这一行 */ }
  }
  return out;
}

const write = (dir: string, me: string, rs: Refused[]): void => {
  mkdirSync(join(dir, ".ateam"), { recursive: true });
  writeFileSync(refusalQueueFile(dir, me), rs.map((r) => JSON.stringify(r)).join("\n") + (rs.length ? "\n" : ""));
};

const load = (dir: string, me: string): Refused[] => {
  const p = refusalQueueFile(dir, me);
  return readRefusalQueue(existsSync(p) ? readFileSync(p, "utf8") : null);
};

/** 被拒的那一刻：往队里追一行。**永远不让它把命令本身弄坏**——这本账是附带的，被拒那件事已经报给人了。 */
export function queueRefusal(dir: string, me: string, r: { at: string; rule: string; op: string; now?: number }): void {
  try {
    const rs = load(dir, me);
    rs.push({ kind: "refused", id: ulid(r.now ?? Date.now()), at: r.at, who: me, rule: r.rule, op: r.op });
    write(dir, me, cap(rs, r.at, r.now ?? Date.now()));
  } catch { /* 记不下就记不下，不许拦住人 */ }
}

/** 超上限时扔最旧的，并把「扔了几条」留成队里的一条。已有的那条溢出记录会被合并，不会越积越多。 */
function cap(rs: Refused[], at: string, now: number): Refused[] {
  if (rs.length <= QUEUE_MAX) return rs;
  const prior = rs.filter((r) => r.rule === CLI_REFUSAL_OVERFLOW);
  const kept = rs.filter((r) => r.rule !== CLI_REFUSAL_OVERFLOW);
  const droppedBefore = prior.reduce((n, r) => n + (Number(/\d+/.exec(r.op ?? "")?.[0]) || 0), 0);
  const dropNow = kept.length - (QUEUE_MAX - 1);
  const rest = kept.slice(Math.max(0, dropNow));
  return [{ kind: "refused", id: ulid(now), at, who: rest[0]?.who ?? null, rule: CLI_REFUSAL_OVERFLOW, op: cliRefusalDropped(droppedBefore + Math.max(0, dropNow)) }, ...rest];
}

/** 队里此刻有什么。 */
export function pendingRefusals(dir: string, me: string): Refused[] {
  try { return load(dir, me); } catch { return []; }
}

/** 捎成了才划掉，而且只划掉捎上去的那几条——这中间新追进来的还在队里。 */
export function clearRefusals(dir: string, me: string, shipped: readonly string[]): void {
  try {
    const done = new Set(shipped);
    const rest = load(dir, me).filter((r) => !done.has(r.id));
    if (rest.length) write(dir, me, rest);
    else rmSync(refusalQueueFile(dir, me), { force: true });
  } catch { /* 同上 */ }
}
