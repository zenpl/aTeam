/**
 * t-249 · `/health` 答 ok 的时候要说出自己答得有多慢。
 *
 * 它此前的正文是 `{ ok: true, sha }`，**稳态 0.24 秒和最慢 48.13 秒逐字相同**（qa 00:14 实测九次卡住，
 * 全是 200、全是同一行字）。于是它在任何故障里都会说 ok——**一个不设期限的健康检查在任何故障里都会说 ok，
 * 这跟它探什么无关**（qa 00:15，本件存在的理由）。
 *
 * 所以这里量的是**这次请求真的等了多久拿到一个事件循环的回合**，而不是「处理函数自己跑了几毫秒」：
 * 那 48 秒一秒都不花在处理函数里。`sqlite-store.ts` 用 `node:sqlite` 的 `DatabaseSync`（同步 API），
 * `since()` 里的 `all()/get()` 把事件循环整个占住；请求在内核队列里排着，**处理函数一进来就已经晚了**，
 * 它自己再测自己只会测出 0。qa 在生产 sha `09256fd` 上复现过这条因果：灌进生产日志那 9279 条事件、
 * 八条全量 `GET /log` 并发（合计 1634ms 同步活）时，**一行库都不碰的 `/health` 要 1600ms（98%）**，
 * 静止对照 0.0005s。**根因留在这里，别让下一个人重新推一遍**（判据 4：本件不修它）。
 */

/**
 * **期限：超过它这次就不算 ok。**
 *
 * **我第一版把这个数定错了，错法留在这里，因为它是今晚反复出现的那一种**：我拿 qa 00:14 那批
 * **客户端端到端 0.22–0.28s** 去给**服务端事件循环延迟**定期限。两个量不是一回事——端到端里约 200ms 是网络，
 * 而这台服务器自己的循环延迟稳态是 **1–4ms**（qa 实测空转 200 秒；我在 9372 条的库上实测 3 秒里中位 0、最大 1ms）。
 * **两个量差两个数量级，拿一个去定另一个的缝，算出来的缝落在两群之外。** 后果 qa 当场量到了：
 * 一台零流量的服务器有整整一分钟在说 `ok=false`，因为它自己那一跳家务活。
 *
 * 现在这个数只从**服务端循环延迟**这一个量里来：
 * · 健康那一群：空转 **1–4ms**（两处独立实测一致）。
 * · 会挡住人的那一群，今天这份 9372 条的库上实测：一次 `/board?full=1` **232ms**、一次写入 **1327ms**
 *   （qa 另测：定时任务一跳本地 457–514ms、生产 844–1222ms，写入 1349ms）。
 * 两群之间从 4ms 到 232ms 隔着 58 倍，**100ms 在缝里**：比健康那群的上界宽 25 倍（不把抖动与一次 GC 报成病），
 * 比会挡住人的那群里**最轻的一次**紧 2.3 倍（最轻的一次也逃不掉）。
 *
 * **今天这台服务器会经常越过它，那不是这道闸定错了，是 t-250 那个缺陷还在**：`node:sqlite` 的 `DatabaseSync`
 * 加每次写入一遍全量折叠，让写入、整板、家务活都把循环停在百毫秒到一秒半。**闸红是因为它说的是真话。**
 * t-250 把那几段降到毫秒级之后，这个数要拿新的实测再走一遍同样的推导——**改它必须带一批新的服务端循环延迟
 * 实测，不许只改数字，也不许再拿端到端的数来定它。**
 */
export const HEALTH_BUDGET_MS = 100;

/** 滚动窗口：`lag_max_ms` 报的是最近这么久里最坏的一次事件循环延迟。 */
export const HEALTH_WINDOW_MS = 60_000;

