/**
 * t-063: a time offset and a "run the periodic work now" entry, only where the environment enables them. The offset moves
 * what the server believes the time is; it never stamps an event. Production answers 404 to both.
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SERVICE_ACTOR, type Event } from "@ateam/core";
import { createApp, parseOffset } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const apps: ReturnType<typeof createApp>[] = [];
afterAll(() => Promise.all(apps.map((a) => new Promise<void>((r) => a.close(() => r())))));

async function up(testHooks: boolean, clockOffsetMs = 0) {
  const store = new MemoryStore();
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response("ok", { status: 200 }); }) as typeof fetch;
  const app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0, testHooks, clockOffsetMs, fetchImpl });
  apps.push(app);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const hdr = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const post = (path: string, body: unknown, actor = "pm") => fetch(`${base}${path}`, { method: "POST", headers: { ...hdr, "x-actor": actor }, body: JSON.stringify(body) });
  const get = (path: string, actor = "pm") => fetch(`${base}${path}`, { headers: { ...hdr, "x-actor": actor } });
  return { store, calls, base, post, get };
}

describe("t-063 · /_test/clock and /_test/run", () => {
  it("parses offsets", () => {
    expect([parseOffset("16m"), parseOffset("2h"), parseOffset("90s"), parseOffset("500ms"), parseOffset(1500), parseOffset("1500"), parseOffset("0")]).toEqual([16 * 60_000, 2 * 3600_000, 90_000, 500, 1500, 1500, 0]);
    expect(Number.isNaN(parseOffset("soon"))).toBe(true);
  });

  it("with the hooks on: an offset of 16 minutes plus one run makes the real process call out all_missing and leave the note; events keep the real time; clearing the offset restores", async () => {
    const w = await up(true);
    const started = Date.now();
    expect((await w.post("/events", { kind: "reading", key: "alert.webhook", surface: "project", value: "https://hooks.example/x" })).status).toBe(201);
    // no offset: nothing is due (the team is 15 minutes short of "all missing")
    expect((await (await w.post("/_test/run", {})).json()).ran).toEqual([{ project: "ateam", reminded: 0, alerts: 0 }]);
    expect(w.calls).toEqual([]);
    const clock = await (await w.post("/_test/clock", { offset: "16m" })).json();
    expect(clock.offset_ms).toBe(16 * 60_000);
    expect(Date.parse(clock.now) - Date.parse(clock.real)).toBe(16 * 60_000);
    const run = await (await w.post("/_test/run", {})).json();
    expect(run.ran).toEqual([{ project: "ateam", reminded: 0, alerts: 1 }]);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].body).toMatchObject({ kind: "all_missing", project: "ateam" });
    const events = (await w.store.read()).events as Event[];
    const note = events.find((e) => e.kind === "note" && e.actor === SERVICE_ACTOR)!;
    expect(note.body).toMatch(/^外呼：all_missing/);
    // the note is stamped with the real time, not the shifted one
    expect(Math.abs(Date.parse(note.at) - Date.now())).toBeLessThan(10_000);
    for (const e of events) expect(Date.parse(e.at)).toBeLessThan(started + 60_000);
    // the shifted time shows in what the server reads: presence idle grows by 16 minutes
    const b = await (await w.get("/board")).json();
    expect(Date.parse(b.now) - Date.now()).toBeGreaterThan(15 * 60_000);
    // clear: back to the real clock at once
    expect((await (await w.post("/_test/clock", { offset_ms: 0 })).json()).offset_ms).toBe(0);
    const b2 = await (await w.get("/board")).json();
    expect(Math.abs(Date.parse(b2.now) - Date.now())).toBeLessThan(10_000);
    expect((await (await w.get("/_test/clock")).json()).offset_ms).toBe(0);
    // the run also does the reminders (missing-role cards) and the allocation fact; t-139 gave those cards pd's三态 wording
    expect((await w.post("/_test/clock", { offset: "1h" })).status).toBe(200);
    await w.post("/events", { kind: "instruction", to: "dev", body: "做 t-1", ack_by: new Date(Date.now() + 60_000).toISOString() });
    const run2 = await (await w.post("/_test/run", {})).json();
    expect(run2.ran[0].reminded).toBeGreaterThanOrEqual(1);
    expect(((await w.store.read()).events as Event[]).some((e) => e.kind === "instruction" && e.actor === SERVICE_ACTOR && /dev 缺人|dev 没在听/.test(e.body))).toBe(true);
    // a bad offset is 400; the hooks need the admin key
    expect((await w.post("/_test/clock", { offset: "soon" })).status).toBe(400);
    expect((await fetch(`${w.base}/_test/run`, { method: "POST" })).status).toBe(401);
  });

  it("the initial offset can come from the environment (ATEAM_TEST_CLOCK_OFFSET)", async () => {
    const w = await up(true, 16 * 60_000);
    expect((await (await w.get("/_test/clock")).json()).offset_ms).toBe(16 * 60_000);
  });

  it("in production mode both entries are 404 and the offset option is ignored", async () => {
    const w = await up(false, 16 * 60_000);
    expect((await w.post("/_test/clock", { offset: "16m" })).status).toBe(404);
    expect((await w.post("/_test/run", {})).status).toBe(404);
    expect((await w.get("/_test/clock")).status).toBe(404);
    expect((await fetch(`${w.base}/_test/run`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(404); // no X-Actor: still 404, not 400
    expect((await fetch(`${w.base}/_test/run`, { method: "POST" })).status).toBe(404); // no key: still 404, not 401
    const b = await (await w.get("/board")).json();
    expect(Math.abs(Date.parse(b.now) - Date.now())).toBeLessThan(10_000);
  });
});
