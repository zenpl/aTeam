/**
 * t-253（T8）：**任务状态把活钉在某一个人身上，而那个人一走，活就冻住——这正是 T8 要挡的那件事，
 * 而我们自己的闸此刻站在它对面。**
 *
 * 今夜同一形状撞到三处，这一份逐处立一条用例：
 * ① `t-025` 是 `done`，造成那个回归、自己说要修的 frontend 去 claim，被逐字拒掉；
 * ② `t-249`／`t-250` 是 `failed`，只有原 owner 重 `done` 才谈得上再验；
 * ③ `t-248` 的 claim 攥在一个 `missing` 了两小时的节点手里，而活其实早已推上去。
 *
 * **两个方向都要立住**：缺人时接得走（否则活冻住），在场时接不走（否则谁都能抢别人正在做的活）。
 * 判据 3 说得很死：依据是 presence，不是猜。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, Rejected, type NewEvent, type State } from "../src/index.js";

const HUMAN = "human";
const min = (n: number) => n * 60_000;
/** 牌桌认「在听」的窗口是 15 分钟，「还在动」是更长的那个；超过就是 missing。这里用足够久的间隔跨过去。 */
const LONG_GONE = min(24 * 60);

function world() {
  const store = new MemoryStore();
  let t = Date.now() - LONG_GONE * 2;
  const at = () => new Date(t);
  const emit = (e: NewEvent, plus = min(1)) => { t += plus; return append(store, e, { human: HUMAN, now: at() }); };
  const state = async (nowAt = at()) => reduce(await store.read(), nowAt) as Promise<State>;
  /** 「在听」＝游标动过，不是说过话。两者是两回事，这一份下面就靠这个分辨 listening 与 deaf。 */
  const listen = (who: string) => store.setCursor({ actor: who, last_event_id: null, at: at().toISOString() });
  return { emit, at, state, listen, jump: (ms: number) => { t += ms; } };
}

/** pm 建一件、frontend 认领并做到某个状态。 */
async function upTo(w: ReturnType<typeof world>, id: string, status: "working" | "done" | "failed") {
  await w.emit({ kind: "task", op: "create", task: id, title: `活 ${id}`, criteria: ["能用"], actor: "pm", no_human_impact: true } as unknown as NewEvent);
  await w.emit({ kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`], actor: "frontend" } as unknown as NewEvent);
  if (status === "working") return;
  await w.emit({ kind: "task", op: "done", task: id, evidence: "abc1234：做完了", actor: "frontend", no_human_impact: true } as unknown as NewEvent);
  if (status === "failed") await w.emit({ kind: "task", op: "verify", task: id, surface: "repo", pass: false, evidence: "没过", actor: "qa" } as unknown as NewEvent);
}

/** dev 想接走。返回拒绝话，或 null（接走了）。 */
async function tryTake(w: ReturnType<typeof world>, id: string): Promise<string | null> {
  try {
    await w.emit({ kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`], actor: "dev" } as unknown as NewEvent);
    return null;
  } catch (err) {
    if (err instanceof Rejected) return err.message;
    throw err;
  }
}

describe("t-253 · 人不在了，活不该冻住", () => {
  for (const status of ["working", "done", "failed"] as const) {
    it(`${status} 的活：owner 缺人时接得走，而且留下从谁到谁的痕`, async () => {
      const w = world();
      await upTo(w, "t-900", status);
      w.jump(LONG_GONE);                                   // frontend 从此再没出现过
      expect(await tryTake(w, "t-900")).toBeNull();
      const t = (await w.state()).tasks.get("t-900")!;
      expect(t.owner).toBe("dev");
      // 判据 2：不许抹掉任何人——原 owner 与这一手都在链上
      expect(t.handovers).toHaveLength(1);
      expect(t.handovers[0]).toMatchObject({ from: "frontend", to: "dev" });
      expect(t.handovers[0].from).toBe("frontend");        // 原作者就是链头
    });
  }

  it("owner 在听：接不走，而且拒绝话说得出是谁拿着、为什么此刻不行", async () => {
    const w = world();
    await upTo(w, "t-900", "working");
    await w.listen("frontend");                             // 它刚拉过日志 ⇒ 在听（说话不算，那是 deaf）
    const why = await tryTake(w, "t-900");
    expect(why).toContain("owner frontend");                // t-010 那条验过的断言要的那半
    expect(why).toContain("在听");
    expect(why).toContain("missing");                        // 说得出出路
    expect((await w.state()).tasks.get("t-900")!.owner).toBe("frontend");
  });

  /**
   * `deaf` 是「在干活但没在读日志」——**那种人没走，接他的活仍然是抢**。
   * 判据 3 说依据是 presence，而 presence 有三档；这一条钉住只有 `missing` 那一档开门。
   */
  it("owner 是 deaf（还在动，只是没读日志）：也接不走", async () => {
    const w = world();
    await upTo(w, "t-900", "working");
    w.jump(min(30));                                        // 过了「在听」的窗口
    await w.emit({ kind: "note", actor: "frontend", body: "我还在改" }, 0);   // 但它刚落过事件
    const why = await tryTake(w, "t-900");
    expect(why).toContain("owner frontend");
    expect(why).toContain("没在读日志");
    expect((await w.state()).tasks.get("t-900")!.owner).toBe("frontend");
  });

  it("接走之后原来那条链不因为再换一手而消失：两手都在", async () => {
    const w = world();
    await upTo(w, "t-900", "done");
    w.jump(LONG_GONE);
    await tryTake(w, "t-900");                               // frontend → dev
    w.jump(LONG_GONE);
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/t-900.ts"], actor: "qa" } as unknown as NewEvent);
    const t = (await w.state()).tasks.get("t-900")!;
    expect(t.owner).toBe("qa");
    expect(t.handovers.map((h) => `${h.from}→${h.to}`)).toEqual(["frontend→dev", "dev→qa"]);
  });

  it("自己 claim 自己的活，不算一次交接——链上不该多出一条", async () => {
    const w = world();
    await upTo(w, "t-900", "working");
    await w.emit({ kind: "task", op: "claim", task: "t-900", touches: ["src/more.ts"], actor: "frontend" } as unknown as NewEvent);
    expect((await w.state()).tasks.get("t-900")!.handovers).toEqual([]);
  });
});
