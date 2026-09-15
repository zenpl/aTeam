/**
 * t-276：**接缝免除可以是一次静默空操作：命令成了、接缝还开着、一个字没说。**
 *
 * 我在 t-255 ② 组量到的：`--no-seam-check-for` 点名一条接缝，而那条接缝落进 `seamcheck.ts` 那两处
 * 提前 `continue`（对方不是 done|failed|verified、或者对方没有证据 sha），于是走不到免除那一步——
 * `done` exit=0、零输出、接缝仍然开着，账留到有人落 pass 时才爆（③ 组）。
 *
 * 判据 2 要求出的那句话**分得清是哪一种**：等对方交，还是让对方补证据 sha。所以下面按两种各钉一条。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
import { seamCheck } from "../src/seamcheck.js";

const HUMAN = "human";
const never = () => null;

/** 两件碰同一处：t-a 是对方（frontend），t-b 是我（dev）。对方的状态与证据由调用方给。 */
async function world(other: "blocked" | "done-no-sha" | "done-with-sha") {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-a", title: "对方", criteria: ["x"], no_human_impact: true });
  await emit({ kind: "task", op: "create", actor: "pm", task: "t-b", title: "我的", criteria: ["y"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-a", touches: ["app.ts"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-b", touches: ["app.ts"] });
  if (other === "blocked") await emit({ kind: "task", op: "block", actor: "frontend", task: "t-a", on: "等一个人拍板" });
  if (other === "done-no-sha") await emit({ kind: "task", op: "done", actor: "frontend", task: "t-a", evidence: "做完了，没写 sha", no_human_impact: true });
  if (other === "done-with-sha") await emit({ kind: "task", op: "done", actor: "frontend", task: "t-a", evidence: "abc1234: 做完了", no_human_impact: true });
  return board(reduce(await store.read()), HUMAN);
}
const said = (b: Awaited<ReturnType<typeof world>>) => seamCheck(b, "t-b", "def5678: 我的", never, () => null, ["seam:t-a+t-b"]);

describe("t-276 · 点名免掉一条本来就没在被检查的接缝，它必须出声", () => {
  it("正①：对方还没交 ⇒ 说出「还没交、此刻是 blocked」，并说下一步是等", async () => {
    const r = said(await world("blocked"));
    const line = r.unverified.find((x) => x.includes("seam:t-a+t-b"));
    expect(line, "改前这里一个字都没有").toBeTruthy();
    expect(line).toContain("什么都没免掉");
    expect(line, "判据 2：认得出是哪一种").toContain("还没交");
    expect(line).toContain("blocked");
    expect(line).toContain("仍然开着");
    expect(line).toContain("下一步是等");
    expect(line, "这一种不该把人支去补证据").not.toContain("证据 sha 补上");
  });

  it("正②：对方交了但证据里没有 sha ⇒ 说出这一点，并说下一步是让对方补", async () => {
    const r = said(await world("done-no-sha"));
    const line = r.unverified.find((x) => x.includes("seam:t-a+t-b"));
    expect(line).toBeTruthy();
    expect(line).toContain("什么都没免掉");
    expect(line).toContain("没有 sha");
    expect(line).toContain("仍然开着");
    expect(line).toContain("证据 sha 补上");
    expect(line, "这一种不是「等对方交」——它已经交了").not.toContain("还没交");
  });

  it("反：正常生效的那一条，输出逐字不变——别为了让空操作出声，把正常那条的话也改了", async () => {
    const r = said(await world("done-with-sha"));
    const line = r.unverified.find((x) => x.includes("seam:t-a+t-b"))!;
    expect(line).toBe("seam:t-a+t-b：这一条被 --no-seam-check-for seam:t-a+t-b 单独免掉了，其余接缝照判；免的理由由 t-b 的 owner 写在证据里");
    expect(line).not.toContain("什么都没免掉");
    expect(r.errors, "免掉了就不该再报错").toEqual([]);
  });

  it("没点名它的时候，两种都照旧安静——这一句只对着「你点了名却什么都没发生」说", async () => {
    for (const w of ["blocked", "done-no-sha"] as const) {
      const b = await world(w);
      const r = seamCheck(b, "t-b", "def5678: 我的", never, () => null, []);
      expect(r.unverified.filter((x) => x.includes("什么都没免掉")), w).toEqual([]);
    }
  });
});
