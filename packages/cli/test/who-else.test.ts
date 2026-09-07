/**
 * t-164 在 CLI 这一侧：claim 之后印出的那一行，以及不必先 claim 的 `ateam touches`。
 *
 * pd 07:57 的边界：让它一进门就看见屋里有人，而不是把门锁上。所以这里核的是**说了什么**与**没说什么**——
 * 有人时三件事说全（谁、哪件、碰在哪），没人时不含糊其辞，claim 本身一次都不因此失败。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, slimBoard, whoElseTouches, type Board, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";

async function fixture() {
  const store = new MemoryStore();
  let t = Date.now() - 3_600_000;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "frontend", "qa"] });
  for (const [id, title] of [["t-a", "牌桌那一行"], ["t-b", "我自己的另一件"], ["t-c", "已经交了的"]]) {
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["能用"] });
  }
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-a", touches: ["packages/server/src/html.ts", "packages/server/src/i18n.ts"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-b", touches: ["packages/core/src/board.ts"] });
  await emit({ kind: "task", op: "claim", actor: "qa", task: "t-c", touches: ["packages/core/src/reduce.ts"] });
  await emit({ kind: "task", op: "done", actor: "qa", task: "t-c", evidence: "abc1234", no_human_impact: true });
  const b = board(reduce(await store.read(), new Date(t)), HUMAN, new Date(t));
  return { store, b, at: new Date(t) };
}

describe("t-164 · claim 之后那一行", () => {
  it("三件事说全：谁、哪件、碰在哪——照着它能直接去找人", async () => {
    const { b } = await fixture();
    const [hit] = whoElseTouches(reduce(await (await fixture()).store.read(), new Date()), ["packages/server/src/html.ts"], "dev");
    const line = fmt.alsoHere(hit.actor, hit.task, hit.title, hit.overlap);
    expect(line).toContain("frontend");
    expect(line).toContain("t-a");
    expect(line).toContain("牌桌那一行");
    expect(line).toContain("packages/server/src/html.ts");
    // 它不是警告：空闲的角色去别人的地盘不是错
    expect(line).not.toContain("警告");
    expect(line).not.toContain("冲突");
    expect(b.tasks.working?.map((t) => t.id)).toContain("t-a");
  });

  it("没人时说出来——「没输出」和「没查」在终端上长得一样", () => {
    const line = fmt.nobodyElse(["packages/server/src/app.ts"]);
    expect(line).toContain("packages/server/src/app.ts");
    expect(line).toMatch(/没有别人/);
  });
});

describe("t-164 · 瘦身板带得动这件事", () => {
  it("在途那几件的触点留在瘦身板里；已完成的不留", async () => {
    const { b } = await fixture();
    const slim = slimBoard(b);
    const working = Object.values(slim.tasks).flat().filter((t) => t.status === "working");
    expect(working.length).toBeGreaterThan(0);
    for (const t of working) expect(t.touches, `${t.id} 的触点被瘦掉了`).toBeTruthy();
    for (const t of Object.values(slim.tasks).flat().filter((x) => x.status !== "working")) expect(t.touches).toBeUndefined();
  });

  it("拿瘦身板就能算出那一行，不必拉完整板", async () => {
    const { b } = await fixture();
    const slim: Board = slimBoard(b);
    const others = Object.values(slim.tasks).flat().filter((t) => t.status === "working" && t.owner !== "dev" && t.touches?.length);
    expect(others.map((t) => t.id)).toEqual(["t-a"]);
    expect(others[0].touches).toContain("packages/server/src/html.ts");
  });
});
