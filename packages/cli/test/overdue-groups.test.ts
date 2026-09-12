/**
 * t-140: `ateam board` says the same three sentences the page does, from the same place (t-139's
 * overdue_by_presence), so a reader of either sees one picture of who has not answered and why.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent, type OwedNow } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";

describe("t-140 · CLI 与牌桌说同一句", () => {
  it("prints core's sentence for every group that has anything in it, and nothing for the empty ones", async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3_600_000;
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const past = () => new Date(t - 30 * 60_000).toISOString();
    await emit({ kind: "note", actor: "reader", body: "我在读日志" });
    await emit({ kind: "instruction", actor: "pm", to: "reader", body: "看一眼这个", ack_by: past() });
    await emit({ kind: "instruction", actor: "pm", to: "gone", body: "看一眼那个", ack_by: past() });

    const b = board(reduce(await store.read()), HUMAN);
    const out = fmt.board(b);
    const groups = b.overdue_by_presence;
    for (const g of [groups.missing, groups.deaf, groups.listening]) {
      if (g.count) expect(out, `should say: ${g.line}`).toContain(g.line);
      else if (g.line) expect(out).not.toContain(g.line);
    }
    // an empty group contributes no blank row
    expect(out).not.toMatch(/^ {2}$/m);
  });

  it("survives a board from a server too old to send the grouping", async () => {
    const store = new MemoryStore();
    let t = Date.now() - 600_000;
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    // t-147: only a card with options can be overdue, and only the human may be sent one.
    await emit({ kind: "instruction", actor: "pm", to: HUMAN, body: "先上哪个？", options: ["报表", "导出"], ack_by: new Date(t - 300_000).toISOString() });
    const b = board(reduce(await store.read()), HUMAN);
    expect(b.overdue.length).toBe(1);
    const old = { ...b, overdue_by_presence: undefined } as unknown as typeof b;
    const out = fmt.board(old);
    // the card list still prints; the grouping block below it is simply skipped, not rendered as undefined
    expect(out).toContain("UNANSWERED (past ack_by, options still open)");
    expect(out).not.toContain("NOBODY HAS ACTED ON");
    expect(out).not.toContain("undefined");
  });
});

describe("t-140 · 欠什么只在 sync 时对本人说", () => {
  /**
   * A puller shaped like the real service after t-147: the batch empties as soon as the cursor moves, and `owed`
   * does not — it is computed from state on every pull. The first version of this line read the batch, so it spoke
   * once and then went quiet while the debt stood (qa 06:32). The test below runs that exact sequence.
   */
  const service = (owed: OwedNow) => {
    let first = true;
    return { pull: async () => { const events = first ? [{ id: "i2" }] : []; first = false; return { events: [], for_me: events as never[], cursor: "c1", owed }; } };
  };
  const cursor = () => { let v: string | null = null; return { read: () => v, write: (x: string | null) => { v = x; } }; };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const owed = (): OwedNow => ({
    unanswered: [{ instruction: "i1", from: "pm", body: "先上哪个？两个都行。", sent: ago(30), options: ["报表", "导出"], overdue: true }],
    untouched: [{ instruction: "i2", from: "pd", body: "把灰字改了。细节在 note。", sent: ago(20) }, { instruction: "i3", from: "pm", body: "看一眼这个", sent: ago(160) }],
  });

  it("says pd 06:23's two sentences, with the count, the oldest age and both ways out", async () => {
    const said: string[] = [];
    const { sync } = await import("../src/loop.js");
    await sync(service(owed()) as never, "frontend", cursor() as never, 0, (l: string) => said.push(l));
    const text = said.join("\n");
    expect(text).toContain("有 1 条在等你答，最久的 30 分钟：先上哪个");
    expect(text).toContain("你读过还没动的有 2 条，最久 160 分钟：看一眼这个");
    expect(text).toContain("办了它，或者写一句「不办：原因」。");
  });

  /**
   * The criterion qa's failure was about, run literally: sync, do nothing, sync again. A reminder that only fires
   * the instant an instruction arrives is printed under that instruction — the one moment nobody needs it.
   */
  it("still says it on the next sync, when nothing new came and nothing was done", async () => {
    const said: string[] = [];
    const { sync } = await import("../src/loop.js");
    const client = service(owed()), c = cursor();
    await sync(client as never, "frontend", c as never, 0, () => {});
    await sync(client as never, "frontend", c as never, 0, (l: string) => said.push(l));
    const text = said.join("\n");
    expect(text).toContain("nothing new");                       // the batch is empty…
    expect(text).toContain("你读过还没动的有 2 条");                 // …and the debt is still said
    expect(text).toContain("有 1 条在等你答");
  });

  /**
   * t-245：这一条原来断言的是「print 是 null，游标照样往前」——**那正是 `--quiet` 把一批吃掉的形状**。
   * 它的名字说的是 watch 的轮次，而 watch 自 t-240 起根本不走 `sync`（它自己 pullBatch、印完再推进）。
   * 现在的契约：**没有人要这一批，就不算交付，游标不动。**
   */
  it("没有人看的那一次不算交付：print 是 null 时游标不动（t-245）", async () => {
    const { sync } = await import("../src/loop.js");
    const c = cursor();
    const r = await sync(service(owed()) as never, "frontend", c as never, 0, null);
    expect(r.owed?.untouched).toHaveLength(2);   // 服务照旧说了
    expect(c.read(), "谁都没看见，就不许记成看过").toBeNull();
  });

  it("says nothing when nothing is owed, and nothing when the server is too old to say", async () => {
    const { sync } = await import("../src/loop.js");
    for (const o of [{ unanswered: [], untouched: [] } as OwedNow, undefined]) {
      const said: string[] = [];
      await sync(service(o as OwedNow) as never, "frontend", cursor() as never, 0, (l: string) => said.push(l));
      expect(said.join("\n")).not.toContain("在等你答");
      expect(said.join("\n")).not.toContain("还没动的");
    }
  });
});
