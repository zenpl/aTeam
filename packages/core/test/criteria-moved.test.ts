/**
 * t-166：搬走的判据仍然列在原任务上，读的人只能靠 note 才知道。
 *
 * 今晚这事发生了两次：t-141 判据 3 搬到 t-148、t-149 判据 5 搬到 t-158。两次都只在 note 里说了一句，任务本身
 * 一字未改——于是 `task show` 上那一条看起来仍然是这件要满足的，只读判据不读 note 的人会去做一件已经不属于
 * 这件任务的事。修法不是删掉它（ids are forever，写下的判据也是），而是**在它旁边标一句谁接走了**。
 *
 * 时间一律相对 now。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, boardTask, Rejected, movedCriterion, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "pd", "dev", "qa"] }, -300);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-141", title: "旧件", criteria: ["判据一", "判据二", "搬走的那条"], no_human_impact: true }, -200);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-148", title: "接走的那件", criteria: ["接过来"], no_human_impact: true }, -195);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-141", touches: ["x"] }, -190);
  return { s, put };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-166 · 判据 1：标注，不是删除", () => {
  it("标过之后原文一字不动，判据条数不变，只是多了一句「谁接走了」", async () => {
    const w = await world();
    const before = (await st(w.s)).tasks.get("t-141")!.criteria;
    await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100);
    const t = (await st(w.s)).tasks.get("t-141")!;
    expect(t.criteria).toEqual(before);                       // 原文不动
    expect(t.criteria).toHaveLength(3);                       // 条数不变：没有被删
    expect(t.criteria[2]).toBe("搬走的那条");
    expect(t.criteria_moved).toEqual([{ index: 3, to: "t-148", by: "pm", at: expect.any(String) }]);
  });

  it("标注本身是一条事件：日志里查得到是谁、什么时候标的（判据 4 的后半）", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100);
    const log = (await w.s.read()).events;
    const e = log.find((x) => x.kind === "task" && x.op === "criteria") as (NewEvent & { moved?: unknown; id: string }) | undefined;
    expect(e).toBeDefined();
    expect(e!.actor).toBe("pm");
    expect(e!.moved).toEqual({ index: 3, to: "t-148" });
    expect(e!.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);        // 有 id，可被 refs 指、可被 trace 走到
  });

  it("同一条再标一次，改的是承接方，不是又多出一条记录", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-158", title: "第三件", criteria: ["c"], no_human_impact: true }, -190);
    await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100);
    await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-158" } }, -90);
    const t = (await st(w.s)).tasks.get("t-141")!;
    expect(t.criteria_moved).toHaveLength(1);
    expect(t.criteria_moved[0].to).toBe("t-158");
  });
});

describe("t-166 · 判据 4：只有判据作者、pm 或 human 能标", () => {
  it("dev（干活的人）标不了自己被要求满足的判据", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "dev", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100).catch((e) => e as Rejected);
    expect(err).toBeInstanceOf(Rejected);
    expect(err.rule).toBe("criteria");
    expect(err.message).toContain("pm");                       // 说得出谁可以
  });

  it("pd 能追加判据，却标不了搬迁——两道闸宽严不同，这里把差别钉死", async () => {
    const a = await world();
    await a.put({ kind: "task", actor: "pd", op: "criteria", task: "t-141", add: ["pd 追加的"] }, -110);   // 追加：过
    expect((await st(a.s)).tasks.get("t-141")!.criteria).toHaveLength(4);
    // 另起一份日志，免得上面那次追加把 pd 变成判据作者——那样这道闸就不是被 pd 的身份挡住的了
    const w = await world();
    const err = await w.put({ kind: "task", actor: "pd", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100).catch((e) => e as Rejected);
    expect(err).toBeInstanceOf(Rejected);
    expect(err.message).toContain("pd");                       // 拒绝话点了它的名
  });

  it("human 能标", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: HUMAN, op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100);
    expect((await st(w.s)).tasks.get("t-141")!.criteria_moved[0].by).toBe(HUMAN);
  });
});

describe("t-166 · 标不了的四种情况，每种说一句不同的话", () => {
  it("序号超出范围：说出这件共几条", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 9, to: "t-148" } }, -100).catch((e) => e as Rejected);
    expect(err.message).toContain("只有 3 条判据");
  });

  it("序号是 0 或小数：序号从 1 起，就是人读到的那个数", async () => {
    const w = await world();
    for (const index of [0, -1, 1.5]) {
      const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index, to: "t-148" } }, -100).catch((e) => e as Rejected);
      expect(err.message).toContain("从 1 起的整数");
    }
  });

  it("搬到一件不存在的任务上：判据不能搬进空气里", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-999" } }, -100).catch((e) => e as Rejected);
    expect(err.message).toContain("t-999");
    expect(err.message).toContain("不是这个日志里的任务");
  });

  it("搬到它自己身上：拒", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-141" } }, -100).catch((e) => e as Rejected);
    expect(err.message).toContain("搬不到它自己身上");
  });

  it("add 与 moved 一个都不给：这条事件什么也没说，形状闸挡下，两个名字都点出来", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141" } as NewEvent, -100).catch((e) => e as Rejected);
    expect(err.rule).toBe("shape");
    expect(err.message).toContain("add");
    expect(err.message).toContain("moved");
  });

  it("moved 写歪了（字段名错、类型错）读起来和缺了一样，也是形状闸，不是崩", async () => {
    const w = await world();
    for (const moved of ["t-148", 3, { to: "t-148" }, { index: 3 }, ["t-148", 3]]) {
      const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved } as unknown as NewEvent, -100).catch((e) => e as Rejected);
      expect(err, JSON.stringify(moved)).toBeInstanceOf(Rejected);
      expect(err.rule, JSON.stringify(moved)).toBe("shape");
    }
  });

  it("已 verified 的件不能再标：它的判据就是当时被判的那些", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-141", evidence: "abc1234", no_human_impact: true }, -120);
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-141", surface: "repo", pass: true, evidence: "看过了：判据 1、2、3" }, -110);
    const err = await w.put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100).catch((e) => e as Rejected);
    expect(err).toBeInstanceOf(Rejected);
    expect(err.message).toContain("verified");
  });
});

describe("t-166 · 判据 3：今晚那两次要能重放", () => {
  it("t-141 判据 3 搬到 t-148、t-149 判据 5 搬到 t-158：标完之后牌桌上这两条都带着承接方", async () => {
    const s = new MemoryStore();
    const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
    await put({ kind: "task", actor: "pm", op: "create", task: "t-141", title: "一件", criteria: ["a", "b", "搬到 t-148 的那条"], no_human_impact: true }, -200);
    await put({ kind: "task", actor: "pm", op: "create", task: "t-148", title: "接手", criteria: ["a"], no_human_impact: true }, -199);
    await put({ kind: "task", actor: "pm", op: "create", task: "t-149", title: "另一件", criteria: ["a", "b", "c", "d", "搬到 t-158 的那条"], no_human_impact: true }, -198);
    await put({ kind: "task", actor: "pm", op: "create", task: "t-158", title: "接手二", criteria: ["a"], no_human_impact: true }, -197);
    await put({ kind: "task", actor: "dev", op: "claim", task: "t-141", touches: ["x"] }, -190);
    await put({ kind: "task", actor: "dev", op: "claim", task: "t-149", touches: ["y"] }, -189);
    await put({ kind: "task", actor: "pm", op: "criteria", task: "t-141", moved: { index: 3, to: "t-148" } }, -100);
    await put({ kind: "task", actor: "pm", op: "criteria", task: "t-149", moved: { index: 5, to: "t-158" } }, -99);

    const b = board(reduce(await s.read(), at(0)), HUMAN, at(0));
    const find = (id: string) => boardTask(b, id)!;
    expect(find("t-141").criteria_moved).toEqual([{ index: 3, to: "t-148", by: "pm", at: expect.any(String) }]);
    expect(find("t-149").criteria_moved).toEqual([{ index: 5, to: "t-158", by: "pm", at: expect.any(String) }]);
    // 没被标的那些不带这个字段——否则「搬走了」就成了每条判据都有的噪音
    expect(find("t-148").criteria_moved).toBeUndefined();
    // 承接方写在句子里，读的人不用再去翻 note 才知道该看哪一件
    expect(movedCriterion("t-148")).toContain("t-148");
  });
});
