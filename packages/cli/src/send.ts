import { partRefused, partsSkipped, PART_NAMES, EXIT_PARTIAL } from "@ateam/core";
import { ClientError } from "./client.js";

/** 一件要发的东西：`what` 是人读的名字（「t-226 done」「解决接缝 t-226+t-070」），`send` 真发它、返回事件 id。 */
export interface Part<T> {
  what: string;
  event: T;
  /**
   * t-232 判据 3：**后面那几件靠这一件**。这一件没成就停下，而且**把「没发」印出来**——
   * 显式中止，不拿异常当控制流；「不发」与「发了没成」都要看得见。
   */
  stopOnFail?: boolean;
}

/**
 * t-228：**一条命令发多件事时，每一件各自报结果；退出码按整体算。**
 *
 * 真样本是 dev 15:45 那一次：`task done` 已经落库成功，而它随后自动发的「解决接缝」被拒，终端上只有
 * `REJECTED (seam)` 加退出码 2——**看起来像整条命令失败了**，而第一反应「重交一次」会撞上「done 之上再 done」
 * 再被拒（t-034 那次就是两次「失败」、事实上第一次已经成了）。
 *
 * **边界按 frontend 15:47 核准的写**：不是「被拒也可能落库」（单件命令拒了就是没写，它核过自己三次各落 0 条），
 * 是「一条命令发了两件事，退出码只报最后一件」。
 *
 * 两种行都走 stdout：看它的进程只把 stdout 当事件流（t-225）。被拒的那一行同时写一份到 stderr，人盯着终端时
 * 两处都看得见。
 */
export interface PartTally { ok: number; bad: number; exit: number; failed: { what: string; rule: string; why: string }[] }

/**
 * t-261：**一件一件地发，规则与 `sendAll` 同一套。**
 *
 * `sendAll` 要求调用方先把所有件攒齐——而 `ateam release` 攒不齐：它那几件**夹在真的 git push 中间**
 * （先记「越过未验收」，推，再记 `deployed.sha`），先攒后发就得把推送也挪进来。所以把「怎么报一件」
 * 抽成这个，`sendAll` 在它上面跑一个循环。**两处同一套说法、同一个退出码算法，不是两份实现**——
 * 这份日志里「同一件事两处各写一份」是数过一整天的毛病。
 */
export function partSender<T>(
  send: (e: T) => Promise<{ id: string; line: string }>,
  out: (line: string) => void,
  err: (line: string) => void,
): { one(what: string, event: T): Promise<boolean>; tally(): PartTally } {
  let ok = 0, bad = 0;
  const failed: { what: string; rule: string; why: string }[] = [];
  return {
    async one(what, event) {
      try {
        const { line } = await send(event);
        out(line);
        ok += 1;
        return true;
      } catch (e) {
        const why = e instanceof ClientError
          ? (e.status === 409 ? `REJECTED (${e.body.rule}): ${e.body.message}` : `server ${e.status}: ${e.message}`)
          : e instanceof Error ? e.message : String(e);
        out(partRefused(what, why));
        err(partRefused(what, why));
        failed.push({ what, rule: e instanceof ClientError && e.status === 409 ? (e.body.rule ?? "rejected") : "error", why });
        bad += 1;
        return false;
      }
    },
    tally: () => ({ ok, bad, exit: bad && ok ? EXIT_PARTIAL : bad ? 2 : 0, failed }),
  };
}

export async function sendAll<T>(
  items: Part<T>[],
  send: (e: T) => Promise<{ id: string; line: string }>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<PartTally> {
  // t-261：**「怎么报一件」只有一份实现**（`partSender`），这里只管顺序与 `stopOnFail`。
  // t-241 那条仍然成立：被拒的几件要带出去给调用方记账，`tally().failed` 就是它。
  const sender = partSender(send, out, err);
  for (const [i, it] of items.entries()) {
    const ok = await sender.one(it.what, it.event);
    if (!ok && it.stopOnFail) {
      const rest = items.length - (i + 1);
      if (rest > 0) { out(partsSkipped(rest)); err(partsSkipped(rest)); }
      break;
    }
  }
  return sender.tally();
}

/**
 * t-261：**`release` 那两个回调，从这里造。**
 *
 * 它们的合同只有一条，而这一条就是本件修的东西：**永不抛。** 一件被拒就当场报那一件，然后让流程走完——
 * 因为 `release` 的那几件**夹在真的 git push 中间**，中途抛出去意味着「已经推上去了、而记录没落下」，
 * 外加终端上只看得见最后那一下。修之前逐字是这样：`rollback` 尾部 note 落了、reading 被拒，
 * 整条命令带着 `Error: shape 不合` 掀翻，**没有一行说那条 note 成了，也没有一行说没落下的是 reading**。
 *
 * 造在这里而不是 `main.ts` 里，是为了它能被用例直接钉住——放在 `main()` 里面的东西，用例够不着。
 */
export function releaseEmitters<T>(
  one: (what: string, event: T) => Promise<boolean>,
  build: { reading(key: string, value: unknown, extra: { surface: string; method?: string; writes?: string[] }): T; note(body: string): T },
): { reading: (key: string, value: unknown, extra: { surface: string; method?: string; writes?: string[] }) => Promise<void>; note: (body: string) => Promise<void> } {
  return {
    reading: async (key, value, extra) => { await one(PART_NAMES.releaseReading(key), build.reading(key, value, extra)); },
    note: async (body) => { await one(PART_NAMES.releaseNote(), build.note(body)); },
  };
}
