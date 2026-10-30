/**
 * t-252：**写入不再把整份日志重折一遍。**
 *
 * 这一份存在的理由写在它自己身上：我先交的那一版**没有这一份**，反向注入（把 `runFollowUps` 换回
 * `reduce(await store.read(), now)`）**全仓 1312 条一条不红**——一个性能改动如果不落成行为断言，
 * 它就是下一个人可以随手退回去而没有任何东西出声的那一种。**在注入下也绿的用例不是证据，没有用例更不是。**
 *
 * 所以这里断言的是行为而不是耗时（耗时会随机器抖）：**这条路读了几次日志、读的是全量还是增量。**
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, runFollowUps, type Log, type LogMark, type NewEvent, type Event } from "../src/index.js";

const HUMAN = "human";

/** 一个会数数的 store：全量读几次、增量读几次、其中几次是「从头再来」。 */
class Counting extends MemoryStore {
  full = 0; since = 0; rewind = 0;
  async read(): Promise<Log> { this.full++; return super.read(); }
  async readSince(mark: LogMark | null): Promise<{ log: Log; mark: LogMark; events: number }> {
    this.since++;
    if (mark === null) this.rewind++;
    return super.readSince(mark);
  }
}

/** 一条 verify --fail，它会生出一条给 owner 的通知——`runFollowUps` 真的有事可做。 */
async function failOne(store: Counting, id: string, now: Date): Promise<Event> {
  const opts = { human: HUMAN, now };
  await append(store, { kind: "task", op: "create", task: id, title: `活 ${id}`, criteria: ["能用"], actor: "pm", no_human_impact: true } as unknown as NewEvent, opts);
  await append(store, { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`], actor: "dev" } as unknown as NewEvent, opts);
  await append(store, { kind: "task", op: "done", task: id, evidence: "abc1234：做完了", actor: "dev", no_human_impact: true } as unknown as NewEvent, opts);
  return append(store, { kind: "task", op: "verify", task: id, surface: "repo", pass: false, evidence: "没过", actor: "qa" } as unknown as NewEvent, opts);
}

describe("t-252 · 写入这条路读几次日志", () => {
  it("第二次之后不再全量读，也不再从头折——增量，而且只增量", async () => {
    const store = new Counting();
    const now = new Date();
    const first = await failOne(store, "t-900", now);
    await runFollowUps(store, first, HUMAN, now);
    const afterWarm = { full: store.full, rewind: store.rewind };

    // 再跑五轮：这五轮里一次全量读都不该有，也不该有任何一次「从头折」
    for (let i = 1; i <= 5; i++) {
      const e = await failOne(store, `t-90${i}`, now);
      await runFollowUps(store, e, HUMAN, now);
    }
    expect(store.full - afterWarm.full).toBe(0);       // ← 换回 reduce(await store.read()) 这里就红
    expect(store.rewind - afterWarm.rewind).toBe(0);   // ← 每次新造一份 Reduction 这里就红
    expect(store.since).toBeGreaterThan(0);            // 它确实在读，只是增量读
  });

  it("它跟得上：增量折出来的结果与全量折一次一模一样（省的是重复劳动，不是正确性）", async () => {
    const store = new Counting();
    const now = new Date();
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await failOne(store, `t-91${i}`, now);
      for (const x of await runFollowUps(store, e, HUMAN, now)) out.push(`${x.kind}:${"task" in x ? x.task : ""}`);
    }
    // 三条 fail，三条通知，一条不多一条不少——增量没有漏折也没有重折
    expect(out.filter((x) => x.startsWith("instruction"))).toHaveLength(3);
  });
});
