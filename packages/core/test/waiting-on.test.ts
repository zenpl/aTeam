/**
 * t-231：**牌桌说「等谁」时取的是 owner，于是它会让人去问一个被禁止动这件事的人。**
 *
 * qa 16:33 在生产上走那四行，两行是错的：t-094 印「等 qa」——**而规矩不许 qa 验自己**，pm 129 小时前已经把它
 * 挂给 human，那张卡至今未答；t-227 实际在等 qa 却印「等 dev」。**等错人与等反了，是同一处写法的两种错法。**
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, waitingOn, waitingOnLine, NOBODY_WAITING, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world(roles: string[] = ["pm", "dev", "qa"]) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins = -300) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: roles });
  return { s, put };
}
const boardAt = async (w: { s: MemoryStore }) => board(reduce(await w.s.read(), at(0), HUMAN), HUMAN, at(0));
const task = async (w: Awaited<ReturnType<typeof world>>, id: string, by: string, owner: string, to: "done" | "working" = "done") => {
  await w.put({ kind: "task", actor: by, op: "create", task: id, title: id, criteria: ["能用"], no_human_impact: true }, -200);
  await w.put({ kind: "task", actor: owner, op: "claim", task: id, touches: [`src/${id}.ts`] }, -190);
  if (to === "done") await w.put({ kind: "task", actor: owner, op: "done", task: id, evidence: "abc1234：做完了", no_human_impact: true }, -180);
};
const of = (b: Awaited<ReturnType<typeof boardAt>>, id: string) => Object.values(b.tasks).flat().find((t) => t.id === id)!;

describe("t-231 判据 1、2、3 · 「等谁」按状态算，不按 owner 算", () => {
  it("判据 3：dev 做完、pm 写的判据 ⇒ 等的是能落 pass 的 qa，不是 dev（t-227 那一行：等反了）", async () => {
    const w = await world();
    await task(w, "t-227", "pm", "dev");
    expect(of(await boardAt(w), "t-227").waiting_on).toEqual(["qa"]);
  });

  it("判据 2（最重的那一行）：qa 自己做的、自己写的判据 ⇒ 等的是 human，**不是 qa**——规矩不许它验自己", async () => {
    const w = await world();
    await task(w, "t-094", "qa", "qa");
    expect(of(await boardAt(w), "t-094").waiting_on).toEqual([HUMAN]);
  });

  it("在途的那一件等的是 owner；没人认领的、已验的，没有人在等它（判据 4：不拿 owner 充数）", async () => {
    const w = await world();
    await task(w, "t-1", "pm", "dev", "working");
    await w.put({ kind: "task", actor: "pm", op: "create", task: "t-2", title: "没人认领", criteria: ["能用"], no_human_impact: true }, -200);
    await task(w, "t-3", "pm", "dev");
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-3", surface: "repo", pass: true, evidence: "跑过了" }, -100);
    const b = await boardAt(w);
    expect(of(b, "t-1").waiting_on).toEqual(["dev"]);
    expect(of(b, "t-2").waiting_on).toEqual([]);
    expect(of(b, "t-3").waiting_on, "验过了就没人在等它").toEqual([]);
  });

  it("与那道闸读同一份判断：闸不许谁落 pass，页面就不会指着谁", async () => {
    const w = await world();
    await task(w, "t-094", "qa", "qa");
    const s = reduce(await w.s.read(), at(0), HUMAN);
    const t = s.tasks.get("t-094")!;
    expect(waitingOn(s, t, HUMAN)).toEqual([HUMAN]);
    // 再加一个持验收职责的角色：那一件立刻有人等了，页面与闸一起变
    await w.put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: { pm: ["R1"], dev: ["R4"], qa: ["R5", "R6"], qa2: ["R6"] } }, -50);
    const s2 = reduce(await w.s.read(), at(0), HUMAN);
    expect(waitingOn(s2, s2.tasks.get("t-094")!, HUMAN)).toEqual(["qa2"]);
  });

  it("那一句：有人就说等谁，一个都没有就照实说没人在等它——**不许退回印 owner**", () => {
    expect(waitingOnLine(["qa"])).toBe("等 qa");
    expect(waitingOnLine(["qa", "human"])).toBe("等 qa、human");
    expect(waitingOnLine([])).toBe(NOBODY_WAITING);
    expect(waitingOnLine([]), "空着时不许出现一个「等 <谁>」的形状").not.toMatch(/等 \S/);
  });
});
