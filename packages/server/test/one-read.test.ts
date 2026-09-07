/**
 * t-121 (P0): every request used to rebuild the world — read every row out of sqlite, JSON.parse it, reduce it. That is
 * all synchronous, so it did not merely make one request slow: it stopped the instance serving anyone else while it ran.
 * `GET /health` does no work at all and was measured at 24.7s and 28.9s — that is what a blocked event loop looks like
 * from outside. Now a request does not redo what the last one just did, keyed on the log's own last event id.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, type EventStore } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";

function counting(store: MemoryStore) {
  let reads = 0;
  const real = store.read.bind(store);
  (store as EventStore).read = async () => { reads++; return real(); };
  return { reads: () => reads, reset: () => { reads = 0; } };
}

describe("t-121 · a request does not rebuild what the last one just built", () => {
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

  it("a quiet log is read once however many people ask", async () => {
    await get("/board");                       // warm
    counter.reset();
    await Promise.all(Array.from({ length: 6 }, () => get("/board")));   // six nodes at once, nothing changed
    expect(counter.reads()).toBe(0);
    await get("/board?full=1");
    await get("/", { accept: "text/html" });
    expect(counter.reads()).toBe(0);
  });

  it("one new event and everyone sees it: the key is the log, not a clock", async () => {
    const e = await append(store, { kind: "note", actor: "qa", body: "刚记的这一笔" }, { human: HUMAN });
    counter.reset();
    const r = await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } });
    const b = await r.json() as { readings: unknown[]; now: string };
    expect(counter.reads()).toBe(1);                                     // it changed, so it was read
    const log = await (await fetch(`${base}/log`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } })).json() as { events: { id: string }[] };
    expect(log.events[log.events.length - 1].id).toBe(e.id);             // and the newest event is really there
    counter.reset();
    await get("/board");
    expect(counter.reads()).toBe(0);                                     // quiet again
  });

  it("a store that cannot say cheaply what changed is never cached: it behaves exactly as before", async () => {
    const plain = new MemoryStore();
    (plain as EventStore).version = undefined;
    const c = counting(plain);
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
