/**
 * t-140：一次拉取之后什么都没做，再拉一次——服务仍然说得出「你欠什么」。
 *
 * 这是 qa 06:32 判 fail 的那个形状，写成用例。第一版那行提醒喂的是这一批带来的东西，游标一往前走就空了：
 * 它的寿命等于「指令第一次送达」那一瞬，而那一瞬它就印在指令清单的正下方，正是最不需要提醒的时刻。
 * 所以这里断言的不是「字段存在」，是**空批次上它照样不空**——欠什么要从欠什么算，不从这次带来了什么算。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, owedSentences, type OwedNow } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

describe("t-140 · 欠着的事不会随游标一起走掉", () => {
  const store = new MemoryStore();
  let app: ReturnType<typeof createApp>, base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { id: string } };
  };
  const sync = async (actor: string, after: string | null) => {
    const q = after ? `?after=${encodeURIComponent(after)}` : "";
    const r = await fetch(`${base}/events${q}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } });
    return await r.json() as { events: { id: string }[]; cursor: string | null; owed: OwedNow };
  };
  const soon = () => new Date(Date.now() + 15 * 60_000).toISOString();

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("第二次拉取什么都没带来，欠的两条还在，而且那两句话说得出口", async () => {
    await post("pm", { kind: "instruction", to: "qa", body: "验 A 件，请确认。判据在任务上。", ack_by: soon() });
    await post("pm", { kind: "instruction", to: "qa", body: "顺手看一眼 CI", ack_by: soon() });

    const first = await sync("qa", null);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.owed.untouched).toHaveLength(2);

    // 什么都不做，只是再拉一次
    const second = await sync("qa", first.cursor);
    expect(second.events).toEqual([]);                 // 这一批是空的……
    expect(second.owed.untouched).toHaveLength(2);     // ……欠的两条一条没少

    const [line] = owedSentences(second.owed, new Date());
    expect(line).toContain("你读过还没动的有 2 条");
    expect(line).toContain("验 A 件");                  // 最久的那条，说得出是哪一条
    expect(line).toContain("办了它，或者写一句「不办：原因」。");
  });

  it("办掉一条就少一条，办掉两条就没有话可说", async () => {
    const before = await sync("qa", null);
    const [one, two] = before.owed.untouched.map((x) => x.instruction);
    await post("qa", { kind: "note", body: "看过了，正在验", refs: [one] });
    const mid = await sync("qa", before.cursor);
    expect(mid.owed.untouched.map((x) => x.instruction)).toEqual([two]);
    expect(owedSentences(mid.owed, new Date())[0]).toContain("你读过还没动的有 1 条");

    await post("qa", { kind: "note", body: "不办：这条 CI 归 dev" , refs: [two] });
    const after = await sync("qa", mid.cursor);
    expect(after.owed.untouched).toEqual([]);
    expect(owedSentences(after.owed, new Date())).toEqual([]);
  });
});
