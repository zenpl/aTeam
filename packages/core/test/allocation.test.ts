/**
 * t-061 · 分配预警: five patterns from responsibilities.md, one entry each at most, with numbers; nothing is rejected.
 * Times are relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, allocation, staticAllocation, runtimeAllocation, similarity, saidHops, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const min = (n: number) => n * 60_000;

function world(startAgoMs = min(120)) {
  const store = new MemoryStore();
  let t = Date.now() - startAgoMs;
  const at = () => new Date(t);
  const emit = (e: NewEvent, plus = min(1)) => { t += plus; return append(store, e, { human: HUMAN, now: at() }); };
  const state = async () => reduce(await store.read(), at());
  return { store, emit, at, state };
}
const pack = (w: ReturnType<typeof world>, value: unknown) => w.emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value });

describe("static checks on the declared packing", () => {
  it("重叠: one responsibility in two role sets without a boundary; a boundary next to the id clears it; the default packing is never judged", async () => {
    const w = world();
    expect(staticAllocation(await w.state())).toEqual([]); // default five roles: dev+frontend on R5 by design
    await pack(w, { pm: ["R1", "R3", "R4"], dev: ["R5", "R9"], frontend: ["R5", "R9"], qa: ["R6"] });
    let ws = staticAllocation(await w.state());
    expect(ws.map((x) => x.pattern)).toEqual(["重叠"]);
    expect(ws[0].evidence).toEqual(["R5 由 dev、frontend 同时持有，没有分界", "R9 由 dev、frontend 同时持有，没有分界"]);
    expect(ws[0].hint).toBe("R5 由 dev 和 frontend 同时持有，没有分界。建议：一个持有，另一个只提 concern。");
    await pack(w, { pm: ["R1", "R3", "R4"], dev: ["R5:数据侧", "R9"], frontend: ["R5:页面侧", "R9:只推自己的分支"], qa: ["R6"] });
    ws = staticAllocation(await w.state());
    expect(ws).toEqual([]);
    expect(board(await w.state(), HUMAN, w.at()).coverage.find((c) => c.responsibility === "R5")!.holders).toEqual(["dev", "frontend"]); // the id still counts as held
  });

  it("打破独立审核: R3+R6 or R5+R6 in one role without an owner degradation; the declaration clears it", async () => {
    const w = world();
    await pack(w, { writer: ["R5"], reviewer: ["R1", "R3", "R6"] });
    let ws = staticAllocation(await w.state());
    expect(ws).toEqual([{ pattern: "打破独立审核", evidence: ["reviewer 同时持有 R3 与 R6，没有 owner 退化声明"], hint: "reviewer 同时持有 R3 与 R6。它定标准的东西只能由 owner 验；建议把 R3 交给 owner 或再起一个角色。" }]);
    await pack(w, { writer: ["R5"], reviewer: ["R1", "R3", "R6:自定标准的退化给 owner"] });
    ws = staticAllocation(await w.state());
    expect(ws).toEqual([]);
    await pack(w, { writer: ["R5", "R6"], reviewer: ["R1", "R3"] });
    expect(staticAllocation(await w.state())[0].hint).toContain("writer 同时持有 R5 与 R6。它做的东西只能由 owner 验");
  });

  it("负载陷阱: one role holds far more than the others; a two-node team is exempt", async () => {
    const w = world();
    await pack(w, { pm: ["R1", "R3", "R4", "R8", "R11", "R13"], dev: ["R5"], qa: ["R6"] });
    let ws = staticAllocation(await w.state());
    expect(ws).toEqual([{ pattern: "负载陷阱", evidence: ["pm 持有 6 项职责，其他角色中位数 1 项"], hint: "pm 持有 6 项职责（R1 R3 R4 R8 R11 R13），其他角色中位数 1。建议：把能改成规则或服务的职责先拿走。" }]);
    await pack(w, { pm: ["R1", "R3", "R4", "R8", "R11", "R13"], dev: ["R5", "R9", "R7"] });
    expect(staticAllocation(await w.state())).toEqual([]); // 最小团队
    await pack(w, { pm: ["R1", "R3", "R4"], dev: ["R5", "R9"], qa: ["R6", "R7"] });
    expect(staticAllocation(await w.state())).toEqual([]); // evenly spread
  });
});

describe("runtime metrics over the last window", () => {
  it("低效: seams resolved by one role, a slow acker, a deep verify queue; quiet teams show nothing", async () => {
    const w = world();
    expect(runtimeAllocation(await w.state(), w.at(), HUMAN)).toEqual([]);
    for (let i = 1; i <= 6; i++) {
      await w.emit({ kind: "task", op: "create", actor: "pm", task: `a${i}`, title: `a${i}`, criteria: ["x"] });
      await w.emit({ kind: "task", op: "create", actor: "pm", task: `b${i}`, title: `b${i}`, criteria: ["x"] });
      await w.emit({ kind: "task", op: "claim", actor: "dev", task: `a${i}`, touches: [`f${i}`] });
      await w.emit({ kind: "task", op: "claim", actor: "frontend", task: `b${i}`, touches: [`f${i}`] });
      await w.emit({ kind: "task", op: "seam", actor: i === 6 ? "dev" : "pm", tasks: [`a${i}`, `b${i}`], resolution: "dev 合" });
    }
    let ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws.map((x) => x.pattern)).toEqual(["低效"]);
    expect(ws[0].evidence).toEqual(["接缝 83% 由 pm 手工解决（5/6）"]);
    expect(ws[0].hint).toBe("接缝 83% 由 pm 手工解决（5/6）。建议：把靠人手工做的改成规则或服务；等验的先验。");
    // five tasks done and waiting: the queue is deep
    for (let i = 1; i <= 5; i++) await w.emit({ kind: "task", op: "done", actor: "dev", task: `a${i}` });
    ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws[0].evidence[1]).toBe("等验队列 5 件（a1、a2、a3、a4、a5）");
    // qa acks in a minute, dev takes half an hour, three times each
    for (let i = 0; i < 3; i++) {
      const toQa = await w.emit({ kind: "instruction", actor: "pm", to: "qa", body: `验 a${i + 1}`, ack_by: new Date(w.at().getTime() + min(60)).toISOString() });
      await w.emit({ kind: "ack", actor: "qa", of: toQa.id }, min(1));
      const toDev = await w.emit({ kind: "instruction", actor: "pm", to: "dev", body: `改 b${i + 1}`, ack_by: new Date(w.at().getTime() + min(60)).toISOString() });
      await w.emit({ kind: "ack", actor: "dev", of: toDev.id }, min(30));
    }
    ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws[0].evidence).toContain("dev 的 ack 延迟 p90 30 分钟，其他角色中位数 1 分钟");
    expect(ws.filter((x) => x.pattern === "低效")).toHaveLength(1); // one entry, three findings
  });

  it("无效上下文移交: a forwarded instruction, and a sentence that took more than two hops to a task", async () => {
    const w = world();
    const ackBy = () => new Date(w.at().getTime() + min(60)).toISOString();
    await w.emit({ kind: "instruction", actor: HUMAN, to: "pm", body: "日志里全部写中文，代码标识符除外", ack_by: ackBy() });
    for (const to of ["dev", "qa"]) await w.emit({ kind: "instruction", actor: "pm", to, body: "human 说：日志里全部写中文，代码标识符除外", ack_by: ackBy() });
    let ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws.map((x) => x.pattern)).toEqual(["无效上下文移交"]);
    expect(ws[0].evidence[0]).toBe("pm 十分钟内转发了 2 条别人的话（正文相似度 ≥ 0.6）");
    // said → pd requirement → pm note → task: three hops
    const said = await w.emit({ kind: "note", actor: HUMAN, body: "human 说：登录后回到原页" });
    const req = await w.emit({ kind: "note", actor: "pd", body: "需求：登录后回到原页", decision: true, refs: [said.id] });
    const relay = await w.emit({ kind: "note", actor: "pm", body: "转述：登录后回到原页", refs: [req.id] });
    await w.emit({ kind: "task", op: "create", actor: "pm", task: "t-9", title: "登录后回到原页", criteria: ["x"], refs: [relay.id] });
    await w.emit({ kind: "task", op: "create", actor: "pm", task: "t-8", title: "直接的", criteria: ["x"], refs: [req.id] });
    expect(saidHops(await w.state(), HUMAN)).toEqual([{ task: "t-9", hops: 3 }, { task: "t-8", hops: 2 }]);
    ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws[0].evidence[1]).toBe("1 句「说一句」到任务超过两跳（t-9: 3 跳）");
    // two different instructions are not a forward
    expect(similarity("改 t-1 的判据", "部署第五批")).toBeLessThan(0.6);
    expect(similarity("human 说：日志里全部写中文，代码标识符除外", "日志里全部写中文，代码标识符除外")).toBeGreaterThanOrEqual(0.6); // a prefix added by the forwarder
  });

  it("重叠 (runtime): two decisions on one task within ten minutes that do not supersede each other; a supersede clears it", async () => {
    const w = world();
    await w.emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "x", criteria: ["x"] });
    const a = await w.emit({ kind: "note", actor: "pd", body: "决策：A", decision: true, task: "t-1" });
    await w.emit({ kind: "note", actor: "pm", body: "决策：B", decision: true, task: "t-1" });
    let ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws.map((x) => x.pattern)).toEqual(["重叠"]);
    expect(ws[0].evidence[0]).toMatch(/^t-1 十分钟内有两条互不取代的决策（pd \w+ 与 pm \w+）$/);
    const w2 = world();
    await w2.emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "x", criteria: ["x"] });
    const a2 = await w2.emit({ kind: "note", actor: "pd", body: "决策：A", decision: true, task: "t-1" });
    await w2.emit({ kind: "note", actor: "pm", body: "决策：B", decision: true, task: "t-1", supersedes: a2.id });
    expect(runtimeAllocation(await w2.state(), w2.at(), HUMAN)).toEqual([]);
    void a;
  });

  it("负载陷阱 (runtime): one recipient gets most instructions; a sender corrects itself within ten minutes; below the bar nothing", async () => {
    const w = world();
    const ackBy = () => new Date(w.at().getTime() + min(60)).toISOString();
    for (let i = 0; i < 8; i++) await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: `第 ${i} 件事，各不相同：${"甲乙丙丁戊己庚辛"[i]}`, ack_by: ackBy() }, min(12));
    for (let i = 0; i < 3; i++) await w.emit({ kind: "instruction", actor: "qa", to: "dev", body: `修 ${i}：${"壬癸子丑"[i]}`, ack_by: ackBy() }, min(12));
    let ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws).toEqual([{ pattern: "负载陷阱", evidence: ["pm 收到 73% 的指令（8/11）"], hint: "pm 收到 73% 的指令（8/11）。建议：把它持有的、能改成规则或服务的职责先拿走。" }]);
    // pd sends two more to pm within a minute of each other: corrections
    await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "更正：改成寅", ack_by: ackBy() }, min(12));
    await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: "再更正：卯", ack_by: ackBy() }, min(1));
    ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws[0].evidence).toEqual(["pm 收到 77% 的指令（10/13）", "pd 10% 的指令在十分钟内被自己更正（1/10）"].filter((_, i) => i === 0)); // 10% is under the 15% bar
    for (let i = 0; i < 2; i++) await w.emit({ kind: "instruction", actor: "pd", to: "pm", body: `又更正 ${i}`, ack_by: ackBy() }, min(1));
    ws = runtimeAllocation(await w.state(), w.at(), HUMAN);
    expect(ws[0].evidence[1]).toBe("pd 25% 的指令在十分钟内被自己更正（3/12）");
  });

  it("the board carries all five at most once each, and never rejects anything", async () => {
    const w = world();
    await pack(w, { pm: ["R1", "R3", "R4", "R8", "R11", "R13"], reviewer: ["R3", "R6"], dev: ["R5", "R9"], frontend: ["R5"] });
    const b = board(await w.state(), HUMAN, w.at());
    expect(b.allocation.warnings.map((x) => x.pattern)).toEqual(["重叠", "打破独立审核", "负载陷阱"]);
    expect(b.allocation.summary).toBe("分配：3 条预警（重叠、打破独立审核、负载陷阱）");
    expect(b.needs_human).toEqual([]);
    expect(allocation(await w.state(), w.at(), HUMAN).length).toBeLessThanOrEqual(5);
    expect(board(await world().state(), HUMAN).allocation.summary).toBe("分配：没有预警");
  });
});
