/**
 * `ateam watch` (t-007): it wakes on an instruction and must show it. Before, the quiet pull that
 * found the instruction advanced the cursor, and the follow-up printing sync said "nothing new".
 */
import { describe, it, expect } from "vitest";
import type { Event, PullResult } from "@ateam/core";
import { sync, watch, isTransient, type CursorStore, type Puller } from "../src/loop.js";
import { ClientError } from "../src/client.js";

const ME = "frontend";
const at = "2026-09-06T06:12:00.000Z";
const LOG: Event[] = [
  { id: "01A", actor: "pm", at, kind: "note", body: "t-007 priority: whoever is free" },
  { id: "01B", actor: "pm", at, kind: "task", op: "create", task: "t-007", title: "watch prints the wake event", criteria: ["prints the pull"] },
  { id: "01C", actor: "pm", at, kind: "instruction", to: ME, body: "t-007 is yours: claim it", ack_by: "2026-09-06T06:27:00.000Z" },
  { id: "01D", actor: "pm", at, kind: "instruction", to: "dev", body: "not for frontend", ack_by: "2026-09-06T06:27:00.000Z" },
];

/** A server that releases the log in scripted slices: each pull returns the next slice after the cursor. */
function server(slices: number[]): Puller & { pulls: (string | null)[] } {
  let released = 0;
  const pulls: (string | null)[] = [];
  return {
    pulls,
    async pull(after, _waitMs) {
      pulls.push(after);
      released = Math.min(LOG.length, released + (slices.shift() ?? 0));
      const start = after ? LOG.findIndex((e) => e.id === after) + 1 : 0;
      const events = LOG.slice(start, released);
      const r: PullResult = { events, for_me: events.filter((e) => e.kind === "instruction" && e.to === ME), cursor: events.length ? events[events.length - 1].id : after };
      return r;
    },
  };
}

function memoryCursor(): CursorStore & { writes: (string | null)[] } {
  let c: string | null = null;
  const writes: (string | null)[] = [];
  return { writes, read: () => c, write: (v) => { c = v; writes.push(v); } };
}

