/**
 * t-175 判据 3 与判据 4（pm 00:06 重写）：**一条更正是谁发现的，按当事人的回执算。**
 *
 * 尺子只问一句、而且只问那条被改的指令本身：**收件人在他改口之前，回过这条没有**（`acked_at`）。
 * 回过 → 「别人」；没回过 → 「自己」。一个字的正文都不读。
 *
 * 第一版不是这样写的，写坏的那一版也留在这里当用例（最后一节）：它问的是「中间有没有别人冲着他来的事件」，
 * 而那在真日志上**恒真**——09-07 那两小时里别人发给 pm 的指令最大间隔 457 秒，小于 10 分钟的配对窗口。
 * **一个恒真的判别式不是判别式**，而且它量的是团队有多吵，不是他有没有被人提醒。
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

/** pd 发一条给 pm，`between` 在那之后、改口之前发生，改口在一分钟后。 */
async function run(between?: (w: ReturnType<typeof world>, first: Instruction) => Promise<unknown>) {
  const w = world();
  const first = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "先按这个做", ack_by: ackBy(w) }) as Instruction;
  if (between) await between(w, first);
  const later = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "更正我刚才那条：是 t-2 不是 t-1", ack_by: ackBy(w) }) as Instruction;
  return { s: await w.state(), first, at: later.at };
}

