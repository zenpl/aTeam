/**
 * t-175 判据 3：**「自己发现」与「被别人发现」怎么分，写清楚并可复核。**
 *
 * 分法只读日志里已有的事件，一个字的正文都不读：从他发出那条、到他改口那一刻，中间有没有别人冲着他来的
 * 事件（发给他的指令／别人落的验收／点名引用那条指令的 note）。有 → 别人；一条都没有 → 自己。
 *
 * 这一份也把**这把尺子看不见什么**钉成断言，而不是只写在注释里：注释不会红。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, caughtBy, selfCorrections, type NewEvent, type Instruction } from "../src/index.js";

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

/** pd 发一条给 pm，`between` 在那之后、改口之前发生，改口在两分钟后。返回那条被更正的指令与改口时刻。 */
async function run(between?: (w: ReturnType<typeof world>, first: Instruction) => Promise<unknown>) {
  const w = world();
  const first = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "先按这个做", ack_by: ackBy(w) }) as Instruction;
  if (between) await between(w, first);
  const later = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "更正我刚才那条：是 t-2 不是 t-1", ack_by: ackBy(w) }) as Instruction;
  return { s: await w.state(), first, at: later.at };
}

describe("t-175 · 一条更正是谁发现的", () => {
  it("中间一个人都没说话：自己发现", async () => {
    const { s, first, at } = await run();
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  it("中间有一条发给他的指令：别人发现——哪怕那条指令说的是别的事", async () => {
    const { s, first, at } = await run(async (w) =>
      w.emit({ kind: "instruction", actor: "qa", to: "pd", body: "另一件完全无关的事，麻烦看一眼", ack_by: ackBy(w) }));
    expect(caughtBy(s, first, at)).toBe("别人");
  });

  it("中间有别人落的一条验收：别人发现——pass 也算，一次判决就是一次外部说法", async () => {
    const { s, first, at } = await run(async (w) => {
      await w.emit({ kind: "task", op: "create", task: "t-1", title: "一件", criteria: ["能用"], actor: "pm", no_human_impact: true } as unknown as NewEvent);
      await w.emit({ kind: "task", op: "claim", task: "t-1", touches: ["src/a.ts"], actor: "dev" } as unknown as NewEvent);
      await w.emit({ kind: "task", op: "done", task: "t-1", evidence: "abc1234：做完了", actor: "dev", no_human_impact: true } as unknown as NewEvent);
      return w.emit({ kind: "task", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "跑过了", actor: "qa" } as unknown as NewEvent);
    });
    expect(caughtBy(s, first, at)).toBe("别人");
  });

  it("中间有一条点名引用那条指令的 note：别人发现", async () => {
    const { s, first, at } = await run(async (w, f) =>
      w.emit({ kind: "note", actor: "qa", body: "他那条的前提不成立", refs: [f.id] } as unknown as NewEvent));
    expect(caughtBy(s, first, at)).toBe("别人");
  });

  it("别人写了 note 但没点名那条指令：算不到他头上——「别人此刻在说话」不等于「别人在说他」", async () => {
    const { s, first, at } = await run(async (w) =>
      w.emit({ kind: "note", actor: "qa", body: "记一件我自己的事" } as unknown as NewEvent));
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  it("他自己在中间说的话不算：一个人不会因为自己开口就变成被别人发现的", async () => {
    const { s, first, at } = await run(async (w) => {
      await w.emit({ kind: "note", actor: "pd", body: "我再想想" });
      return w.emit({ kind: "instruction", actor: "pd", to: "qa", body: "顺手问一句", ack_by: ackBy(w) });
    });
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  it("窗口是左开右闭的：改口之后别人才说的话，不算他被人发现", async () => {
    const w = world();
    const first = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "先按这个做", ack_by: ackBy(w) }) as Instruction;
    const later = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "更正我刚才那条：是 t-2 不是 t-1", ack_by: ackBy(w) }) as Instruction;
    await w.emit({ kind: "instruction", actor: "qa", to: "pd", body: "我也发现了", ack_by: ackBy(w) });
    expect(caughtBy(await w.state(), first, later.at)).toBe("自己");
  });

  /**
   * 这把尺子的盲区，写成断言而不是注释：**「事后由证据暴露」在日志里不留事件**（服务端拒了他、用例红了、
   * 他自己跑 git 发现对不上），所以它一律被算成「自己」。方向是安全的——只会让正面那桶偏大、门槛那桶偏小，
   * 不会凭空制造一次超标——但报告里不许把这一部分说成「自己发现」。
   */
  it("盲区：被证据暴露的那一种在日志里没有事件，于是被算进「自己」那一桶", async () => {
    const { s, first, at } = await run();   // 中间真正发生的是一次 REJECTED，而拒绝不进日志
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  it("只有更正分两桶：情况变了与说不好照旧各是一个数", async () => {
    const w = world();
    const ab = () => ackBy(w);
    const say = (body: string, plus?: number) => w.emit({ kind: "instruction", actor: "pd", to: "pm", body, ack_by: ab() }, plus);
    for (let i = 0; i < 8; i++) await say(`第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    await say("先按那个做", min(12));
    await w.emit({ kind: "instruction", actor: "qa", to: "pd", body: "插一句", ack_by: ab() }, min(1) / 2);
    await say("生产已上线 abc1234，这条按新的来", min(1));   // 中间有别人说话，但它不是更正，不进任何一桶
    await say("再来一件", min(12));
    await w.emit({ kind: "instruction", actor: "qa", to: "pd", body: "再插一句", ack_by: ab() }, min(1) / 2);
    await say("另外那件也麻烦你看一下", min(1));
    const s = await w.state();
    const list = [...s.instructions.values()].map((x) => x.instruction).filter((i) => i.actor === "pd").sort((a, b) => a.at.localeCompare(b.at));
    expect(selfCorrections(s, list).get("pd")!).toEqual({ sent: 12, 自己: 0, 别人: 0, 更新: 1, 说不好: 1 });
  });
});