describe("t-007 · ateam watch prints the instruction it woke on", () => {
  it("prints the full events of the wake-up pull, in sync format, before 'instruction received'", async () => {
    const out: string[] = [];
    const cursor = memoryCursor();
    // pull 1: nothing yet; pull 2: still nothing; pull 3: the four events land at once
    const r = await watch(server([0, 0, 4]), ME, cursor, 100, (l) => out.push(l), { once: true });

    expect(r.for_me.map((e) => e.id)).toEqual(["01C"]);
    const text = out.join("\n");
    expect(text).toContain("note t-007 priority: whoever is free");
    expect(text).toContain("task t-007 created: watch prints the wake event");
    expect(text).toContain("INSTRUCTION → frontend: t-007 is yours: claim it");
    expect(text).toContain("⇐ FOR YOU, ack it: ateam ack 01C");
    expect(text).toContain("INSTRUCTION → dev: not for frontend");
    expect(text).toContain("1 instruction(s) for you. Ack each with: ateam ack <id>");
    expect(out[out.length - 1]).toBe("\ninstruction received");
    expect(out.indexOf("\ninstruction received")).toBeGreaterThan(out.findIndex((l) => l.includes("01C")));
    // quiet rounds print nothing
    expect(out.some((l) => l === "nothing new" || l === "log is empty")).toBe(false);
  });

  it("advances the cursor exactly once for those events; a following sync prints nothing new and skips nothing", async () => {
    const out: string[] = [];
    const cursor = memoryCursor();
    const srv = server([0, 3, 1]); // wake on the third event (the instruction for me), 01D not yet published
    await watch(srv, ME, cursor, 100, (l) => out.push(l), { once: true });
    expect(cursor.writes).toEqual([null, "01C"]);
    expect(srv.pulls).toEqual([null, null]);           // two pulls, both from the same (empty) cursor
    expect(out.join("\n")).not.toContain("not for frontend");

    const after: string[] = [];
    let r = await sync(srv, ME, cursor, 0, (l) => after.push(l));
    // 01D was published after the wake; it is the one new thing, printed once
    expect(r.events.map((e) => e.id)).toEqual(["01D"]);
    expect(after.join("\n")).toContain("INSTRUCTION → dev: not for frontend");
    expect(cursor.read()).toBe("01D");

    const again: string[] = [];
    r = await sync(srv, ME, cursor, 0, (l) => again.push(l));
    expect(r.events).toEqual([]);
    expect(again).toEqual(["nothing new"]);
    expect(srv.pulls).toEqual([null, null, "01C", "01D"]);
  });

  it("prints events that arrive in a pull before the wake-up too, so nothing is consumed unseen", async () => {
    const out: string[] = [];
    const cursor = memoryCursor();
    await watch(server([0, 2, 0, 2]), ME, cursor, 100, (l) => out.push(l), { once: true });
    const text = out.join("\n");
    expect(text.indexOf("note t-007 priority")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("note t-007 priority")).toBeLessThan(text.indexOf("INSTRUCTION → frontend"));
    expect(out.filter((l) => l.includes("note t-007 priority"))).toHaveLength(1);
    expect(out.filter((l) => l === "\ninstruction received")).toHaveLength(1);
    expect(cursor.writes).toEqual([null, "01B", "01B", "01D"]);
  });

  it("sync itself still prints events and marks instructions for me", async () => {
    const out: string[] = [];
    const cursor = memoryCursor();
    const r = await sync(server([4]), ME, cursor, 0, (l) => out.push(l));
    expect(r.events).toHaveLength(4);
    expect(out[0]).toContain("note t-007 priority");
    expect(out.filter((l) => l.includes("FOR YOU"))).toHaveLength(1);
    expect(cursor.read()).toBe("01D");
    const quiet: string[] = [];
    await sync(server([4]), ME, memoryCursor(), 0, null);
    expect(quiet).toEqual([]);
  });
});

describe("t-015 · ateam watch survives transient fetch errors", () => {
  /** A server that answers each pull with the next scripted outcome: an Error to throw, or a slice size to release. */
  function flaky(script: (number | Error)[]): Puller & { pulls: (string | null)[] } {
    const good = server(script.filter((x): x is number => typeof x === "number"));
    const pulls: (string | null)[] = [];
    return {
      pulls,
      async pull(after, waitMs) {
        pulls.push(after);
        const next = script.shift();
        if (next instanceof Error) throw next;
        return good.pull(after, waitMs);
      },
    };
  }
  const netErr = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const http = (status: number) => new ClientError(status, { error: status >= 500 ? "Bad Gateway" : "unauthorized" });

  it("two failing pulls then a good one: prints each error, backs off 1s then 2s, keeps the cursor, and still wakes", async () => {
    const out: string[] = [];
    const sleeps: number[] = [];
    const cursor = memoryCursor();
    const srv = flaky([netErr(), http(502), 4]);
    const r = await watch(srv, ME, cursor, 25_000, (l) => out.push(l), { sleep: async (ms) => { sleeps.push(ms); }, once: true });
    expect(r.for_me.map((e) => e.id)).toEqual(["01C"]);
    expect(sleeps).toEqual([1_000, 2_000]);
    expect(out[0]).toBe("watch: fetch failed (ECONNRESET); retrying in 1s (attempt 1)");
    expect(out[1]).toBe("watch: server 502: Bad Gateway; retrying in 2s (attempt 2)");
    expect(out[out.length - 1]).toBe("\ninstruction received");
    // the failed pulls never moved the cursor; the good pull moved it once
    expect(cursor.writes).toEqual(["01D"]);
    expect(srv.pulls).toEqual([null, null, null]);
  });

  it("backoff grows 1s, 2s, 4s, then holds at 4s, all capped at the interval, and resets after a good pull", async () => {
    const sleeps: number[] = [];
    const cursor = memoryCursor();
    // five failures, a quiet good pull, one more failure, then the wake
    const srv = flaky([netErr(), netErr(), netErr(), netErr(), netErr(), 0, netErr(), 4]);
    await watch(srv, ME, cursor, 3_000, () => {}, { sleep: async (ms) => { sleeps.push(ms); }, once: true });
    expect(sleeps).toEqual([1_000, 2_000, 3_000, 3_000, 3_000, 1_000]);
  });

  it("a 4xx, a rejection or a bad config still ends the watch with the error", async () => {
    const cursor = memoryCursor();
    await expect(watch(flaky([http(401), 4]), ME, cursor, 1_000, () => {}, { sleep: async () => {}, once: true })).rejects.toMatchObject({ status: 401 });
    await expect(watch(flaky([new ClientError(409, { error: "rejected", rule: "ack" }), 4]), ME, cursor, 1_000, () => {}, { sleep: async () => {}, once: true })).rejects.toMatchObject({ status: 409 });
    expect(cursor.writes).toEqual([]);
    expect(isTransient(http(500))).toBe(true);
    expect(isTransient(http(404))).toBe(false);
    expect(isTransient(netErr())).toBe(true);
    expect(isTransient(new SyntaxError("bad json"))).toBe(false);
  });
});

