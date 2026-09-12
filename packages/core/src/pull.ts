import type { Event, EventStore, Instruction } from "./index.js";
import { owedTo, owedNow, type OwedNow } from "./board.js";
import type { State } from "./reduce.js";

/**
 * t-226：**一次拉取的绝对字节上限。**
 *
 * 为什么是一个写死的数，而不是「比现在小一点」：qa 15:34 与我 15:34 同时量同一件事，得到 6,330,848 与
 * 6,193,295——**差的就是那两分钟里日志长出来的部分**。一条会跟着被测物一起涨的地板不是地板；今天定 6 MB
 * 的上限，明天就是 7 MB。
 *
 * 为什么是 1 MiB：**首次拉取是陌生 agent 的第一条命令**，而外部报告里那支队伍每个节点都是自己手写轮询的
 * （说明书教的 `ateam watch` 在人家机器上不存在）。1 MiB 是一个手写客户端可以整块读进内存、整块解析、
 * 出错时还能整块打出来看的大小；今天这条 8,263 条的日志约 7 页拉完，每页一次往返。
 *
 * **它不随日志变大而变大，也不随某次测量改小**（判据 6）。要改它，改的是这个常量与它下面这段理由。
 */
export const PULL_BYTES = 1_048_576;

export interface PullResult {
  events: Event[];
  /**
   * t-226 判据 3：**这一批是被截断的，后面还有。** 截断必须看得见——少给而不自知，正是这几天数了二十一次
   * 的那一族。续取不必读文档：`cursor` 就是下一次的 `after`，拿着它再拉一次即可。
   */
  more?: boolean;
  /** t-064: instructions to `me` taken back in this batch that I had pulled before it: the CLI warns about them. */
  taken_back_seen?: string[];
  /**
   * Instructions addressed to `me` **in this batch**, and only this batch — once the cursor moves they are gone
   * from here. Use it to say what just arrived, never to say what is still owed: that is `owed`, and mistaking one
   * for the other is what qa 06:32 caught in t-140.
   */
  for_me: Event[];
  cursor: string | null;
  /**
   * t-147: what this role owes at this instant, computed by the service from the state it already keeps and sent
   * with every pull, so a caller needs neither a full read of the log nor a second request. Optional because
   * core's own `pull` has no state to compute it from, and because a CLI may be talking to a server too old to
   * send it — a missing field means「不知道」, not「不欠」.
   */
  owed?: OwedNow;
  /**
   * t-211：**服务此刻跑的是哪一版，以及至今上过几次线。** 命令行是各人各自 build 的，发车只换服务端——所以
   * 「上线了」与「我手上这份跑的是那一版」是两件事，而今晚没有任何一处告诉人他在哪一种里。qa 14:50 用早上的
   * 构建落了一条带两个 `--refs` 的 note，服务只收到一个：**「我动过」被算成了没动**，而且事后从日志里查不出来。
   *
   * 两个字段都可选，理由与 `owed` 同：core 自己的 `pull` 没有服务端那份事实，旧服务也不会送——**没有这个字段
   * 是「不知道」，不是「你是最新的」**，调用方据此闭嘴而不是报平安。
   */
  sha?: string;
  /** 至今每一次上线的 sha，老的在前。命令行拿它与本地 git 比，数出自己落后几次上线。 */
  deploys?: string[];
}

/**
 * The protocol step every agent runs at the start of a turn:
 * read since cursor, record deliveries of instructions to me, advance cursor (heartbeat).
 */
export function capBytes(all: Event[], limit: number): { events: Event[]; more: boolean } {
  // t-227 用例逼出来的一处：**量的必须是真正发出去的那串字节**。按元素自身长度求和会漏掉数组的框架——
  // 两个方括号与每个元素后面的逗号；400 条时那点框架正好把 65,536 的上限顶成 65,619，超了 83 字节。
  // 一个「差一点点」的上限在这一族里不算小事：它意味着这个数说的不是真话。
  let used = 2;
  for (const [i, e] of all.entries()) {
    const size = Buffer.byteLength(JSON.stringify(e), "utf8") + (i ? 1 : 0);
    // **至少给一条**：一条比上限还大的事件若也被挡住，游标就再也前进不了——那是把「太大」变成「永远拿不到」。
    if (i > 0 && used + size > limit) return { events: all.slice(0, i), more: true };
    used += size;
  }
  return { events: all, more: false };
}

