import type { Event, EventStore } from "./index.js";
import type { OwedNow } from "./board.js";

export interface PullResult {
  events: Event[];
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
export async function pull(store: EventStore, me: string, after: string | null, now: Date = new Date()): Promise<PullResult> {
  const events = await store.since(after);
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
  return { events, for_me, cursor, ...(taken_back_seen?.length ? { taken_back_seen } : {}) };
}
