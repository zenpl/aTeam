/**
 * t-237：**牌桌把「有没有生产判决」印成「有没有上线」，于是对人说一句假话。**
 *
 * qa 19:09 在生产上量到：这道闸对人说「修法在 t-160，已验（repo），**还没上生产**」——而 t-160 的 `bdbbfd1`
 * 就在生产跑的 `09256fd` 里。**它已经在跑，缺的只是没人在生产上验过它。** 两件事要分开说得出来：
 * ① 代码在不在生产跑的那一版里（包含关系，qa 今天用 git merge-base --is-ancestor 逐件测）；② 有没有生产判决。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, gateHonesty, gateFixKey, fixWhere, PROJECT_SURFACE, DEPLOYED_TASKS_KEY, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** 一道报过误报的闸，加一件被指为修法的任务（done、只在 repo 上验过）。 */
async function world(fact?: { contained: string[]; not_contained: string[] }) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: "roles", value: ["pm", "dev", "frontend", "qa"] }, -300);
  for (const [id, who] of [["t-a", "dev"], ["t-b", "frontend"]] as const) {
    await put({ kind: "task", actor: "pm", op: "create", task: id, title: `题 ${id}`, criteria: ["能用"], no_human_impact: true }, -200);
    await put({ kind: "task", actor: who, op: "claim", task: id, touches: ["packages/core/src/f.ts"] }, -190);
  }
  await put({ kind: "task", actor: "pm", op: "seam", tasks: ["t-a", "t-b"], resolution: "误报", verdict: "false" }, -100);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-160", title: "修法", criteria: ["能用"], no_human_impact: true }, -90);
  await put({ kind: "reading", actor: "pm", surface: PROJECT_SURFACE, key: gateFixKey("seam"), value: "t-160" }, -80);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-160", touches: ["packages/cli/src/touches.ts"] }, -70);
  await put({ kind: "task", actor: "dev", op: "done", task: "t-160", evidence: "bdbbfd1：做完了", no_human_impact: true }, -60);
  await put({ kind: "task", actor: "qa", op: "verify", task: "t-160", surface: "repo", pass: true, evidence: "仓库上核过" }, -50);
  if (fact) await put({ kind: "reading", actor: "release", surface: "production", key: DEPLOYED_TASKS_KEY, value: { sha: "09256fd", ...fact, unmeasured: [], method: "git-ancestor" } }, -40);
  return s;
}
const line = async (s: MemoryStore) => gateHonesty(reduce(await s.read(), at(0), HUMAN), "seam")!.line;
const fix = async (s: MemoryStore) => gateHonesty(reduce(await s.read(), at(0), HUMAN), "seam")!.fix!;

describe("t-237 判据 1、2 · 代码在不在生产跑的那一版里，与有没有人在生产上验过它", () => {
  it("qa 19:09 那一幕：代码在生产跑的那一版里、没人在生产上验过 ⇒ **不许说「还没上线」**", async () => {
    const s = await world({ contained: ["t-160"], not_contained: [] });
    expect(await fix(s)).toMatchObject({ task: "t-160", deployed: true, verified_in_production: false });
    const l = await line(s);
    expect(l).toContain("代码已经在生产跑的那一版里");
    expect(l).toContain("还没有人在生产上验过它");
    expect(l).not.toContain("还没上线");
    expect(l).not.toContain("还没上生产");
  });

  it("真没上线：事实明说它不在那一版里 ⇒ 照实说代码还不在", async () => {
    const s = await world({ contained: [], not_contained: ["t-160"] });
    expect(await fix(s)).toMatchObject({ deployed: false });
    expect(await line(s)).toContain("代码还不在生产跑的那一版里");
  });

  it("没有那条事实、或事实没覆盖它 ⇒ **说不出，不是「没上线」**（缺席与否定要分得开）", async () => {
    const none = await world();
    expect(await fix(none)).toMatchObject({ deployed: null });
    expect(await line(none)).toContain("说不出它的代码在不在生产跑的那一版里");
    const partial = await world({ contained: ["t-999"], not_contained: ["t-998"] });
    expect(await fix(partial)).toMatchObject({ deployed: null });
    expect(await line(partial)).toContain("说不出");
  });

  it("有了生产判决，这句实话自己消失——那一档没变（t-149 判据 2）", async () => {
    const s = await world({ contained: ["t-160"], not_contained: [] });
    await append(s, { kind: "task", actor: "qa", op: "verify", task: "t-160", surface: "production", pass: true, evidence: "生产上走过一遍" } as NewEvent, { human: HUMAN, now: at(-10) });
    expect(gateHonesty(reduce(await s.read(), at(0), HUMAN), "seam")).toBeNull();
  });

  it("那一句自己：四种状态各说各的，两件事都在里面", () => {
    const base = { task: "t-160", status: "done", verified_on: ["repo"] };
    expect(fixWhere({ ...base, deployed: true, verified_in_production: false })).toContain("代码已经在生产跑的那一版里");
    expect(fixWhere({ ...base, deployed: false, verified_in_production: false })).toContain("代码还不在生产跑的那一版里");
    expect(fixWhere({ ...base, deployed: null, verified_in_production: false })).toContain("说不出");
    expect(fixWhere({ ...base, deployed: true, verified_in_production: true })).toContain("已经有人在生产上验过它");
    // 已验的那几个表面还在句子里：人要知道它此刻验到哪一步
    expect(fixWhere({ ...base, deployed: true, verified_in_production: false })).toContain("已验：repo");
    expect(fixWhere({ ...base, verified_on: [], deployed: true, verified_in_production: false })).toContain("此刻 done");
  });
});
