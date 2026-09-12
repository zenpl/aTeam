import { owedSentences, behindDeploys, cliBehindLine, cliStaleBuildLine, morePagesLine, type PullResult } from "@ateam/core";
import { ClientError, BadResponse } from "./client.js";
import * as fmt from "./format.js";

/** Where the CLI keeps its read position. The file under .ateam/ in production; memory in tests. */
export interface CursorStore {
  read(): string | null;
  write(cursor: string | null): void;
}

/** The one call `sync` and `watch` need from the server. */
export interface Puller {
  pull(after: string | null, waitMs?: number): Promise<PullResult>;
}

export type Print = (line: string) => void;

export interface WatchOptions {
  /** Delays between retries after a transient failure, in ms. Each is capped at the interval. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Stop after the first pull that brings an instruction (the pre-t-046 behaviour, for old Monitor setups). */
  once?: boolean;
  /** Ends the watch from outside (tests, shutdown). */
  signal?: AbortSignal;
  /** Called once per loop turn: the lock file's heartbeat (t-049). */
  heartbeat?: () => void;
  /**
   * t-240：**等这一批真的流出去。** 印完不等于交付：写进管道只是排了队，读它的进程慢一点、死了、或者容器
   * 正在重启时，那几行还在这一头。等它排空之后才推进游标——**这样「被杀在交付之前」是一个真的、可以被撞上的
   * 状态**，而不是一段微秒级、谁也验不到的窗口。给不出就不等（stdout 是文件或终端时本来就一写即出）。
   */
  flush?: () => Promise<void>;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000];
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Network trouble and 5xx are the server's moment, not ours; 4xx, rejections and config errors are ours. */
export function isTransient(err: unknown): boolean {
  // t-225：**正文坏掉算服务那一侧的时刻**，和 5xx、断网同一类：网关塞回一张 HTML、代理截断了正文、
  // 部署中途的空回应——都会自己过去，而且下一轮重试的代价只是一次拉取。杀掉看守才是贵的那一种。
  if (err instanceof BadResponse) return true;
  if (err instanceof ClientError) return err.status >= 500;
  return err instanceof Error && !(err instanceof SyntaxError);
}

/**
 * The cursor only moves forward (t-049). Two processes sharing the file interleave read-pull-write; a stale
 * value must never overwrite a newer one, or old instructions replay. ULIDs sort by time, so a plain compare works.
 */
export function advance(cursor: CursorStore, next: string | null): boolean {
  const current = cursor.read();
  // t-225 判据 2：**先问「这个值合法吗」，再问「它比现在新吗」。**
  //
  // 旧版只认识 `null`，而真正打进来的是 `undefined`——一个 200 带着不可解析的正文，被上游造成假 `PullResult`
  // 之后，`r.cursor` 就是 `undefined`。它走过两道闸：`undefined <= current` 是 false（与 undefined 的比较一律
  // false），`undefined === null` 也是 false，于是**被当成一个合法的新位置写进了游标文件**，读位置当场归零。
  // 一个「只往前」的闸，被一个连「位置」都不是的值绕过去了。
  if (typeof next !== "string" && next !== null) return false;
  if (next !== null && !next.trim()) return false;
  if (next !== null && current !== null && next <= current) return false;
  if (next === null && current !== null) return false;
  cursor.write(next);
  return true;
}