export async function pull(store: EventStore, me: string, after: string | null, now: Date = new Date(), limit: number = PULL_BYTES): Promise<PullResult> {
  const { events, more } = capBytes(await store.since(after), limit);
  const nowIso = now.toISOString();
  const for_me: Event[] = [];
  // an instruction taken back in the same batch was never something to do (t-064); a delivery is still recorded, since it was read
  const takenBack = new Set(events.filter((e) => e.kind === "untell").map((e) => (e as { of: string }).of));
  for (const e of events) {
    if (e.kind === "instruction" && e.to === me && takenBack.has(e.id)) { await store.recordDelivery({ event_id: e.id, to: me, at: nowIso }); continue; }
    if (e.kind === "instruction" && e.to === me) {
      await store.recordDelivery({ event_id: e.id, to: me, at: nowIso });
      for_me.push(e);
    }
  }
  const cursor = events.length ? events[events.length - 1].id : after;
  const inBatch = new Set(events.map((e) => e.id));
  const earlier = [...takenBack].filter((id) => !inBatch.has(id));
  let taken_back_seen: string[] | undefined;
  if (earlier.length) {
    const { events: all } = await store.read();
    taken_back_seen = earlier.filter((id) => all.some((e) => e.id === id && e.kind === "instruction" && e.to === me));
  }
  await store.setCursor({ actor: me, last_event_id: cursor, at: nowIso });
  // 投递只记这一页里真的给了的那些——**记了却没给，就是「已送达」变成假话**，而那恰恰是这道闸要防的
  return { events, for_me, cursor, ...(more ? { more: true } : {}), ...(taken_back_seen?.length ? { taken_back_seen } : {}) };
}

/**
 * t-227：**POST 回包上那两样东西的绝对上限。**
 *
 * 与 `PULL_BYTES` 同一条口径（写死的数，不是「比现在小」），但小得多，理由是**每一次 POST 都要付这笔钱**：
 * 拉取是一个节点开工时的一两次，而写事件是它整天都在做的事。64 KiB 装得下几十条指令的正文，
 * 而一个欠了几百条的节点本来就该去拉一次，不该靠写事件的回包把日志搬过去。
 *
 * **不许把首次拉取那 6 MB 的问题搬到每一次 POST 上**（判据 3 的原话）。
 */
export const POST_REPLY_BYTES = 65_536;

/**
 * t-227：**此刻点名给这个人、而它还没读过的那些指令。**
 *
 * 「还没读过」是 `reach === "unread"`——游标没越过它，就没有任何证据说它看过（reduce.ts 的 `reach`）。
 * 这正是「只发不拉」那个节点的盲区：它整天在写事件，而发给它的指令一条都没进过它的眼睛。
 *
 * **这里不记投递**：记投递的是拉取那条路。回包是顺带给它看一眼，不是「送到了」——把顺带看一眼记成已送达，
 * 就是今天数过好几次的那一族（「结果在」不等于「动作发生过」）。所以同一条指令会在它每次 POST 时都出现，
 * 直到它真的去拉一次或办掉它。
 */
export function forPoster(s: State, me: string, limit: number = POST_REPLY_BYTES): { for_me: Instruction[]; more?: boolean } {
  const unread = owedTo(s, me).filter((st) => st.reach === "unread").map((st) => st.instruction);
  const { events, more } = capBytes(unread as unknown as Event[], limit);
  return { for_me: events as unknown as Instruction[], ...(more ? { more: true } : {}) };
}

