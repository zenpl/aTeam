/**
 * t-288 判据 7：**`done` 被接缝挡住时，那句「与对方定下来」在对侧缺人时没有出路。**
 *
 * 真样本是 dev `04:19`：`t-287+t-248` 被挡，而 `t-248` 是 blocked、主人 `frontend` 缺席 145 小时。
 * 那句提示唯一可执行的读法就是「自己定」——**于是它把「替不在场的人做决定」教成了唯一的动作**，
 * 而闸挡的正是这一刻。dev 照做了，qa `04:24` 报了，pm `04:26` 裁了。这一份把那条裁决钉成三支。
 *
 * **在场判断只有一处**（`presenceStatus`），这里不再写一份——t-287 刚为「两把尺」付过账。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, validate, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = new Date("2026-09-19T00:00:00.000Z");
const FILE = "packages/core/src/store.ts";   // 不是人可见的那一族：换成 html.ts 会先撞上「说一句人能看到什么」那道闸，量的就不是这条了

/**
 * 两件在途的活，两个人；`t-248` 归 frontend，`t-x` 归 dev。`t-x` claim 时只声明 `a.ts`，
 * `done` 时说出它其实也碰了 `FILE`——**这才是那条「按实际改动重算接缝」的闸真正会响的那一刻**。
 * `pmAt` 给 pm 一条晚到的事件，用来单独把 pm 拉回在场。
 */
async function world(pmAt?: Date) {
  const s = new MemoryStore();
  const put = (e: NewEvent, at: Date) => append(s, e, { human: HUMAN, now: at });
  for (const [id, who, touches] of [["t-248", "frontend", [FILE]], ["t-x", "dev", ["a.ts"]]] as const) {
    await put({ kind: "task", op: "create", actor: "pm", task: id, title: "一件", criteria: ["x"], no_human_impact: true }, T0);
    await put({ kind: "task", op: "claim", actor: who, task: id, touches: [...touches] }, T0);
  }
  if (pmAt) await put({ kind: "note", actor: "pm", body: "pm 还在" }, pmAt);
  return await s.read();
}
const doneEvent = { kind: "task", op: "done", actor: "dev", task: "t-x", evidence: "abc: 做完了", no_human_impact: true, touches: ["a.ts", FILE] } as NewEvent;

/** 跑那道闸，把拒绝话拿出来。**它必须真的被挡住**——挡不住就没有这句话，用例也就没在量它要量的东西。 */
function blockedMessage(log: Awaited<ReturnType<typeof world>>, now: Date): string {
  const st = reduce(log, now, HUMAN);
  try { validate(st, doneEvent, HUMAN, now); } catch (e) { return (e as Error).message; }
  throw new Error("这件 done 没有被接缝挡住——用例的前提不成立了");
}

const MIN = 60_000, DAY = 24 * 3600_000;

describe("t-288 判据 7 · 拒绝话要认得出「对侧此刻没人在场」", () => {
  it("对侧在场：一个字没变，照旧「与对方定下来」", async () => {
    const now = new Date(T0.getTime() + MIN);
    const m = blockedMessage(await world(), now);
    expect(m).toContain("再与对方定下来");
    expect(m).toContain('task seam t-x t-248 --resolution "..."');
    expect(m, "在场时不该冒出 pm 那一支").not.toContain("tell pm");
  });

  it("**对侧缺人、pm 在场：教的是先 tell pm，而不是自己定**", async () => {
    const now = new Date(T0.getTime() + DAY);
    const m = blockedMessage(await world(new Date(now.getTime() - MIN)), now);
    expect(m, "点得出是谁不在").toContain("frontend");
    expect(m).toContain("不在场");
    expect(m).toContain("先 tell pm");
    expect(m, "**这一刻不许再教人自己定**").not.toContain("再与对方定下来");
  });

  it("对侧与 pm 都不在场：可以自解，但要在同一条 resolution 里写明「pm 未在场，我自解」", async () => {
    const now = new Date(T0.getTime() + DAY);
    const m = blockedMessage(await world(), now);
    expect(m).toContain("pm 未在场，我自解");
    expect(m, "这一支才给得出那条命令").toContain('task seam t-x t-248 --resolution "..."');
    expect(m).not.toContain("先 tell pm");
  });

  it("三支互斥：同一条被挡的 done，三种在场组合给出三句不同的话", async () => {
    const here = blockedMessage(await world(), new Date(T0.getTime() + MIN));
    const now = new Date(T0.getTime() + DAY);
    const pmOnly = blockedMessage(await world(new Date(now.getTime() - MIN)), now);
    const none = blockedMessage(await world(), now);
    expect(new Set([here, pmOnly, none]).size, "三句两两不同").toBe(3);
    for (const m of [here, pmOnly, none]) {
      expect(m, "被挡的理由本身三支都照旧说得出").toContain("按实际改动重算接缝");
    }
  });
});
