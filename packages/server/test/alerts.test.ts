/**
 * t-050: when the whole team stops listening, or the human is very late, the service calls out over the
 * project's declared webhook. Fake fetch, fake clock; no node is involved.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, pull, type NewEvent } from "@ateam/core";
import { runAlerts, situations, type AlertPayload } from "../src/alerts.js";

const HUMAN = "human";
const min = (n: number) => n * 60_000;

function world() {
  const store = new MemoryStore();
  let t = Date.now() - min(600); // a fixed point in the recent past; everything is relative to it
  const now = () => new Date(t);
  const tick = (ms: number) => { t += ms; };
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: now() });
  const calls: { url: string; body: AlertPayload }[] = [];
  let fail = 0; // how many calls to fail before succeeding
  const fetch = async (url: string, init: { body: string }) => {
    if (fail > 0) { fail--; throw new Error("ECONNREFUSED"); }
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const run = () => runAlerts("demo", store, { fetch, now, sleep: async () => {}, human: HUMAN, boardUrl: (p) => `https://ateam.example/p/${p}/` });
  const notes = async () => (await store.read()).events.filter((e) => e.kind === "note" && e.actor === "ateam").map((e) => (e as { body: string }).body);
  return { store, now, tick, emit, calls, run, notes, setFail: (n: number) => { fail = n; } };
}

describe("t-050 · call-outs", () => {
  it("does nothing, silently, when the project declared no webhook", async () => {
    const w = world();
    await w.emit({ kind: "note", actor: "pm", body: "开工" });
    w.tick(min(30));
    expect(await w.run()).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(await w.notes()).toEqual([]);
  });

  it("all_missing: once when every role has been silent 15 minutes; not again within the hour; again after the team came back and left again", async () => {
    const w = world();
    await w.emit({ kind: "reading", actor: "pm", key: "alert.webhook", surface: "project", value: "https://hooks.example/team" });
    await w.emit({ kind: "reading", actor: "pm", key: "roles", surface: "project", value: ["pm", "dev"] });
    await pull(w.store, "pm", null, w.now());
    const lastPull = w.now();
    w.tick(min(10));
    expect(await w.run()).toEqual([]);               // silent 10 minutes: window (5) + 5, not yet 15
    w.tick(min(11));
    const sent = await w.run();                       // 21 minutes: since = lastPull + 5 min, 16 minutes ago
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ project: "demo", kind: "all_missing", since: new Date(lastPull.getTime() + min(5)).toISOString(), board_url: "https://ateam.example/p/demo/" });
    expect(sent[0].summary).toContain("全队失联 16 分钟：pm、dev 都没有在听");
    expect(w.calls[0].url).toBe("https://hooks.example/team");
    expect((await w.notes())[0]).toMatch(/^外呼：all_missing 自 \S+ 已发到 https:\/\/hooks\.example\/team。全队失联/);
    w.tick(min(20));
    expect(await w.run()).toEqual([]);               // same episode, within the hour
    // dev comes back: the situation clears
    await pull(w.store, "dev", null, w.now());
    expect(await w.run()).toEqual([]);
    // and leaves again: a new episode is called out even though the last call-out was less than an hour ago
    w.tick(min(21));
    const again = await w.run();
    expect(again).toHaveLength(1);
    expect(again[0].since).not.toBe(sent[0].since);
    expect(w.calls).toHaveLength(2);
  });

  it("human_overdue: 30 minutes past ack_by; clears on ack; a decided-by-default ask does not count", async () => {
    const w = world();
    await w.emit({ kind: "reading", actor: "pm", key: "alert.webhook", surface: "project", value: "https://hooks.example/human" });
    const ask = await w.emit({ kind: "instruction", actor: "pm", to: HUMAN, body: "部署第 5 批。合并后推到 production", ack_by: new Date(w.now().getTime() + min(15)).toISOString() });
    await w.emit({ kind: "instruction", actor: "pm", to: HUMAN, body: "牌桌认证？", ack_by: new Date(w.now().getTime() + min(15)).toISOString(), options: ["A", "B"], default: "B" });
    await pull(w.store, "pm", null, w.now());
    // t-190：默认要在它到期后不久就落下——晚过 DEFAULT_LATE_MS 就不是「刚好晚了一点」，服务会记一笔
    // 「我们没有执行」并把卡退回等人答，而不是替人把默认追认下去。这里模拟服务照常在跑。
    w.tick(min(16));
    {
      const core0 = await import("@ateam/core");
      await core0.runDueDefaults(w.store, core0.reduce(await w.store.read(), w.now()), HUMAN, w.now());
    }
    w.tick(min(24));                                  // 25 past ack_by: not yet
    await pull(w.store, "pm", null, w.now());          // keep the team listening so only human_overdue fires
    expect(await w.run()).toEqual([]);
    w.tick(min(6));
    await pull(w.store, "pm", null, w.now());
    // t-181：默认到期不再由读的时候算出来，要服务真落一条事件——服务器每分钟先跑这一步再报警（runPeriodic）。
    // 落之前那张带默认的卡确实还欠着一个答案，这里先证它算在里面，再落，再证它不算了。
    const sent = await w.run();
    expect(sent.map((a) => a.kind)).toEqual(["human_overdue"]);
    expect(sent[0].summary).toContain("有 1 条给你的事等了 31 分钟没人答。最早的：部署第 5 批");
    expect(sent[0].detail).toContain(ask.id);
    await w.emit({ kind: "ack", actor: HUMAN, of: ask.id });
    w.tick(min(5));
    await pull(w.store, "pm", null, w.now());
    expect(await w.run()).toEqual([]);
    expect(situations((await import("@ateam/core")).reduce(await w.store.read(), w.now()), HUMAN, w.now())).toEqual([]);
  });

  it("retries a failing webhook three times, notes the failure without a cooldown, and succeeds on a later tick", async () => {
    const w = world();
    await w.emit({ kind: "reading", actor: "pm", key: "alert.webhook", surface: "project", value: "https://hooks.example/x" });
    await w.emit({ kind: "reading", actor: "pm", key: "roles", surface: "project", value: ["pm"] });
    await pull(w.store, "pm", null, w.now());
    w.tick(min(25));
    w.setFail(2);                                     // two failures, then the third attempt succeeds
    expect(await w.run()).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
    w.tick(min(61));
    w.setFail(5);                                     // all three attempts fail
    expect(await w.run()).toEqual([]);
    const notes = await w.notes();
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatch(/^外呼：all_missing 自 \S+ 发送失败（三次，最后状态 0） https:\/\/hooks\.example\/x/);
    w.tick(min(1));
    w.setFail(0);
    expect(await w.run()).toHaveLength(1);           // a failure did not start a cooldown
    expect(w.calls).toHaveLength(2);
  });
});

describe("t-084 · an address that cannot be called", () => {
  it("says so in a note once per episode and sends nothing; an unset address stays silent; a good one sends as before", async () => {
    const w = world();
    // a value that predates the shape: written straight into the store, as an older log would have it
    await w.store.appendRaw({ id: "01OLDWEBHOOK", at: new Date(w.now().getTime() - 60_000).toISOString(), kind: "reading", actor: "human", surface: "project", key: "alert.webhook", value: "human@example.com" } as never);
    await w.emit({ kind: "reading", actor: "pm", key: "roles", surface: "project", value: ["pm", "dev"] });
    await pull(w.store, "pm", null, w.now());
    w.tick(min(21)); // everyone silent past the window: all_missing is due
    expect(await w.run()).toEqual([]); // nothing sent
    expect(w.calls).toEqual([]);
    const notes = await w.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^外呼：all_missing 自 \S+ 未发送：外呼地址配了但发不出去，不是 https（human@example\.com）/);
    // the same episode again: no second note
    w.tick(min(5));
    expect(await w.run()).toEqual([]);
    expect(await w.notes()).toHaveLength(1);
  });
});
