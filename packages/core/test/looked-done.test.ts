/**
 * t-251 ①：把「办了、只是那条 note 没 `refs` 它」算出来——**只算，不接到任何人看得见的地方**。
 *
 * 判据 ② 写死了：`owedTo` 与牌桌那个数此刻一个字都不改。所以这一份有两半：
 * 上半证明它算得对，**下半证明它没有偷偷改变任何已有的数**——后者才是判据 ② 的内容，也是最容易在
 * 「顺手接上去」的一次改动里丢掉的那一半。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, lookedDone, owedTo, board, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const min = (n: number) => n * 60_000;

function world(startAgoMs = min(120)) {
  const store = new MemoryStore();
  let t = Date.now() - startAgoMs;
  const at = () => new Date(t);
  const emit = (e: NewEvent, plus = min(1)) => { t += plus; return append(store, e, { human: HUMAN, now: at() }); };
  const state = async () => reduce(await store.read(), at());
  return { emit, at, state };
}
const ackBy = (w: ReturnType<typeof world>) => new Date(w.at().getTime() + min(60)).toISOString();

/** 一件任务，pm 建、dev 认领。 */
async function task(w: ReturnType<typeof world>, id: string) {
  await w.emit({ kind: "task", op: "create", task: id, title: `活 ${id}`, criteria: ["能用"], actor: "pm", no_human_impact: true } as unknown as NewEvent);
}

describe("t-251 · 办了但没连上", () => {
  it("指令点名了一件任务，收件人在那之后认领了它：算「其实办了」", async () => {
    const w = world();
    await task(w, "t-900");
    await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "请做 t-900", ack_by: ackBy(w) });
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
    const s = await w.state();
    expect(lookedDone(s).map((x) => x.instruction.body)).toEqual(["请做 t-900"]);
  });

  it("动作发生在指令之前：不算——那不是回应", async () => {
    const w = world();
    await task(w, "t-900");
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
    await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "请做 t-900", ack_by: ackBy(w) });
    expect(lookedDone(await w.state())).toEqual([]);
  });

  it("动的是别人不是收件人：不算", async () => {
    const w = world();
    await task(w, "t-900");
    await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "请做 t-900", ack_by: ackBy(w) });
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "frontend" } as unknown as NewEvent);
    expect(lookedDone(await w.state())).toEqual([]);
  });

  it("已经连上了的（refs 过）不重复算——它本来就不在「看不出回应」那一堆里", async () => {
    const w = world();
    await task(w, "t-900");
    const i = await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "请做 t-900", ack_by: ackBy(w) }) as { id: string };
    await w.emit({ kind: "note", actor: "dev", body: "办了", refs: [i.id] } as unknown as NewEvent);
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
    expect(lookedDone(await w.state())).toEqual([]);
  });

  it("正文没点名任何任务：算不出来，就不算——这一类多半本来也不要求做什么", async () => {
    const w = world();
    await task(w, "t-900");
    await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "记一条：今晚别合分支", ack_by: ackBy(w) });
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
    expect(lookedDone(await w.state())).toEqual([]);
  });

  it("按收件人筛得出来", async () => {
    const w = world();
    await task(w, "t-900"); await task(w, "t-901");
    await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "请做 t-900", ack_by: ackBy(w) });
    await w.emit({ kind: "instruction", actor: "pm", to: "qa", body: "请验 t-901", ack_by: ackBy(w) });
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
    await w.emit({ kind: "task", op: "claim", task: "t-901", touches: ["src/b.ts"], actor: "qa" } as unknown as NewEvent);
    const s = await w.state();
    expect(lookedDone(s, "dev")).toHaveLength(1);
    expect(lookedDone(s, "qa")).toHaveLength(1);
    expect(lookedDone(s)).toHaveLength(2);
  });

  /**
   * **判据 4 那根保险丝，写成用例。** pd 全场缺人，它那 247 条一条也不该算得出「办了」。
   * 我第一版把「挂在那件任务上的 note」也算作动作，真日志上 pd 当场变成 **90**——**pd 的活就是写 note，
   * 把「他谈过这件事」读成「他办了这件事」，正是这支指标本来要修的那个毛病的镜像。**
   * 去掉 note 之后 pd 回到 0。这条用例守的就是「只认动作，不认说话」。
   */
  it("只在那件任务上写了 note 的人，不算办了——保险丝", async () => {
    const w = world();
    await task(w, "t-900");
    await w.emit({ kind: "instruction", actor: "pm", to: "pd", body: "t-900 那句措辞你定", ack_by: ackBy(w) });
    await w.emit({ kind: "note", actor: "pd", body: "我在想", task: "t-900" } as unknown as NewEvent);
    expect(lookedDone(await w.state(), "pd")).toEqual([]);
    // 而同一个人真的在那件任务上动了手（这里是加一条判据），就算
    await w.emit({ kind: "task", op: "criteria", task: "t-900", add: ["再加一条"], actor: "pd" } as unknown as NewEvent);
    expect(lookedDone(await w.state(), "pd")).toHaveLength(1);
  });

  /**
   * **判据 ② 的那一半。** 同一份日志，同一个人：上面那条指令被 `lookedDone` 认出来了，
   * 而 `owedTo` 与牌桌那一行**必须当它不存在**——那个决定归 pd（`t-193` 是它定的），不归本件。
   */
  it("它一个字都没改 owedTo，也没改牌桌那个数", async () => {
    const w = world();
    await task(w, "t-900");
    await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "请做 t-900", ack_by: ackBy(w) });
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
    const s = await w.state();
    expect(lookedDone(s, "dev")).toHaveLength(1);          // 它算得出来
    expect(owedTo(s, "dev")).toHaveLength(1);              // 而它仍然欠着——严口径一个字没改
    // 人看得见的那一节：三档（missing／deaf／listening）加起来仍然数着它，**一条都没被减掉**。
    // 这里不挑某一档断言——夹具里没有游标，那一档归谁由在场状态决定，而判据 ② 管的是「有没有被减掉」。
    const p = board(s, HUMAN, w.at()).overdue_by_presence;
    const counted = p.missing.count + p.deaf.count + p.listening.count;
    expect(counted).toBe(1);
    expect([...p.missing.instructions, ...p.deaf.instructions, ...p.listening.instructions]).toHaveLength(1);
  });
});
