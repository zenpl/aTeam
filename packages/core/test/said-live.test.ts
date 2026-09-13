/**
 * t-242 ①：**`SAID_LABEL.live`（「已上线」）读的是「有人在生产上验过它」，而它说的是「它上线了」。**
 *
 * 这一句不是假话——没上线的东西验不了，所以有生产判决蕴含代码在跑——但它**报少了**：一件已经在生产上跑、
 * 还没有人验的，人那一页上显示成「已成为任务」。而人问的正是「我那句话落地了没有」。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, SAID_LABEL, SAID_PREFIX, DEPLOYED_TASKS_KEY, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** 人说过一句话 → pd 立成需求 → 一件任务认它 → （可选）它进了生产跑的那一版／被验过。 */
async function world(opts: { contained?: string[]; verified?: boolean }) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "pd"] }, -600);
  const said = await put({ kind: "note", actor: HUMAN, body: `${SAID_PREFIX}希望牌桌自己说它信不信得过` }, -500);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "闸自己说实话", criteria: ["能用"], refs: [said.id], no_human_impact: true }, -400);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["a.ts"] }, -390);
  await put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "bdbbfd1：做完了", no_human_impact: true }, -380);
  await put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: true, evidence: "仓库上核过" }, -370);
  if (opts.verified) await put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "生产上走过" }, -360);
  await put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "09256fdd1c4f17e79fa128b7bc97544a9f61f60a" }, -350);
  if (opts.contained) await put({ kind: "reading", actor: "release", surface: "production", key: DEPLOYED_TASKS_KEY, value: { sha: "09256fd", contained: opts.contained, not_contained: [], unmeasured: [], method: "git-ancestor" } }, -340);
  return s;
}
const status = async (s: MemoryStore) => board(reduce(await s.read(), at(0), HUMAN), HUMAN, at(0)).said[0];

describe("t-242 ① · 「已上线」读的是「它在生产跑的那一版里」", () => {
  it("代码在生产跑的那一版里、还没人验 ⇒ **已上线**（这正是它原来报少的那一态）", async () => {
    const row = await status(await world({ contained: ["t-1"] }));
    expect(row.status).toBe("live");
    expect(row.label).toContain(SAID_LABEL.live);
  });

  it("有生产判决 ⇒ 照旧算已上线（那条蕴含关系没变）", async () => {
    const row = await status(await world({ verified: true }));
    expect(row.status).toBe("live");
  });

  it("既不在那一版里、也没人验 ⇒ 仍是「已成为任务」，不许说成已上线", async () => {
    const row = await status(await world({ contained: ["t-999"] }));
    expect(row.status).toBe("task");
    expect(row.label).toContain(SAID_LABEL.task);
  });

  it("那条包含事实压根没有 ⇒ 也不许说成已上线（说不出不是「是」）", async () => {
    const row = await status(await world({}));
    expect(row.status).toBe("task");
  });
});
