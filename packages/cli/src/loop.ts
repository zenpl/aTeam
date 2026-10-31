import { owedSentences, behindDeploys, cliBehindLine, cliStaleBuildLine, apartFromLive, apartLine, morePagesLine, type PullResult, type Event, unrenderableLine, batchBrokeLine, fullPullLine, CURSOR_UNREADABLE, firstPullLine, WATCH_STOPPED } from "@ateam/core";
import { ClientError, BadResponse } from "./client.js";
import * as fmt from "./format.js";

/** Where the CLI keeps its read position. The file under .ateam/ in production; memory in tests. */
export interface CursorStore {
  read(): string | null;
  write(cursor: string | null): void;
  /**
   * t-293 判据 8②：把攒着的位置真的落盘。可以不给——不给就是「写即落盘」，那是今天的行为。
   * 一次性命令由 `main` 在确认自己以 0 结束时提交；`watch` 没有那一刻，所以它每一轮交付完自己调一次。
   */
  commit?(): void;
  /**
   * t-351（pd 要求㉝）：**空不是「没有」。** `read()` 两种情形都给 `null`，而它们的处置相反——
   * `"none"`（连文件都没有：这个节点真的没有游标，刚加入，该从头拉）与 `"empty"`（文件在、内容为空：
   * 崩溃窗口里读到的那一种，一条都不该拉，当场说话）。不给这个方法就只有 `read()` 那两档，
   * 调用方照旧（只走一条路的调用方与用例不必改）。
   */
  state?(): "none" | "empty" | "value";
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
/**
 * t-300 判据 1：**这几个码在说「是我们自己发错了」。** 重试一万次也是同一个答案，所以看守该停下来让人看见。
 *
 * 名单只列这一边，是故意的：**另一边是默认**。一个没列进来的码（网关塞回的 413、502，或者明天多出来的某个）
 * 按「服务端的时刻」处理，于是它换来的最坏结果是**退避重试几次、多印几行**；反过来默认成「我们的」，
 * 它换来的是**一个变聋的节点，而且它自己不知道**。两种错的代价不对称，所以默认站在吵一点那一边。
 */
export const OURS_NOT_THEIRS: readonly number[] = [400, 401, 403, 404, 409, 422];

/**
 * t-300 判据 1：**按这个码在说什么分类，不按数字区间。**
 *
 * 此前是 `err.status >= 500`，于是 **408（请求超时）与 429（太多请求）都被归成「我们自己的错」**，
 * 而 `watch` 只在 transient 时重试、否则抛出去结束——**服务端最忙的那一刻，看守一个接一个地聋掉**。
 * pd 08:4x 的看守就死于一个 408，而它是去读输出文件才知道的（qa 07:17 报过同一个形状的另一面）。
 *
 * 这段注释原来就写对了标准（「网络问题与 5xx 是服务端的时刻，不是我们的」）——**是实现没照它做**：
 * 标准按含义写，实现按区间判，而 408／425／429 这三个「服务端的时刻」恰好住在 4xx 里。
 */
export function isTransient(err: unknown): boolean {
  // t-225：**正文坏掉算服务那一侧的时刻**，和 5xx、断网同一类：网关塞回一张 HTML、代理截断了正文、
  // 部署中途的空回应——都会自己过去，而且下一轮重试的代价只是一次拉取。杀掉看守才是贵的那一种。
  if (err instanceof BadResponse) return true;
  if (err instanceof ClientError) return !OURS_NOT_THEIRS.includes(err.status);
  return err instanceof Error && !(err instanceof SyntaxError);
}

/**
 * t-300 判据 2：**这一轮等多久。** 服务端说了就照它说的（`Retry-After`），没说才用自己的退避表。
 *
 * 上限是 `RETRY_AFTER_MAX_MS`：一个 `Retry-After: 86400` 会让看守睡一天，而那和聋掉没有区别。
 * 封顶之后仍然照说的等——**封顶防的是一个荒谬的值，不是不信服务端**；等多久那一行本来就印出来，人看得见。
 */
export const RETRY_AFTER_MAX_MS = 5 * 60_000;
export function retryWait(err: unknown, backoff: readonly number[], failures: number, intervalMs: number): number {
  const said = err instanceof ClientError ? err.retryAfterMs : undefined;
  if (said !== undefined) return Math.min(said, RETRY_AFTER_MAX_MS);
  return Math.min(backoff[Math.min(failures, backoff.length - 1)], intervalMs);
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
/**
 * t-340 要求㉙㉚（pd 的 decision `01M69N0XVK591XAJBME7ACGDFT`，措辞定稿在它的路标 cb655f2）：
 * **一条渲染不出来的事件，不许只换来一句 JS 的话；也不许因此把它丢掉。**
 *
 * pd 18:51 亲历的那一次：看守与手跑 `sync` 两次都只打出 `Cannot read properties of undefined (reading 'join')`
 * 就退——**既不说是哪一条，也不说还要不要再来**，而那一批从此不再出现。
 *
 * 这里按 pd ㉚「宁可丑，不可丢」办：渲染一条抛了，就把这一条**按原样**的那几项印出来（第几条、id、kind、
 * actor、时刻），外加那句原因。**这一行就是这一条的交付**——所以它不挡游标：挡住的话，一条永远渲染不出来的
 * 事件会把这个节点永久卡在原地，那是用一种「不动」换掉另一种「不见」，而 pd 要的是「看得见」。
 *
 * **与㉘ 的分工**：㉘ 管的是**整条渲染链**崩掉（这一批一个字都印不出来）——那时游标一步都不许动，见 `sync()`。
 * 这里管的是**其中一条**崩掉：那一条有了它自己的一行，批次照常往下走。
 * ㉙ 原话里还有半句「游标停在 01M… 没有推进」，它属于㉘ 那一半；我把它放在整链屏障那里，没有放在这里，
 * **而这是一处我自己的裁定，已交回 pd**：按㉙ 的字面放在这里，就会出现上面那个永久卡住。
 */
export function renderOne(e: Event, me: string, i: number, total: number): string {
  // **这一处差点蒙过我**：第一版我没 import `Event`，于是它解析成 DOM 里那个同名全局类型，而 build 照样过。
  // 一个在类型上答「过」而意思上答错的签名，与今天那几条「量不到读成没发生」是同一族。
  try {
    return `${e.id}  ${fmt.event(e, me)}`;
  } catch (err) {
    const op = (e as { op?: string }).op;
    // 那句话住在 core（人看得见的话只许有一个家）；这里只把量出来的那几项交给它。
    // **不再在前面另印一次 id**：pd 的定稿把 id 写在句子里（`id 01M…`），前缀会让同一个 id 出现两次。
    return unrenderableLine({
      nth: i + 1, total, id: e.id,
      kind: `${e.kind}${op ? `(${op})` : ""}`,        // pd 点名要这个写法：task(claim)
      actor: (e as { actor?: string }).actor ?? "",
      at: (e as { at?: string }).at ?? "",             // 判据 4：时刻按原样
      why: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * t-343：**整批那一句要说出它断在第几条之后**，所以渲染到哪儿要数出来，不能猜。`tally` 是个可选的出参：
 * 每渲染出一条事件就 +1。调用方不给就什么都不变（只走一条路的调用方照旧）。
 * **限度写在这里**：它数的是「这一行造出来了」，不是「这一行已经印到屏幕上」。真正的打印发生在 `sync()` 里，
 * 所以若 `print` 本身抛（管道断了那种），这个数会偏大一条。那一句的后半（没推进、会再来）仍然是真的。
 */
export function report(r: PullResult, me: string, after: string | null, tally?: { shown: number }): string[] {
  const lines: string[] = [];
  if (!r.events.length) lines.push(after ? "nothing new" : "log is empty");
  const batch = new Set(r.events.map((e) => e.id));
  for (const [i, e] of r.events.entries()) {
    // t-206：**带上 id。** `fmt.event` 自己不印 id 是对的（印不印由调用方决定），漏的是这个调用方——而它正是
    // 「让指令叫醒你」那条路：从 watch 的流里读到一条给自己的指令，手上却没有那串 id，要引用它就得再去查一次
    // 日志，不查就只能凭印象敲。pm 今夜为此编造了六次不存在的 id，六次被服务拒。
    //
    // **这一处同时是 sync 的渲染器**（下面 77 行与 116 行两个调用方共用它），所以补它一处，两条路一起补上——
    // pm 12:52 的诊断先说「sync 不印 id」、13:15 更正成「只有 watch 那一处」，两句其实说的是同一行。
    lines.push(renderOne(e, me, i, r.events.length));
    if (tally) tally.shown++;
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
export async function sync(client: Puller, me: string, cursor: CursorStore, waitMs: number, print: Print | null, behind?: Behind, flush?: () => Promise<void>, seen?: CursorStore, notice?: Print): Promise<PullResult> {
  // t-274：**从「有人读过了」那一处往下拉，而不是从「送到了」那一处。**
  //
  // 背景是 qa 14:10 亲历的那一幕（我 14:14 端到端复现过）：后台 `watch` 拉到一条给它的指令、印进一个管道，
  // 然后进程被杀。`watch` 推的是这个节点的游标，于是重启之后 `sync` 诚实地说「nothing new」——**指令确实到过，
  // 而这个节点再也看不见它**。qa 今天 12.66 小时的沉默就是这么来的，它 14:09 一次性 ack 了 21 条。
  //
  // 修法不是「`watch` 别推游标」（判据 3 的禁令，t-225 那条链付过学费：那样它每轮重复报同一批）。
  // 分成两样：`cursor` 是**送到了**（每次拉取都推，`watch` 照旧不重复），`seen` 是**有人读过了**
  // （只有把这一批真的印给操作者的那一次才推）。`sync` 从后者往下拉，所以 `watch` 吃过的那一批它仍然看得见。
  //
  // 与已有那两样的关系：`ack` 是当事人说「我看见了」，`--refs` 是「我办了」；`seen` 在它们之下——
  // 它只说明**这些字进过这个节点的终端**，不说明有谁看懂了。三者各证各的，谁也不替谁。
  //
  // `seen` 不给就退回今天的行为（两者同一个位置）：那正是所有只走一条路的调用方与用例要的。
  const from = seen ?? cursor;
  /**
   * t-351 判据 2（pd 要求㉝）：**游标文件在、而读出来是空的 ⇒ 一条都不拉，当场说话。**
   * 不这么做的话，空的 `after` 发出去，服务端把整份日志给他（pm 23:14 实测 14375 条、414 KB），
   * 而这一发全量在日志里与一次正常 sync 长得一模一样。
   * **那三行是 pd 23:29 的定稿**（`CURSOR_UNREADABLE`，照抄不改标点）：第一行同时说「没拉」与
   * 「游标也没有动」，第二行给一个能改变它自己的动作（等一下再试），第三行是真丢了那一种（起点由人定）。
   */
  const fromState = from.state?.() ?? (from.read() === null ? "none" : "value");
  if (fromState === "empty") {
    (notice ?? print)?.(CURSOR_UNREADABLE);
    return { events: [], cursor: undefined, owed: undefined } as unknown as PullResult;
  }
  const { after, r } = await pullBatch(client, from, waitMs);
  /**
   * t-351 判据 6（要求㉞，pd 定稿照抄）：**一次「从头全量」必须出声。**
   * 上面那道闸让这条路走不到——而它仍然要在：`sync()` 不是唯一的调用方（`watch` 与别的客户端各有各的路），
   * 而**一次没人看见的全量，正是 pd 要求出声的那件事**。两道都在，是刻意的：一道挡，一道在挡不住时出声。
   */
  // 条件是「这一次是从头拉的」——`after` 为 null **或空串**都算（一个只有 `read()` 的调用方把空读成空串发出来，
  // 正是 pm 23:14 那一幕）。而 `fromState === "none"` 的那一种是刚加入，从头拉本来就对，不说这句话。
  if (!after?.trim() && fromState !== "none" && r.events.length)
    (notice ?? print)?.(fullPullLine(r.events.length, JSON.stringify(r.events).length));
  /**
   * t-293 判据 7：**这台机器此前没有读位置 ⇒ 这一批一印完就全被标成读过，所以先说清它是什么。**
   *
   * 在 `report` 之前，不在之后（pd 07:39 的第一条约束）：他丢的 92 条是印完被截断的，摆结尾的总结 `head` 照样
   * 看不到。条数在印之前就已经知道（整批已经回来了），所以摆得到开头。
   *
   * 走 `notice` 而不是 `print`：**它不是日志里的一条事件**，所以 `--quiet` 那一叠不收它进那个数
   * （pd 07:39、pm 07:35：一个数只许数一种东西）。不给 `notice` 就退回 `print`——只走一条路的调用方照旧。
   */
  const say = notice ?? print;
  if (say && after === null && r.events.length) say(firstPullLine(r.events.length, r.events[0].id, r.events[r.events.length - 1].id));
  /**
   * t-343：**整批在中途断了，要有它自己的一句话**（pd 20:25 的定稿，与逐条那一句处置正相反，所以分开写）。
   * 所以整条渲染链包在这里：中途任何一处抛，先把那一句印出去（它说「游标停在哪、没有推进、下次整个再来」），
   * 再把错原样抛出去——抛出去之后 `advance` 到不了，这正是㉘ 要的屏障。
   */
  const tally = { shown: 0 };
  try {
  if (print) for (const line of report(r, me, after, tally)) print(line);
  if (print) await flush?.();
  // t-245：**没有人要这一批，就不算交付**，游标不动。`print` 为 null 的意思是「这一次谁也不看」——
  // 那正是 `--quiet` 原来的形状，而它让那一批对这个节点永久消失。命令行那一侧此刻不再走这条路
  // （`--quiet` 改成把那一批收进本地那一叠），这里把口子也堵上：**下一个写 `sync(..., null)` 的人不会再踩它。**
  // t-340 要求㉘（pd `01M69N0XVK591XAJBME7ACGDFT`）：**游标只许在整批都渲染出来之后推进。**
  // 这一行原来在这里，而它后面还有两段 print（`owedSentences` 与 `behind` 那一块）——屏障只盖住了 `report`。
  // 那两段里任何一处抛错，这一批就按 pd 描述的样子消失：行印过了（看守那一侧还被 grep 滤掉，人什么也没
  // 看见）、游标已经动了、进程死掉，重启之后「毒已跳过」。而那两段恰好读的是随服务端状态变的东西
  // （`r.owed`、`r.deploys`、`r.sha`），所以它会自己「好」——**重启成功不等于修好，等于那个状态过去了。**
  // 所以 `advance` 挪到这个函数的最后一行（见下）。这里只留这段说明，免得下一个人再把它挪回来。
  // t-140 (pd 06:23): what I still owe, to me and only here. Not in watch's every round, not on the board — it is
  // this node's own business, not the team's and certainly not the human's. The sentences are core's, computed from
  // the server's `owed` (core's `owedNow`): what is owed does not empty out when the cursor moves, which is the
  // whole of qa 06:32's failure against the first version of this line.
  if (print) for (const line of owedSentences(r.owed, new Date())) print(line);
  // t-211：**印在每回合都会跑的这条命令上，不靠谁记得。** 命令行各人各自 build，发车只换服务端，所以这一句
  // 是唯一会主动告诉人「你手上这份不是上线那一版」的地方。说不出就一个字都不说（behindDeploys 返回 null）：
  // 「不知道」不等于「你是最新的」，报平安比不说话更坏。
  if (print && behind) {
    // t-292 判据 2（pd 05:33 五）：**先问「落后还是分叉」。** 数得出两个方向就说 pd 那一对里对的那一句，
    // 一句一个动作；数不出来才退回按上线次数算的那一句——它分不出这两种，但它是我们此刻唯一还答得出的话。
    // 合并 dev aea4c8f：退路那一行改用它的新签名（behindDeploys 收整个 behind，它要用 descends）。
    const line = apartLine(apartFromLive(r.sha ? behind.apart?.(r.sha) : null));
    if (line) print(line);
    else {
      const n = behindDeploys(behind.head(), r.deploys, behind, r.sha);
      if (n !== null && n > 0) print(cliBehindLine(n));
    }
    // qa 16:02：**只 git pull 不重编，上面那句当场消失，而跑着的还是旧的。** HEAD 不是跑着的那一版。
    // 说不出（built 给 null）就不说；这一句与上一句各说各的，两句都成立时两句都印。
    if (behind.built?.() === false) print(cliStaleBuildLine);
  }
  } catch (err) {
    // **游标此刻还停在 `from.read()`**（屏障在下面，还没跑到），所以这一句说的是真的。
    // 首次拉取时它本来就没有位置，于是那个槽里是 `null`——协议里它就是这个值，照原样印（标识符不译）。
    // 这一处我没有替 pd 另写一句「还没有游标」，交回它定。
    if (print) print(batchBrokeLine({ nth: tally.shown, total: r.events.length, cursor: String(from.read()) }));
    throw err;
  }
  // t-340 要求㉘：**整条渲染链都走完了，才算交付。** 上面任何一处抛错都到不了这里，于是游标停在上一个
  // 成功的位置，那一批下次再来（t-245 的那句话仍然成立：没有人要这一批就不算交付，游标不动）。
  if (print) { advance(from, r.cursor); if (from !== cursor) advance(cursor, r.cursor); }
  return r;
}

/** t-211：本地这棵树是哪一版、含不含某次上线。两样都由调用方给，`loop` 自己不碰 git（core 之外仍然可测）。 */
export interface Behind {
  /** 本地 HEAD 的 sha，答不出来给 null（不是 git 检出、git 不在）。 */
  head(): string | null;
  /** 本地这棵树含不含这个 sha。null 是「git 答不上来」，与 false 分开。 */
  has(sha: string): boolean | null;
  /**
   * t-263：**我是不是它的祖先**（它在不在我前头）。null 是答不出来——本地没有这个对象时就是这样。
   * 只有 `has` 时，「它在我前头」与「互不包含」分不开，而回滚产物永远是后者。
   */
  descends(sha: string): boolean | null;
  /** t-211：dist 跟得上源码吗。null 是说不出（没有 dist、读不到时间）。 */
  built?(): boolean | null;
  /**
   * t-292 判据 2：相对线上那一版，两边各自多出几条提交。**两个方向都要数**，因为只数一个方向分不出
   * 「我落后」和「各走了一段」。答不上来给 null（git 不在、本地没有那个对象、不是检出）。
   */
  apart?(live: string): { mine: number; theirs: number } | null;
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
    if (opts.signal?.aborted) {
      // t-300 判据 4：这一路是**用例／调用方自己中断**。现场按 Ctrl-C 走的是 main 里的 SIGINT handler，
      // 到不了这里——所以那一句的归属地是 handler，不是这里（pd 立的判据：一句话印在哪，由它在现场
      // 会不会被执行到决定，不由它在用例里好不好测决定）。这里照旧说一句，是为了调用方也听得见。
      print(WATCH_STOPPED.interrupted("abort"));
      return last;
    }
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
      const wait = retryWait(err, backoff, failures, intervalMs);   // t-300 判据 2：服务端说了就照它说的
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
    cursor.commit?.();                    // t-293 判据 8②：这一轮就是它的「命令结束」——长跑进程没有别的那一刻
    if (r.for_me.length) {
      print("\ninstruction received");
      if (opts.once) {
        print(WATCH_STOPPED.once());   // t-300 判据 4：不是故障，所以这一句不劝重挂
        return r;
      }
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof ClientError) return `server ${err.status}: ${err.message}`;
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
}