describe("t-175 · 一条更正是谁发现的", () => {
  it("收件人一直没回过那条：自己发现", async () => {
    const { s, first, at } = await run();
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  /**
   * 真样本（判据 4 ②）：pm 08:34:33 派给 frontend 一件它 08:25 就做完的活，**frontend 08:35:13 ack 了那一条**，
   * pm 08:35:58 才收回。pm 自述「是我没先读记录」，但**日志看得见的是当事人先说了**——尺子量回执，不量自觉。
   */
  it("收件人在他改口之前签收了那条：别人发现", async () => {
    const { s, first, at } = await run(async (w, f) => w.emit({ kind: "ack", of: f.id, actor: "pm" } as unknown as NewEvent, min(1) / 4));
    expect(caughtBy(s, first, at)).toBe("别人");
  });

  it("收件人签收在他改口之后：不算——那时他早就自己改完了", async () => {
    const w = world();
    const first = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "先按这个做", ack_by: ackBy(w) }) as Instruction;
    const later = await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "更正我刚才那条：是 t-2 不是 t-1", ack_by: ackBy(w) }) as Instruction;
    await w.emit({ kind: "ack", of: first.id, actor: "pm" } as unknown as NewEvent);
    expect(caughtBy(await w.state(), first, later.at)).toBe("自己");
  });

  /**
   * 作者自己签收自己那条不算回执——一个人不会因为自己签收就变成被别人发现的。
   * 这一支走得到吗？走得到，但**只有 human 走得到**：rules.ts 的 ack 只准收件人、human、或服务给自己的卡签收
   * （`is addressed to X, not Y`），所以 `acked_by === actor` 唯一的形态就是 human 发一条又自己签收。
   * 这条用例就是那一种；换成 pd 自签，服务当场拒（我第一版这么写的，被拒了才知道这一支的边界在哪）。
   */
  it("作者自己签收自己那条不算回执（只有 human 走得到这一支）", async () => {
    const w = world();
    const first = await w.emit({ kind: "instruction", actor: HUMAN, to: "pm", body: "先按这个做", ack_by: ackBy(w) }) as Instruction;
    await w.emit({ kind: "ack", of: first.id, actor: HUMAN } as unknown as NewEvent, min(1) / 4);
    const later = await w.emit({ kind: "instruction", actor: HUMAN, to: "pm", body: "更正我刚才那条：是 t-2 不是 t-1", ack_by: ackBy(w) }) as Instruction;
    const s = await w.state();
    expect(s.instructions.get(first.id)!.acked_by).toBe(HUMAN);
    expect(caughtBy(s, first, later.at)).toBe("自己");
  });

  /**
   * **判据 4 ④：不依赖别人说话的密度。** 这一条就是第一版死在的地方——别人在这段时间里说了很多话，
   * 甚至都是冲着他来的，但**没有一句是签收那一条**。旧尺子在这里答「别人」，新尺子答「自己」。
   */
  it("别人在这段时间里说了一大堆、也都是发给他的，但没人签收那一条：仍然是自己发现", async () => {
    const { s, first, at } = await run(async (w) => {
      for (const who of ["qa", "frontend", "dev"]) await w.emit({ kind: "instruction", actor: who, to: "pd", body: "另一件事", ack_by: ackBy(w) }, min(1) / 8);
      await w.emit({ kind: "note", actor: "qa", body: "我记一笔" }, min(1) / 8);
      return w.emit({ kind: "note", actor: "dev", body: "我也记一笔" }, min(1) / 8);
    });
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  /**
   * 盲区，写成断言而不是注释：**读了、动手了、却没 ack 的收件人这里看不见**；
   * **「事后由证据暴露」**（服务端拒了他、用例红了）在日志里根本不留事件。两种都被算进「自己」那一桶——
   * 方向安全（只会让正面那桶偏大、门槛那桶偏小），但报告里不许把这一桶整个说成「他自己发现的」。
   */
  it("盲区：收件人动了手却没签收，算不出来——落进「自己」那一桶", async () => {
    const { s, first, at } = await run(async (w, f) => w.emit({ kind: "note", actor: "pm", body: `我按 ${f.id} 办了`, refs: [f.id] } as unknown as NewEvent, min(1) / 4));
    expect(caughtBy(s, first, at)).toBe("自己");
  });

  describe("判据 4 ①：一次更正也可以是一条 note", () => {
    it("note 里自承写错，就算一次更正；没有收件人可签收，落 note自己", async () => {
      const w = world();
      await w.emit({ kind: "note", actor: "pm", body: "更正我刚才那条：数我看错了" });
      const s = await w.state();
      expect(selfCorrections(s, [], s.notes).get("pm")!).toMatchObject({ note自己: 1, note别人: 0 });
    });

    it("note 点名了他自己发过的那条指令、而收件人已经签收：落 note别人", async () => {
      const w = world();
      const first = await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: "先按这个做", ack_by: ackBy(w) }) as Instruction;
      await w.emit({ kind: "ack", of: first.id, actor: "dev" } as unknown as NewEvent);
      await w.emit({ kind: "note", actor: "pm", body: "更正上面那条：我写错了", refs: [first.id] } as unknown as NewEvent);
      const s = await w.state();
      expect(selfCorrections(s, [], s.notes).get("pm")!).toMatchObject({ note自己: 0, note别人: 1 });
    });

    it("note 上的那两个数不并进指令那两个：分母不覆盖的分子不许混进同一个比", async () => {
      const w = world();
      await w.emit({ kind: "note", actor: "pm", body: "更正我刚才那条：数我看错了" });
      const s = await w.state();
      const c = selfCorrections(s, [], s.notes).get("pm")!;
      expect(c).toEqual({ sent: 0, 自己: 0, 别人: 0, 更新: 0, 说不好: 0, note自己: 1, note别人: 0 });
    });

    it("不是更正的 note 一条都不进：note 不是「凡是 pm 写的字都算一次错」", async () => {
      const w = world();
      for (const body of ["concern: 这条路我担心", "决策：取 A", "friction: 那个开关不好用"]) await w.emit({ kind: "note", actor: "pm", body });
      const s = await w.state();
      expect(selfCorrections(s, [], s.notes).get("pm")).toBeUndefined();
    });
  });

  it("只有更正分两桶：情况变了与说不好照旧各是一个数", async () => {
    const w = world();
    const ab = () => ackBy(w);
    const say = (body: string, plus?: number) => w.emit({ kind: "instruction", actor: "pd", to: "pm", body, ack_by: ab() }, plus);
    for (let i = 0; i < 8; i++) await say(`第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, min(12));
    await say("先按那个做", min(12));
    await say("生产已上线 abc1234，这条按新的来", min(1));
    await say("再来一件", min(12));
    await say("另外那件也麻烦你看一下", min(1));
    const s = await w.state();
    const list = [...s.instructions.values()].map((x) => x.instruction).filter((i) => i.actor === "pd").sort((a, b) => a.at.localeCompare(b.at));
    expect(selfCorrections(s, list).get("pd")!).toEqual({ sent: 12, 自己: 0, 别人: 0, 更新: 1, 说不好: 1, note自己: 0, note别人: 0 });
  });
});