/** Render one pull the way `ateam sync` shows it. */
export function report(r: PullResult, me: string, after: string | null): string[] {
  const lines: string[] = [];
  if (!r.events.length) lines.push(after ? "nothing new" : "log is empty");
  const batch = new Set(r.events.map((e) => e.id));
  for (const e of r.events) {
    // t-206：**带上 id。** `fmt.event` 自己不印 id 是对的（印不印由调用方决定），漏的是这个调用方——而它正是
    // 「让指令叫醒你」那条路：从 watch 的流里读到一条给自己的指令，手上却没有那串 id，要引用它就得再去查一次
    // 日志，不查就只能凭印象敲。pm 今夜为此编造了六次不存在的 id，六次被服务拒。
    //
    // **这一处同时是 sync 的渲染器**（下面 77 行与 116 行两个调用方共用它），所以补它一处，两条路一起补上——
    // pm 12:52 的诊断先说「sync 不印 id」、13:15 更正成「只有 watch 那一处」，两句其实说的是同一行。
    lines.push(`${e.id}  ${fmt.event(e, me)}`);
    // t-064: an instruction to me taken back after I had already pulled it: say so, or I might still act on it
    if (e.kind === "untell" && !batch.has(e.of) && r.taken_back_seen?.includes(e.of)) lines.push(`  ⇐ 你已看过的这条被撤回了（${e.of}），不要照着做`);
  }
  // t-140 (pd 07:34): there is no tail here at all any more. t-147 had replaced the old 「ateam ack」 line with one
  // that named the two things still owed; pd deleted that too, integrally, because it said the same thing as the
  // 「你欠什么」 line at sync while counting something else — this batch, not the standing debt — and two same-meaning
  // numbers from two sources are the shape 07:07 forbids: if they were really the same thing they would be one.
  // What just arrived is already marked instruction by instruction (⇐ FOR YOU); what is owed is said once, at sync.
  // t-226 判据 3：**截断在这一端也要看得见。** 服务端在 JSON 里说了 `more`，而跑 sync 的人只看得见事件；
  // 不补这一行，一次被截断的拉取与「就这么多」在终端上一模一样。
  if (r.more) lines.push(morePagesLine(r.events.length));
  return lines;
}

/**
 * t-240：**拉一批，不推进游标。** 推进是交付之后的事，所以拉与推进从这里起是两步，调用方自己在交付之后确认。
 */
export async function pullBatch(client: Puller, cursor: CursorStore, waitMs: number): Promise<{ after: string | null; r: PullResult }> {
  const after = cursor.read();
  return { after, r: await client.pull(after, waitMs) };
}

/**
 * One protocol step: pull since the cursor, print what came in, and only then advance the cursor exactly once.
 *
 * t-240：**先交付，后推进。** 这两行原来是反的，而那个顺序里有一道缝：一次「取」与一次「看见」之间进程死掉
 * （容器重启、watch 被打死），**那一批对这个节点永久消失，而之后每次 sync 都诚实地说「nothing new」——
 * 它就是没有新的了**。frontend 20:07 真撞上：重启后游标已越过它最后看到的那条，pm 20:12 宣布 t-240 的那条
 * tell 自己被这道缝吃掉，20:36 才被补读到。
 *
 * 同族三处，一并点名（判据 3）：① 本件（游标推进早于交付）；② `advance` 收 `undefined` 就清游标
 * （t-225，已修已验、未上线）；③ 把 `sync` 倒进 `/dev/null`（pm 15:31 已改它的看守）。
 * **共同形状：一次「取」与一次「看见」之间有缝，而缝里丢的东西不留痕。**
 *
 * 与 t-226（首次拉取的绝对上限）是同一函数上的两条，不是一件事：那条管**一次给太多**，本件管**给了没交到手
 * 就记成给过了**。两条都在之后，剩下的仍是：一次给多少由 t-226 的上限决定，而无论给多少，没交付就不推进。
 *
 * `print` null 是**调用方自己交付**（watch 那一路）或**明写的丢弃**（`--quiet` 的心跳）：前者由调用方在交付
 * 之后推进，后者是人自己要的，不是悄悄丢的。
 */
