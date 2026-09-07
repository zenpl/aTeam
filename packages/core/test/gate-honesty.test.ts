/**
 * t-149：一道闸知道自己不可信时，每条结论都要带上实话。
 *
 * 今晚接缝闸报了八条同一成因的结论，七条是误报、一条真接缝还同时漏报了两个真撞的文件——而闸自己一句都没说，
 * 每条结论仍然以同样的语气挡人。这里守两件事：**「不可信」是从日志算出来的，不是手写开关**；以及**它绝不替谁
 * 编一个数**——没人判过的既不算真也不算假，句子里如实说还有几条没判。
 *
 * 时间一律相对 now。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, slimBoard, gateHonesty, gateFixKey, PROJECT_SURFACE, Rejected, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** 一个项目：n 对任务各自真的碰在同一处，于是闸报出 n 条接缝。 */
async function world(pairs: number) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: "roles", value: ["pm", "dev", "frontend", "qa"] }, -300);
  const ids: [string, string][] = [];
  for (let i = 0; i < pairs; i++) {
    const a = `t-a${i}`, b = `t-b${i}`;
    for (const [id, who] of [[a, "dev"], [b, "frontend"]] as const) {
      await put({ kind: "task", actor: "pm", op: "create", task: id, title: `题 ${id}`, criteria: ["能用"] }, -200);
      await put({ kind: "task", actor: who, op: "claim", task: id, touches: [`packages/core/src/f${i}.ts`] }, -190 + i);
    }
    ids.push([a, b]);
  }
  return { s, put, ids };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-149 · 判据 2：「已知缺陷」由日志算出，不是手写开关", () => {
  it("没人判过任何一条：闸没有已知缺陷，那句话不出现，也不留占位符", async () => {
    const w = await world(3);
    const s = await st(w.s);
    expect(s.seams.size).toBe(3);
    expect(gateHonesty(s, "seam")).toBeNull();
    expect(board(s, HUMAN, at(0)).gate_honesty).toEqual([]);   // 判据 4：不是一个空句子，是根本没有
  });

  it("判过、且判出误报，但没有一件任务认领修法：仍然不算已知缺陷——没有修法可报，就不该拿一句半截的话挡人", async () => {
    const w = await world(2);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "两侧其实没碰同一处", verdict: "false" }, -10);
    expect(gateHonesty(await st(w.s), "seam")).toBeNull();
  });

  it("判出误报 + 修法还没在生产上验过：这才是已知缺陷", async () => {
    const w = await world(2);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "两侧其实没碰同一处", verdict: "false" }, -10);
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-fix", title: "按共同祖先算触点", criteria: ["每一侧只算自己改的"] }, -9);
    await w.put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" }, -8);
    const h = gateHonesty(await st(w.s), "seam")!;
    expect(h).toMatchObject({ gate: "seam", reported: 2, judged: 1, false_positives: 1, missed: 0, unjudged: 1 });
    expect(h.fix).toMatchObject({ task: "t-fix", status: "open", in_production: false });
  });

  it("修法已在生产上验过：缺陷不再是已知的，那句话自己消失，不用谁去关掉它", async () => {
    const w = await world(2);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "误报", verdict: "false" }, -10);
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-fix", title: "按共同祖先算触点", criteria: ["每一侧只算自己改的"] }, -9);
    await w.put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" }, -8);
    await w.put({ kind: "task", actor: "dev", op: "claim", task: "t-fix", touches: ["packages/cli/src/touches.ts"] }, -7);
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-fix", evidence: "abc1234" , no_human_impact: true}, -6);
    expect(gateHonesty(await st(w.s), "seam")!.fix).toMatchObject({ status: "done", in_production: false });
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-fix", surface: "production", pass: true, evidence: "生产上核过" }, -5);
    expect(gateHonesty(await st(w.s), "seam")).toBeNull();
  });
});

