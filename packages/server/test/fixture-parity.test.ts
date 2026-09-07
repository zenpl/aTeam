/**
 * t-062, criterion 2: a log built with the exported constructors reduces to the same board, field for field, as the
 * real server produces after the same operations — the server driven by the same clock. Ids are minted per process
 * (random tail), so they are mapped by position before the comparison; everything else must be identical.
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, sampleBuilder, board, reduce, type Event } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";
let app: ReturnType<typeof createApp> | undefined;
afterAll(() => new Promise<void>((r) => (app ? app.close(() => r()) : r())));

describe("t-062 · built log ≡ served log", () => {
  it("replaying the builder's steps against the server yields the same board", async () => {
    const b = await sampleBuilder({ start: Date.now() - 3 * 3600_000 });
    let t = Date.now();
    const store = new MemoryStore();
    app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0, clock: () => new Date(t) });
    await new Promise<void>((r) => app!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const hdr = (actor: string) => ({ authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" });
    const idMap = new Map<string, string>();
    const mapIds = (v: unknown): unknown => JSON.parse(JSON.stringify(v), (_k, x) => (typeof x === "string" && idMap.has(x) ? idMap.get(x) : x));
    const cursors = new Map<string, string | null>();
    for (const step of b.steps) {
      t = Date.parse(step.at);
      if (step.kind === "event") {
        const { id, at, actor, ...body } = step.event as Event & Record<string, unknown>;
        void at;
        const r = await fetch(`${base}/events`, { method: "POST", headers: hdr(actor), body: JSON.stringify(mapIds(body)) });
        expect(r.status, `${step.event.kind} at ${step.at}`).toBe(201);
        const served = (await r.json()) as Event;
        expect(served.at).toBe(step.event.at);
        idMap.set(id, served.id);
        // what the service appended after it (a fail notice, a verify ask): same count, mapped by position
        const followed = await store.since(served.id);
        expect(followed.map((e) => e.kind)).toEqual(step.followed.map((e) => e.kind));
        step.followed.forEach((e, i) => idMap.set(e.id, followed[i].id));
      } else {
        const after = cursors.get(step.actor) ?? null;
        const r = await fetch(`${base}/events${after ? `?after=${after}` : ""}`, { headers: hdr(step.actor) });
        const res = (await r.json()) as { cursor: string | null; for_me: Event[] };
        cursors.set(step.actor, res.cursor);
        expect(res.for_me.map((e) => e.id)).toEqual(step.result.for_me.map((e) => idMap.get(e.id)));
      }
    }
    const now = new Date(t + 60_000);
    // t-212：两边都要带上各自那本拒绝账——服务那份从它的存储取，builder 这份从它的存储取。
    // 不带就是拿「有账」比「没账」，比的不是同一件事。
    const built = mapIds(board(await b.state(now), HUMAN, now, { refusals: await b.store.refusals?.() }));
    t = now.getTime();
    const served = await (await fetch(`${base}/board?full=1`, { headers: hdr("qa") })).json();
    // the one thing the server adds for the admin key is the invite link; it is not derived from the log
    expect(typeof served.invite_url).toBe("string");
    delete served.invite_url;
    // t-103: whether this board has an owner who can speak for themselves lives with the keys, not in the log
    expect(served.owner_key).toEqual({ state: "none" });
    delete served.owner_key;
    expect(served).toEqual(built);
    // and the raw logs agree too: deliveries and cursors included
    const servedLog = await store.read();
    expect(mapIds(await b.log())).toEqual(JSON.parse(JSON.stringify(servedLog)));
  });
});