describe("t-046 · watch keeps listening after an instruction", () => {
  /** Two instructions for me, published in two separate pulls, with quiet pulls between. Times are relative to now. */
  const now = Date.now();
  const sent = new Date(now).toISOString(), ackBy = new Date(now + 15 * 60_000).toISOString();
  const LOG2: Event[] = [
    { id: "02A", actor: "pm", at: sent, kind: "instruction", to: ME, body: "第一条", ack_by: ackBy },
    { id: "02B", actor: "pm", at: sent, kind: "note", body: "中间的 note" },
    { id: "02C", actor: "pm", at: sent, kind: "instruction", to: ME, body: "第二条", ack_by: ackBy },
  ];
  function server2(slices: number[], onDrained: () => void): Puller & { pulls: (string | null)[] } {
    let released = 0;
    const pulls: (string | null)[] = [];
    return {
      pulls,
      async pull(after) {
        pulls.push(after);
        if (!slices.length) onDrained();
        released = Math.min(LOG2.length, released + (slices.shift() ?? 0));
        const start = after ? LOG2.findIndex((e) => e.id === after) + 1 : 0;
        const events = LOG2.slice(start, released);
        return { events, for_me: events.filter((e) => e.kind === "instruction" && e.to === ME), cursor: events.length ? events[events.length - 1].id : after };
      },
    };
  }

  it("prints both batches with 'instruction received' each time, never exits on its own, and moves the cursor once per pull", async () => {
    const out: string[] = [];
    const cursor = memoryCursor();
    const ac = new AbortController();
    const srv = server2([0, 1, 0, 2], () => ac.abort());
    const r = await watch(srv, ME, cursor, 100, (l) => out.push(l), { signal: ac.signal });
    expect(out.filter((l) => l === "\ninstruction received")).toHaveLength(2);
    expect(out.filter((l) => l.includes("第一条"))).toHaveLength(1);
    expect(out.filter((l) => l.includes("第二条"))).toHaveLength(1);
    expect(out.filter((l) => l.includes("中间的 note"))).toHaveLength(1);
    expect(srv.pulls).toEqual([null, null, "02A", "02A", "02C"]);   // each pull from the cursor the last one left
    expect(cursor.writes).toEqual([null, "02A", "02A", "02C", "02C"]);
    expect(r.cursor).toBe("02C");
  });

  it("--once keeps the old behaviour: returns on the first instruction", async () => {
    const out: string[] = [];
    const r = await watch(server2([0, 1, 0, 2], () => {}), ME, memoryCursor(), 100, (l) => out.push(l), { once: true });
    expect(r.for_me.map((e) => e.id)).toEqual(["02A"]);
    expect(out.filter((l) => l === "\ninstruction received")).toHaveLength(1);
    expect(out.some((l) => l.includes("第二条"))).toBe(false);
  });
});