export async function sync(client: Puller, me: string, cursor: CursorStore, waitMs: number, print: Print | null, behind?: Behind, flush?: () => Promise<void>): Promise<PullResult> {
  const { after, r } = await pullBatch(client, cursor, waitMs);
  if (print) for (const line of report(r, me, after)) print(line);
  if (print) await flush?.();
  advance(cursor, r.cursor);
  // t-140 (pd 06:23): what I still owe, to me and only here. Not in watch's every round, not on the board — it is
  // this node's own business, not the team's and certainly not the human's. The sentences are core's, computed from
  // the server's `owed` (core's `owedNow`): what is owed does not empty out when the cursor moves, which is the
  // whole of qa 06:32's failure against the first version of this line.
  if (print) for (const line of owedSentences(r.owed, new Date())) print(line);
  // t-211：**印在每回合都会跑的这条命令上，不靠谁记得。** 命令行各人各自 build，发车只换服务端，所以这一句
  // 是唯一会主动告诉人「你手上这份不是上线那一版」的地方。说不出就一个字都不说（behindDeploys 返回 null）：
  // 「不知道」不等于「你是最新的」，报平安比不说话更坏。
  if (print && behind) {
    const n = behindDeploys(behind.head(), r.deploys, behind.has, r.sha);
    if (n !== null && n > 0) print(cliBehindLine(n));
    // qa 16:02：**只 git pull 不重编，上面那句当场消失，而跑着的还是旧的。** HEAD 不是跑着的那一版。
    // 说不出（built 给 null）就不说；这一句与上一句各说各的，两句都成立时两句都印。
    if (behind.built?.() === false) print(cliStaleBuildLine);
  }
  return r;
}

/** t-211：本地这棵树是哪一版、含不含某次上线。两样都由调用方给，`loop` 自己不碰 git（core 之外仍然可测）。 */
export interface Behind {
  /** 本地 HEAD 的 sha，答不出来给 null（不是 git 检出、git 不在）。 */
  head(): string | null;
  /** 本地这棵树含不含这个 sha。null 是「git 答不上来」，与 false 分开。 */
  has(sha: string): boolean | null;
  /** t-211：dist 跟得上源码吗。null 是说不出（没有 dist、读不到时间）。 */
  built?(): boolean | null;
}

/**
 * Keep listening. Every pull that brought events is printed as sync would print it (empty pulls stay silent),
 * so nothing is consumed unseen; a pull that brings an instruction for `me` is followed by "instruction received"
 * and the loop goes on (t-046): a node that stops listening after one instruction is deaf until someone notices.
 * `once` returns after that first instruction instead. Nothing is pulled twice, so a following `sync` says "nothing new".
 */
export async function watch(client: Puller, me: string, cursor: CursorStore, intervalMs: number, print: Print, opts: WatchOptions = {}): Promise<PullResult> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? realSleep;
  let failures = 0;
  let last: PullResult = { events: [], for_me: [], cursor: cursor.read() };
  for (;;) {
    if (opts.signal?.aborted) return last;
    opts.heartbeat?.();
    let after: string | null;
    let r: PullResult;
    try {
      // t-240：**拉一批，先不推进**；下面印完了再推进。watch 死在这中间，那一批下次还拿得到。
      ({ after, r } = await pullBatch(client, cursor, Math.min(intervalMs, 30_000)));
    } catch (err) {
      // A transient failure (deploy in progress, network blip) must not end the watch: the cursor is untouched,
      // say what happened, back off, try again. Anything else is ours to fix, so it still exits.
      if (!isTransient(err)) throw err;
      const wait = Math.min(backoff[Math.min(failures, backoff.length - 1)], intervalMs);
      failures += 1;
      print(`watch: ${describeError(err)}; retrying in ${wait / 1000}s (attempt ${failures})`);
      await sleep(wait);
      continue;
    }
    failures = 0;
    last = r;
    if (r.events.length) for (const line of report(r, me, after)) print(line);
    if (r.events.length) await opts.flush?.();
    advance(cursor, r.cursor);            // t-240：交付之后才推进——写出去、而且真的流出去了，这一批才算给出去了
    if (r.for_me.length) {
      print("\ninstruction received");
      if (opts.once) return r;
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof ClientError) return `server ${err.status}: ${err.message}`;
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
}
