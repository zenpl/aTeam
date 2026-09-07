/**
 * t-121 (P0) and t-128 (its other half): a request used to rebuild the world — read every row out of sqlite, JSON.parse
 * it, reduce it. That is all synchronous, so it did not merely make one request slow: it stopped the instance serving
 * anyone else while it ran.
 *
 * t-121 answered with a cache keyed on the log's last event: a burst of callers shared one reduction, but the next
 * append threw it away and the caller after it paid for the whole log again. t-128 replaced that with a reduction that
 * is never thrown away, so what these tests count is no longer "how many times was the log read" but the thing that
 * actually matters: **how many events a request has to fold**. A quiet log costs none; one new event costs one; the
 * length of the log does not enter into it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, type EventStore, type LogMark } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

/** Count what a request makes the store hand over: whole-log reads, and events folded through the incremental path. */
function counting(store: MemoryStore) {
  let reads = 0, folded = 0, calls = 0;
  const realRead = store.read.bind(store);
  const realSince = store.readSince.bind(store);
  (store as EventStore).read = async () => { reads++; return realRead(); };
  (store as EventStore).readSince = async (mark: LogMark | null) => {
    calls++;
    const got = await realSince(mark);
    folded += got.log.events.length;
    return got;
  };
  return { reads: () => reads, folded: () => folded, calls: () => calls, reset: () => { reads = folded = calls = 0; } };
}

describe("t-128 · a request folds what it has not seen, not the log", () => {
  const store = new MemoryStore();
  const counter = counting(store);
  let app: ReturnType<typeof createApp>, base = "";
  const get = async (p: string, h: Record<string, string> = {}) => {
    const r = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", ...h } });
    await r.text();
    return r.status;
  };

  beforeAll(async () => {
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    for (let i = 0; i < 20; i++) await append(store, { kind: "note", actor: "pm", body: `记一笔 ${i}` }, { human: HUMAN });
  });
  afterAll(() => new Promise<void>((r) => app.close(() => r())));

  it("a quiet log costs nothing: many callers, no event folded twice, and the whole log never read", async () => {
    await get("/board");                       // warm
    counter.reset();
    await Promise.all(Array.from({ length: 6 }, () => get("/board")));   // six nodes at once, nothing changed
    await get("/board?full=1");
    await get("/", { accept: "text/html" });
    expect(counter.folded()).toBe(0);
    expect(counter.reads()).toBe(0);
  });

  it("one new event costs one event, whatever the log's length", async () => {
    const e = await append(store, { kind: "note", actor: "qa", body: "刚记的这一笔" }, { human: HUMAN });
    counter.reset();
    const r = await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } });
    await r.json();
    expect(counter.folded()).toBe(1);                                    // one, not twenty-two
    expect(counter.reads()).toBe(0);
    const log = await (await fetch(`${base}/log`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json() as { events: { id: string }[] };
    expect(log.events[log.events.length - 1].id).toBe(e.id);             // and the newest event is really there
    counter.reset();
    await get("/board");
    expect(counter.folded()).toBe(0);                                    // quiet again
  });

  it("the write path folds one event per append too, so a hundred appends are not ten thousand folds", async () => {
    const own = new MemoryStore();
    const c = counting(own);
    for (let i = 0; i < 30; i++) await append(own, { kind: "note", actor: "pm", body: `第 ${i} 笔` }, { human: HUMAN });
    // The first append folds an empty log; each one after it folds exactly the one before it.
    expect(c.folded()).toBe(29);
    expect(c.reads()).toBe(0);
  });

  it("a store too old to say what changed reduces the whole log, exactly as before", async () => {
    const plain = new MemoryStore();
    const c = counting(plain);
    (plain as EventStore).readSince = undefined;   // an older store: it can only hand over the whole log
    const app2 = createApp({ store: plain, token: TOKEN, human: HUMAN, sha: "x", alertIntervalMs: 0 });
    await new Promise<void>((r) => app2.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(app2.address() as AddressInfo).port}`;
    await fetch(`${b2}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } }).then((r) => r.text());
    c.reset();
    await fetch(`${b2}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } }).then((r) => r.text());
    expect(c.reads()).toBeGreaterThan(0);
    app2.close();
  });
});
