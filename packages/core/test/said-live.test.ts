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
  // **t-237 ④a（pd 09:08）改了这一格的断言，而它原来守的那一半仍然守着**：这一件此前报成「已成为任务」，
  // ① 把它从那儿救出来；pd 09:08 之后它落在「说不出上没上」而不是「已上线」——因为那个「包含」答的是祖先
  // 不是内容（修法在 t-325）。**两版共同禁的都是「已成为任务」**，这一格照旧钉着它。
  it("代码在生产跑的那一版里、还没人验 ⇒ 不再是「已成为任务」（① 救出来的那一态；pd 09:08 之后它叫「说不出上没上」）", async () => {
    const row = await status(await world({ contained: ["t-1"] }));
    expect(row.status, "① 之前这里是 task").not.toBe("task");
    expect(row.status).toBe("live_unknown");
    expect(row.label).toBe(SAID_LABEL.live_unknown);
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

/**
 * t-237 ④a（pd 09:08 定稿、pm 09:09／09:11 收成判据）：**一个词只对一件事实。**
 *
 * ① 让「已上线」读的是「判决 OR 包含」——**它只加了一个析取项，没有取代判决**（pm 09:07 更正了 pd 的前提；
 * 我 08:53 在 t-242 证据里也只说了「以 t-325 为界」，没说它根本没取代判决）。而那个「包含」答的是
 * 「那个提交是不是祖先」，不是「跑着的那一版里有没有它的内容」——这个项目的回滚刻意保留祖先、退回内容。
 *
 * 所以窗口期内只用两态：**有生产判决 → 「已上线，验过」；祖先成立但没判决 → 「说不出上没上」**，
 * 而后者**不许回落成「已成为任务」**（frontend 09:10 量到的那条：那是用一个较早的状态冒充一个答不出的状态）。
 * 它自己会结束：t-325 落地之后第三态自然可用，没有任何过渡文字要被谁记得删掉。
 */
describe("t-237 ④a · 判决说「已上线，验过」，祖先只说「说不出上没上」", () => {
  it("**有生产判决** ⇒ 「已上线，验过」，并带上它是哪一件", async () => {
    const row = await status(await world({ verified: true }));
    expect(row.status).toBe("live");
    expect(row.label).toBe("已上线，验过：闸自己说实话");
  });

  it("**祖先成立、没有判决** ⇒ 「说不出上没上」，而且**不是**「已成为任务」", async () => {
    const row = await status(await world({ contained: ["t-1"] }));
    expect(row.status, "这一态此前是 live，而它的全部依据只是包含关系").toBe("live_unknown");
    expect(row.label).toBe("说不出上没上");
    expect(row.label, "pd 点名禁的那一个：不许用一个较早的状态冒充一个答不出的状态").not.toContain("已成为任务");
  });

  it("**对照**：既没判决、也不在那条包含事实里 ⇒ 仍是「已成为任务」（新那一态没有把一切都吞掉）", async () => {
    const row = await status(await world({ contained: ["t-999"] }));
    expect(row.status).toBe("task");
    expect(row.label).toBe("已成为任务：闸自己说实话");
  });

  it("判决与包含同时成立 ⇒ 仍然是「已上线，验过」：判决这一支不经过包含关系，所以它不等 t-325", async () => {
    const row = await status(await world({ verified: true, contained: ["t-1"] }));
    expect(row.status).toBe("live");
    expect(row.label).toBe("已上线，验过：闸自己说实话");
  });
});
