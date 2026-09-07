/**
 * t-032: from a change that shipped back to what asked for it, who decided, and who judged it where.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, SAID_PREFIX, type NewEvent, type Event } from "@ateam/core";
import { trace, tasksForSha, evidenceNames } from "../src/trace.js";

const HUMAN = "human";

async function story() {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  const said = await emit({ kind: "note", actor: HUMAN, body: `${SAID_PREFIX}登录后应该回到我刚才那页` });
  const req = await emit({ kind: "note", actor: "pd", body: "场景需求：登录回跳到原页", decision: true, refs: [said.id] });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-40", title: "登录后回到原页", criteria: ["登录后落在原页", "无回跳参数时回首页"], refs: [said.id, req.id] });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-41", title: "别的任务", criteria: ["x"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-40", touches: ["auth/login.ts", "auth.redirect"] });
  const d1 = await emit({ kind: "note", actor: "pm", body: "决策：回跳只认站内地址", decision: true, refs: [req.id] });
  await emit({ kind: "note", actor: "dev", body: "concern: 开放回跳有钓鱼风险", task: "t-40" });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-40", evidence: "abc1234def：login.ts 校验 next 参数为站内路径" , no_human_impact: true});
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-40", surface: "repo", pass: false, evidence: "缺 //evil 用例" });
  await emit({ kind: "task", op: "reopen", actor: "dev", task: "t-40", reason: "补 //evil 用例" });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-40", evidence: "9876543abc：补用例" , no_human_impact: true});
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-40", surface: "repo", pass: true, evidence: "tests green" });
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-40", surface: "production", pass: true, evidence: "curl 回跳正确" });
  await emit({ kind: "note", actor: "pm", body: "决策：回跳也认白名单外链", decision: true, supersedes: d1.id });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-41", touches: ["auth/login.ts"] });
  await emit({ kind: "task", op: "done", actor: "frontend", task: "t-41", evidence: "abc1234def 同一个提交里顺手改的" , no_human_impact: true});
  return (await store.read()).events as Event[];
}

describe("t-032 · ateam trace <task-id>", () => {
  it("tells the story in time order: sentence, requirement, criteria, claim, decisions, notes, evidence, every verify", async () => {
    const lines = trace(await story(), "t-40")!;
    const text = lines.join("\n");
    expect(lines[0]).toBe("回溯 t-40  登录后回到原页");
    const order = ["创建任务：登录后回到原页", "判据 1. 登录后落在原页", "判据 2. 无回跳参数时回首页",
      "依据 → human 说：登录后应该回到我刚才那页", "依据 → 决策（pd）：场景需求：登录回跳到原页",
      "认领；touches：auth/login.ts, auth.redirect", "决策：决策：回跳只认站内地址", "任务 note：concern: 开放回跳有钓鱼风险",
      "完成；证据：abc1234def", "验收 repo ✗ 未通过：缺 //evil 用例", "重开：补 //evil 用例", "完成；证据：9876543abc",
      "验收 repo ✓ 通过：tests green", "验收 production ✓ 通过：curl 回跳正确", "决策：决策：回跳也认白名单外链（取代"];
    let pos = -1;
    for (const needle of order) { const i = text.indexOf(needle); expect(i, needle).toBeGreaterThan(pos); pos = i; }
    // the other task's events are not in this story
    expect(text).not.toContain("别的任务");
    expect(text).not.toContain("frontend");
    // the requirement itself is shown once, as the task's basis, not again as a decision
    expect(text.split("场景需求：登录回跳到原页").length - 1).toBe(1);
  });

  it("unknown task: null", async () => {
    expect(trace(await story(), "t-99")).toBeNull();
  });
});

describe("t-032 · ateam trace <sha>", () => {
  it("lists every task whose done evidence names the sha, short or long form, then tells each story", async () => {
    const events = await story();
    expect(tasksForSha(events, "abc1234")).toEqual(["t-40", "t-41"]);
    expect(tasksForSha(events, "abc1234def")).toEqual(["t-40", "t-41"]);
    expect(tasksForSha(events, "9876543")).toEqual(["t-40"]);
    const lines = trace(events, "abc1234def")!;
    expect(lines[0]).toBe("sha abc1234def 出现在 2 个任务的完成证据里：t-40、t-41");
    expect(lines).toContain("回溯 t-40  登录后回到原页");
    expect(lines).toContain("回溯 t-41  别的任务");
    expect(evidenceNames("见 abc1234def 提交", "abc1234")).toBe(true);
    expect(evidenceNames("见 abc1234 提交", "abc1234def")).toBe(true);
    expect(evidenceNames("added defaced", "abc1234")).toBe(false);
  });

  it("no match: null", async () => {
    expect(trace(await story(), "0000000")).toBeNull();
    expect(tasksForSha([], "abc1234")).toEqual([]);
  });
});
