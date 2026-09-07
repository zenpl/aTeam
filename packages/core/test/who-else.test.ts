/**
 * t-164（human 点名，pd 07:57）：claim 的那一刻就知道这块地上还有谁。
 *
 * 边界是**不做锁**。空闲的角色去别人的地盘不是错，错的是它到 done 的时候才发现屋里一直有人。所以这里只回答
 * 「此刻还有谁正在动我要动的东西」，不做任何判定——判定是接缝的事，在 done 时发生。
 *
 * 时间一律相对 now。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, whoElseTouches, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** 一个项目，几件在途、几件已完成，各自声明了触点。 */
async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "frontend", "qa"] }, -300);
  const make = async (id: string, who: string, title: string, touches: string[], mins: number) => {
    await put({ kind: "task", actor: "pm", op: "create", task: id, title, criteria: ["能用"] , no_human_impact: true}, mins - 1);
    await put({ kind: "task", actor: who, op: "claim", task: id, touches }, mins);
  };
  await make("t-页面", "frontend", "牌桌那一行", ["packages/server/src/html.ts", "packages/server/src/i18n.ts"], -60);
  await make("t-规则", "qa", "验收口径", ["packages/core/src/rules.ts"], -55);
  await make("t-我的别的活", "dev", "我自己手上的另一件", ["packages/core/src/board.ts"], -50);
  await make("t-做完了", "frontend", "已经交了的", ["packages/core/src/reduce.ts"], -45);
  await put({ kind: "task", actor: "frontend", op: "done", task: "t-做完了", evidence: "abc1234", no_human_impact: true }, -40);
  return { s, put, make };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-164 · 判据 1 与 6：一正一反，两个都跑过", () => {
  it("相交时逐条印出谁、哪件、碰在哪——按这句话真能找到那个角色与那件任务", async () => {
    const s = await st((await world()).s);
    const found = whoElseTouches(s, ["packages/server/src/html.ts"], "dev");
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ actor: "frontend", task: "t-页面", title: "牌桌那一行", overlap: ["packages/server/src/html.ts"] });
    // 「按印出来的那句话能找到那个角色与那件任务」：这两个字段真的指得到日志里的东西
    expect(s.tasks.get(found[0].task)!.owner).toBe(found[0].actor);
    expect(s.tasks.get(found[0].task)!.title).toBe(found[0].title);
  });

  it("不相交时一个字都不印", async () => {
    const s = await st((await world()).s);
    expect(whoElseTouches(s, ["packages/server/src/app.ts"], "dev")).toEqual([]);
    expect(whoElseTouches(s, [], "dev")).toEqual([]);
  });
});

describe("t-164 · 判据 3：只看在途，不算自己", () => {
  it("已经 done 的不算——那是接缝要判的事，不是「还有谁在」", async () => {
    const s = await st((await world()).s);
    expect(whoElseTouches(s, ["packages/core/src/reduce.ts"], "dev")).toEqual([]);
  });

  it("同一角色自己手上的别的活不算撞车", async () => {
    const s = await st((await world()).s);
    expect(whoElseTouches(s, ["packages/core/src/board.ts"], "dev")).toEqual([]);
    // 换一个人来问，同一块地上就有人了：排除的是「你自己」，不是那件活
    expect(whoElseTouches(s, ["packages/core/src/board.ts"], "frontend").map((x) => x.task)).toEqual(["t-我的别的活"]);
  });

  it("问的人自己刚 claim 的那件不算——它当然碰在自己声明的东西上", async () => {
    const w = await world();
    await w.make("t-新的", "dev", "我刚认领的", ["packages/server/src/html.ts"], -5);
    const s = await st(w.s);
    expect(whoElseTouches(s, ["packages/server/src/html.ts"], "dev", "t-新的").map((x) => x.task)).toEqual(["t-页面"]);
  });
});

describe("t-164 · 判据 7：不做锁", () => {
  it("它只是一个列表，没有任何判定——claim 本身不受影响", async () => {
    const w = await world();
    // 明知有人在 html.ts 上，仍然认领得下去：这正是要的行为
    await w.make("t-也去", "dev", "我也去动 html", ["packages/server/src/html.ts"], -3);
    const s = await st(w.s);
    expect(s.tasks.get("t-也去")!.status).toBe("working");
    expect(s.tasks.get("t-也去")!.owner).toBe("dev");
    expect(whoElseTouches(s, ["packages/server/src/html.ts"], "dev", "t-也去").map((x) => x.actor)).toEqual(["frontend"]);
  });

  it("目录与符号按触点本来的规矩算，不另立一套", async () => {
    const s = await st((await world()).s);
    expect(whoElseTouches(s, ["packages/server/src"], "dev").map((x) => x.task)).toEqual(["t-页面"]);           // 目录含它
    expect(whoElseTouches(s, ["packages/server/src/html.ts#live"], "dev").map((x) => x.task)).toEqual(["t-页面"]); // 同一文件的符号
    expect(whoElseTouches(s, ["packages/server"], "dev").map((x) => x.task)).toEqual(["t-页面"]);
  });

  it("多个人同时在，一人一条，按任务 id 排定顺序", async () => {
    const s = await st((await world()).s);
    const found = whoElseTouches(s, ["packages/server/src/html.ts", "packages/core/src/rules.ts"], "dev");
    // 顺序由任务 id 定（稳定、可复现），不由谁先 claim 定
    expect(found.map((x) => `${x.actor}/${x.task}`)).toEqual(["qa/t-规则", "frontend/t-页面"]);
    expect(found.map((x) => x.task)).toEqual([...found.map((x) => x.task)].sort());
  });
});