/**
 * t-227 判据 3（qa 16:39 判 fail 之后重做）：**量的是整个回包。**
 *
 * 第一版把 `for_me` 与 `owed` 各自限到 `POST_REPLY_BYTES`，**两份各自合规、整体两倍**：qa 在生产真状态下
 * 量到回包 131,135 字节，而那个写死的数是 65,536。**我量了我看得见的那两半，把它报成了整体**——这正是
 * 这几天数了二十多次的那一族，这次轮到我。
 *
 * 所以这里先造一个「两样都空」的完整回包量一遍：事件本身、字段名、括号、逗号，**框架也是字节**。
 * 剩下多少，才是这两样能用的预算；顺序上先给 `for_me`（点名找你的比「你欠什么」更急），剩下的给 `owed`。
 * 每一处宁可算多一两个字节，也不算少——一个「差一点点」的上限说的不是真话。
 */
export const OWED_SHARE = 0.25;

export function postReply(s: State, me: string, base: unknown, limit: number = POST_REPLY_BYTES): { for_me: Instruction[]; owed: OwedNow; more?: boolean } {
  const empty: OwedNow = { unanswered: [], untouched: [], legacy_before_acted_rule_count: 0 };
  const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");
  // `more: true` 也一起量进去：没截断时这 12 字节是白留的，而白留比超标好。
  const frame = bytes({ ...(base as object), for_me: [], owed: empty, more: true });
  const budget = Math.max(0, limit - frame);
  // capBytes 的账里含着那对方括号（它从 2 起算），而框架里已经有了，所以这里把它加回去再传进去。
  //
  // t-244：**两样东西不能是「谁先填谁占满」。** qa 21:52 在生产真状态下量到：`for_me` 占掉 65,058／65,536
  // ＝ 99.3%（176 条未读），**活欠账一条都没送出去**——而 t-227 做这件事的全部理由，正是让一个只写不拉的
  // 节点看见自己欠什么。于是先给「你欠什么」留一份（`OWED_SHARE`），`for_me` 只能用剩下的；
  // **它没用完的，第二遍再还给 `for_me`**——留一份不是浪费一份。
  //
  // 顺序仍然是 `for_me` 优先（点名找你的比「你欠什么」更急），砍也先砍它：**它是可以再拉一次拿到的**
  // （GET /events 那条路上有同一批），而这一回包是那个节点此刻唯一会看的东西。两半各自截断时各自报 `more`。
  const reserve = Math.floor(budget * OWED_SHARE);
  const first = forPoster(s, me, Math.max(0, budget - reserve) + 2);
  const usedFirst = Math.max(0, bytes(first.for_me) - 2);
  const o = capOwed(owedNow(s, me), Math.max(0, budget - usedFirst));
  const { more: oMore, ...owed } = o;
  const usedOwed = bytes(owed);
  // 第二遍：`owed` 用不掉的份额还给 `for_me`（它多半用不掉——一个欠 3 条的人不需要那 16 KiB）
  const f = usedOwed < reserve ? forPoster(s, me, Math.max(0, budget - usedOwed) + 2) : first;
  return { for_me: f.for_me, owed: owed as OwedNow, ...(f.more || oMore ? { more: true } : {}) };
}

/**
 * t-227 判据 3：`owed` 也要受同一个上限。三个桶按顺序装，装不下的截断并说明——**少给而不自知**是这几天
 * 数了二十一次的那一族，这里是它的第三个出口（前两个是首次拉取与 POST 的 for_me）。
 */
export function capOwed(owed: OwedNow, limit: number = POST_REPLY_BYTES): OwedNow & { more?: boolean } {
  // t-239：历史那一桶只剩一个数，不参与这笔预算——它本来就是常量大小，而且没人读它的内容。
  const out: OwedNow & { more?: boolean } = { unanswered: [], untouched: [], legacy_before_acted_rule_count: owed.legacy_before_acted_rule_count };
  let used = 0;
  for (const bucket of ["unanswered", "untouched"] as const) {
    for (const item of owed[bucket]) {
      // 每一条都按「自己 + 一个逗号」算。每个桶的头一条其实不带逗号，于是最多算多 3 字节——
      // 宁可算多，也不要一个说不出真话的上限。
      const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
      if (used + size > limit) { out.more = true; return out; }
      used += size;
      (out[bucket] as unknown[]).push(item);
    }
  }
  return out;
}