export interface HealthBody {
  /** 这一刻它敢不敢说自己是好的：`queue_ms` 与 `lag_max_ms` 都在期限之内才算。 */
  ok: boolean;
  sha: string;
  /**
   * **这次请求**等一个事件循环回合等了多久。
   *
   * **它看得见什么、看不见什么，我先说清楚**——写这条用例的时候我自己被它咬了一次：
   * 它只看得见**处理函数跑起来那一刻还在继续的**那段堵塞。一次堵塞如果在处理函数被叫起来之前就结束了，
   * 客户端明明等了半分钟，这个数仍然是 0——**任何在 JS 里量的东西都要先拿到一个回合，所以它量不了
   * 自己拿到回合之前的那段饥饿**。真正兜住那一段的是下面那个 `lag_max_ms`（`monitorEventLoopDelay`
   * 在 C++ 侧记，JS 被堵着的时候它照样在记）。两个数一起读：一个说「此刻还堵着」，一个说「刚才堵过」。
   */
  queue_ms: number;
  /**
   * 最近 `window_ms` 里最坏的一次事件循环延迟。**这是主信号**：一次卡过去了，下一次 `/health` 还说得出
   * 「刚才卡过 N 毫秒」——而 qa 量到的 48 秒正是这一类，卡完之后再问它，从前它会笑着说 ok。
   */
  lag_max_ms: number;
  budget_ms: number;
  window_ms: number;
  /**
   * 判据 3：**它探到了什么、没探到什么，写在正文里，不写在谁的记忆里。**
   * `/health` 是 `app.ts` 的第一条路由，在鉴权、`stateFor`、任何库访问之前——**进程活着而库坏了／锁了／盘满了，
   * 它会很快地说 ok**。所以 `checks` 只写它真探过的那一样，`not_checked` 明写库，`store_probe` 指出谁覆盖它。
   */
  checks: string[];
  not_checked: string[];
  store_probe: string;
}

/** 覆盖「库这一类」的那条路：真过 `app.ts` 的 `store.since()`，且在那次卡里同样慢到 4.95s（qa 00:14）。 */
export const STORE_PROBE = "GET /log?after=<latest id>";

/** 最近一段时间里最坏的那次事件循环延迟。窗口靠时刻裁，不靠条数——条数会随采样频率变意思。 */
export class LoopLag {
  private samples: { at: number; ms: number }[] = [];
  constructor(private windowMs = HEALTH_WINDOW_MS, private now: () => number = Date.now) {}
  record(ms: number, at = this.now()): void {
    this.samples.push({ at, ms });
    this.trim(at);
  }
  /** 窗口内最坏的一次；一条样本都没有时是 0——**「没量到」与「量到 0」在这里说不出分别，所以 `checks` 里写明它探的是什么。** */
  max(at = this.now()): number {
    this.trim(at);
    return this.samples.reduce((m, s) => (s.ms > m ? s.ms : m), 0);
  }
  private trim(at: number): void {
    const from = at - this.windowMs;
    while (this.samples.length && this.samples[0].at < from) this.samples.shift();
  }
}

/** 采样间隔。100ms 而不是 1s：一段堵塞被量到的下限就是这个数，太粗会把一秒以内的卡整段吃掉。 */
export const HEALTH_SAMPLE_MS = 100;

/**
 * 每 `every` 毫秒记一次**这个计时器自己迟到了多久**——迟到就是事件循环没空理它，而那正是要量的东西。
 *
 * **为什么不用 `monitorEventLoopDelay`**（我先写的是那一版，被这条用例逼着换掉的）：它的直方图只有
 * 「自 enable 以来的 max」，要做滚动窗口就得每段 `reset()` 一次，而**堵塞结束之后，我的定时器和它内部
 * 那个定时器谁先跑是没有定论的**——我先跑，就会读到一个还没记上去的旧值、然后把它清零，那一次卡就此消失。
 * 实测里它就这么消失过：真堵了 1.4 秒，`/health` 报的是 10 毫秒。**一个会随机漏报的量具比没有量具更坏**，
 * 所以改成自己量迟到：一次减法，没有第二个计时器可以跟它抢先后。
 *
 * 计时器 `unref()`，不拦着进程退出。返回停表的那个函数（测试与关服都要它）。
 */
export function sampleLoopLag(lag: LoopLag, every = HEALTH_SAMPLE_MS, now: () => number = Date.now): () => void {
  let last = now();
  const t = setInterval(() => {
    const n = now();
    lag.record(Math.max(0, Math.round(n - last - every)), n);
    last = n;
  }, every);
  t.unref?.();
  return () => clearInterval(t);
}

/**
 * 等一个事件循环回合要多久——**在这次请求上量**。只测得到此刻**仍在继续**的那段堵塞：
 * 堵塞若在处理函数被叫起来之前就结束了，这个数是 0（见 `HealthBody.queue_ms`）。
 */
export async function queueDelayMs(now: () => number = Date.now): Promise<number> {
  const t0 = now();
  await new Promise<void>((r) => setImmediate(r));
  return Math.max(0, now() - t0);
}

export function healthBody(sha: string, queue_ms: number, lag_max_ms: number, budget_ms = HEALTH_BUDGET_MS, window_ms = HEALTH_WINDOW_MS): HealthBody {
  return {
    ok: queue_ms <= budget_ms && lag_max_ms <= budget_ms,
    sha, queue_ms, lag_max_ms, budget_ms, window_ms,
    checks: ["process", "event_loop"],
    not_checked: ["store"],
    store_probe: STORE_PROBE,
  };
}
