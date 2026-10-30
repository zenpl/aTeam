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
import { cliRefusalOp, cliRefusalDropped, CLI_REFUSAL_OVERFLOW, shipUnreachableLine, shipNotCountedLine, ulid, type Refused } from "@ateam/core";

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

/**
 * t-284：**捎不上去是静默的——而单次的正确处置被当成了长期的正确处置。**
 *
 * t-218 那个 `catch` 写的是对的，一个字都不用改：**捎遥测不该掀翻用户正在跑的命令**，那一刻的正确处置就是
 * 不吭声、不改退出码。错在它之外——**「这一次没捎成」与「已经六天没捎成」之间缺一个计数**，于是第一天的
 * 正确沉默一路顺延成了第六天的沉默。我这台就是现场：队里最早那条 `2026-09-12T22:57:59.957Z`，
 * 此后每一条命令都在捎、每一条都没捎成，**而我一次都不知道**。
 *
 * 两种失败分开数（判据 5），因为它们要人做的事不同：
 * · `unreachable`——请求没发出去、连不上、或服务端压根没有这条路由（今晚这一族：`3e50e5b` 上没有
 *   `POST /refusals`）。**要动的是那台服务**。
 * · `not-counted`——请求发出去了，服务端回 `counted: false`（那个存储没有这本账），一条都不划。
 *   t-218 写死了不许假装记下了，**这一条本件不碰**；它只是从「不划掉」升格成「不划掉，而且说一声」。
 *
 * 出声的门槛（判据 3，用今晚三台的真数校准，账在 t-284 的证据里）：**连续 3 次没捎成**、**且队里最早那条
 * 已经过了一天**、**且最近一天没说过这句**。三个都要：只看次数会变成每条命令都喊，只看天数会把「今天刚被拒
 * 一条、这一刻正好没网」也算进来，不限频则前两个条件一旦成立就永远成立。
 */
export type ShipOutcome = "ok" | "unreachable" | "not-counted";
export const SHIP_FAIL_STREAK = 3;
export const SHIP_STUCK_MS = 24 * 60 * 60 * 1000;
export const SHIP_SAY_EVERY_MS = 24 * 60 * 60 * 1000;

interface Streak { n: number; since: string | null }
export interface ShipState { unreachable: Streak; notCounted: Streak; saidAt: string | null }

const NO_STREAK: Streak = { n: 0, since: null };
export const shipStateFile = (dir: string, me: string): string => join(dir, ".ateam", `ship-state.${me}.json`);

const streakOf = (v: unknown): Streak => {
  const r = (v ?? {}) as Partial<Streak>;
  const n = typeof r.n === "number" && Number.isFinite(r.n) && r.n > 0 ? Math.floor(r.n) : 0;
  const since = typeof r.since === "string" && !Number.isNaN(Date.parse(r.since)) ? r.since : null;
  return n && since ? { n, since } : NO_STREAK;
};

/** 读状态。**坏掉就是「没有连续失败过」**，不是「说不出」：这本账只用来决定要不要多说一句话。 */
export function readShipState(text: string | null): ShipState {
  try {
    const r = JSON.parse(text ?? "") as Partial<ShipState>;
    const saidAt = typeof r?.saidAt === "string" && !Number.isNaN(Date.parse(r.saidAt)) ? r.saidAt : null;
    return { unreachable: streakOf(r?.unreachable), notCounted: streakOf(r?.notCounted), saidAt };
  } catch { return { unreachable: NO_STREAK, notCounted: NO_STREAK, saidAt: null }; }
}

/**
 * 一次捎完之后的状态。**连成一串的才算一串**：这一次是哪一种，那一种加一（`since` 记住这串的头），
 * 其余两种当场归零——一次捎成了、或换了一种坏法，都说明上一串断了。
 */
export function afterShip(st: ShipState, outcome: ShipOutcome, now: Date): ShipState {
  const bump = (s: Streak): Streak => ({ n: s.n + 1, since: s.since ?? now.toISOString() });
  if (outcome === "ok") return { unreachable: NO_STREAK, notCounted: NO_STREAK, saidAt: st.saidAt };
  if (outcome === "unreachable") return { unreachable: bump(st.unreachable), notCounted: NO_STREAK, saidAt: st.saidAt };
  return { unreachable: NO_STREAK, notCounted: bump(st.notCounted), saidAt: st.saidAt };
}

/**
 * 该说的那一句，没有就是 `null`。**纯函数**：只看状态、队列与此刻，不碰文件、不碰网络——判据 4 要的
 * 「不掀翻命令」在这一层就成立了，因为它连副作用都没有。
 */
export function shipSilenceNotice(st: ShipState, queue: readonly Refused[], now: Date): string | null {
  if (!queue.length) return null;
  if (st.saidAt && now.getTime() - Date.parse(st.saidAt) < SHIP_SAY_EVERY_MS) return null;
  const oldest = queue.map((r) => Date.parse(r.at)).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b)[0];
  if (oldest === undefined || now.getTime() - oldest < SHIP_STUCK_MS) return null;
  const days = Math.floor((now.getTime() - oldest) / SHIP_STUCK_MS);
  // **话住在 core**（t-143 判据 8：新增的人可见的话一律进 core，命令行这个第二个家只减不增）。
  if (st.unreachable.n >= SHIP_FAIL_STREAK) return shipUnreachableLine(queue.length, days, st.unreachable.n);
  if (st.notCounted.n >= SHIP_FAIL_STREAK) return shipNotCountedLine(queue.length, days, st.notCounted.n);
  return null;
}

/** 说过就记下来——限频靠它，而且**只有真说出口了才记**。 */
export const markSaid = (st: ShipState, now: Date): ShipState => ({ ...st, saidAt: now.toISOString() });

/** 状态落盘。与队列同一条规矩：**记不下就记不下，不许拦住人**。 */
export function saveShipState(dir: string, me: string, st: ShipState): void {
  try {
    mkdirSync(join(dir, ".ateam"), { recursive: true });
    writeFileSync(shipStateFile(dir, me), JSON.stringify(st));
  } catch { /* 同上 */ }
}

/** 读状态文件；读不出来按「没失败过」。 */
export function loadShipState(dir: string, me: string): ShipState {
  try {
    const p = shipStateFile(dir, me);
    return readShipState(existsSync(p) ? readFileSync(p, "utf8") : null);
  } catch { return readShipState(null); }
}