describe("t-149 · 判据 1：那句话说全五件事，且一个数都不编", () => {
  it("报过多少、判过几条是误报、漏没漏过、修法在哪、那件此刻在哪", async () => {
    const w = await world(8);
    // 七条误报，一条真接缝但闸同时漏报了它该报的文件——今晚的形状
    for (let i = 0; i < 7; i++) await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[i], resolution: `第 ${i + 1} 条：两侧其实没碰同一处`, verdict: "false" }, -20 + i);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[7], resolution: "真接缝，而且它还漏了两个真撞的文件", verdict: "real", missed: true }, -12);
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-fix", title: "按共同祖先算触点", criteria: ["每一侧只算自己改的"] }, -11);
    await w.put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" }, -10);
    await w.put({ kind: "task", actor: "dev", op: "claim", task: "t-fix", touches: ["packages/cli/src/touches.ts"] }, -9);
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-fix", evidence: "abc1234" , no_human_impact: true}, -8);
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-fix", surface: "repo", pass: true, evidence: "仓库上核过" }, -7);

    const h = gateHonesty(await st(w.s), "seam")!;
    expect(h).toMatchObject({ reported: 8, judged: 8, false_positives: 7, missed: 1, unjudged: 0 });
    expect(h.fix).toMatchObject({ task: "t-fix", verified_on: ["repo"], in_production: false });
    expect(h.line).toContain("报过 8 条");
    expect(h.line).toContain("7 条是误报");
    expect(h.line).toContain("1 条还漏报了");
    expect(h.line).toContain("修法在 t-fix");
    expect(h.line).toContain("已验（repo），还没上生产");
  });

  it("没人判过的那些如实说出来，不被算成任何一边", async () => {
    const w = await world(5);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "误报", verdict: "false" }, -10);
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-fix", title: "修", criteria: ["修好"] }, -9);
    await w.put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" }, -8);
    const h = gateHonesty(await st(w.s), "seam")!;
    expect(h).toMatchObject({ reported: 5, judged: 1, false_positives: 1, unjudged: 4 });
    expect(h.line).toContain("另有 4 条没人判过");
  });
});

describe("t-149 · 判据 3 与判决的写法", () => {
  it("判决是声明的字段，不是从散文里认出来的词——正文里同时出现两个判词也不会数错", async () => {
    const w = await world(2);
    // 今晚 01M1XAN1V2Z150HBEYY6RQQCGX 的形状：正文里「真接缝」与「假接缝」同时出现，后者在一句否定里
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "真接缝，但已被排期化解。这条不属于今晚那八条假接缝。", verdict: "real" }, -10);
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-fix", title: "修", criteria: ["修好"] }, -9);
    await w.put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" }, -8);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[1], resolution: "误报", verdict: "false" }, -7);
    const h = gateHonesty(await st(w.s), "seam")!;
    expect(h.false_positives).toBe(1);   // 只有真的那一条被判为 false，正文里的字一个都不算数
  });

  it("已经解决过的接缝还能补一个判决：只加判决，原来的解决一字不动；同一条不判两次", async () => {
    const w = await world(2);
    const first = await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "已由 frontend 执行完毕，不是待办", verdict: undefined }, -30);
    let seam = [...(await st(w.s)).seams.values()].find((x) => x.resolution)!;
    expect(seam.resolution).toMatchObject({ by: "pm", at: first.at, text: "已由 frontend 执行完毕，不是待办" });
    expect(seam.resolution!.verdict).toBeUndefined();
    // 补记：判决是后来才有的字段，今晚那些判断在它之前就做过了
    const judged = await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "回原文核过：与 t-138 同一成因，是误报", verdict: "false" }, -5);
    seam = [...(await st(w.s)).seams.values()].find((x) => x.resolution)!;
    expect(seam.resolution).toMatchObject({
      by: "pm", at: first.at, text: "已由 frontend 执行完毕，不是待办",   // 原来的解决一字未动
      verdict: "false", judged_by: "pm", judged_at: judged.at, judged_why: "回原文核过：与 t-138 同一成因，是误报",
    });
    // 判过就不再判第二次
    await expect(w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "再想想", verdict: "real" }, -4)).rejects.toThrow(/not made twice/);
    // 不带判决的第二条仍然被拒：解决只有一次
    await expect(w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "换个说法" }, -3)).rejects.toThrow(/already resolved/);
  });

  it("判决只收声明过的那几个值", async () => {
    const w = await world(1);
    await expect(w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "误报", verdict: "假" as never }, -10)).rejects.toThrow(Rejected);
  });

  it("判据 3：那句话在完整板上，不随瘦身板出门，也不是给人的卡", async () => {
    const w = await world(2);
    await w.put({ kind: "task", actor: "pm", op: "seam", tasks: w.ids[0], resolution: "误报", verdict: "false" }, -10);
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-fix", title: "修", criteria: ["修好"] }, -9);
    await w.put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-fix" }, -8);
    const b = board(await st(w.s), HUMAN, at(0));
    expect(b.gate_honesty).toHaveLength(1);
    expect(JSON.stringify(b.needs_human)).not.toContain("这道闸");   // 不生成给人的卡
    const slim = slimBoard(b);
    expect(slim.gate_honesty).toEqual([]);
    expect(slim.omitted).toContain("gate_honesty[1 of 1]");           // 略了什么、略了几条，板自己说
  });
});
