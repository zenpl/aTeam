import { partRefused, partsSkipped, EXIT_PARTIAL } from "@ateam/core";
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
export async function sendAll<T>(
  items: Part<T>[],
  send: (e: T) => Promise<{ id: string; line: string }>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<{ ok: number; bad: number; exit: number }> {
  let ok = 0, bad = 0;
  for (const [i, it] of items.entries()) {
    try {
      // **成功那一件的结果行就是事件行本身**：它已经带着 id 与「发生了什么」（`01M…  task t-226 done — …`、
      // `01M…  seam t-226+t-070 resolved: …`）。再补一行「✓ 某某成功」是同一件事说两遍——而这份日志里
      // 「两个数说同一件事」正是我们数了一整天的毛病。**被拒那一件才需要额外一行**，因为它没有事件行。
      const { line } = await send(it.event);
      out(line);
      ok += 1;
    } catch (e) {
      const why = e instanceof ClientError
        ? (e.status === 409 ? `REJECTED (${e.body.rule}): ${e.body.message}` : `server ${e.status}: ${e.message}`)
        : e instanceof Error ? e.message : String(e);
      out(partRefused(it.what, why));
      err(partRefused(it.what, why));
      bad += 1;
      if (it.stopOnFail) {
        const rest = items.length - (i + 1);
        if (rest > 0) { out(partsSkipped(rest)); err(partsSkipped(rest)); }
        break;
      }
    }
  }
  return { ok, bad, exit: bad && ok ? EXIT_PARTIAL : bad ? 2 : 0 };
}
