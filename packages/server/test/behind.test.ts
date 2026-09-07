/**
 * t-137, the server half: every answer says, in seconds, how long it has been since the service saw this actor pull.
 * A number rather than a verdict, because only the node knows whether its own watch is alive — and the two facts want
 * opposite remedies. Times relative to now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, LISTEN_WINDOW_MS } from "@ateam/core";
import { pullIdle, behindNotice, listeningNotices, watchState } from "../../cli/src/deaf.js";
import { createApp } from "../src/app.js";

const TOKEN = "tok";
const HUMAN = "human";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>, base = "";
const call = (actor: string, path = "/board") =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor } });

beforeAll(async () => {
  app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0 });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, { human: HUMAN });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-137 · 服务端在每个回答里说「我多久没见你拉了」", () => {
  it("从没拉过的节点得到 never；拉过之后得到秒数，并随时间长大", async () => {
    expect((await call("dev")).headers.get("x-ateam-pull-idle")).toBe("never");
    await (await fetch(`${base}/events`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "dev" } })).json();  // a pull moves the cursor
    const after = (await call("dev")).headers.get("x-ateam-pull-idle");
    expect(after).toMatch(/^\d+$/);
    expect(Number(after)).toBeLessThan(LISTEN_WINDOW_MS / 1000);
    // it is per actor, not per project: qa has still never pulled
    expect((await call("qa")).headers.get("x-ateam-pull-idle")).toBe("never");
  });

  it("它是一个数，不是一个判决：节点自己合上心跳才成句", async () => {
    const idle = pullIdle((await call("dev")).headers.get("x-ateam-pull-idle"));
    expect(idle).toEqual({ kind: "seconds", s: expect.any(Number) });
    // just pulled: nothing to say, whatever the heartbeat is doing
    const beating = JSON.stringify({ pid: 1, at: new Date().toISOString(), cmd: "ateam watch --interval 25s" });
    expect(listeningNotices(watchState(beating, new Date()), idle)).toEqual([]);
    // the same number, a window later, is the second kind of not listening — and the server never said so itself
    expect(behindNotice({ kind: "seconds", s: 40 * 60 })).toContain("服务端说你");
  });

  it("每一条回答都带它，不只 /board：命令走哪条路都听得见", async () => {
    for (const path of ["/board", "/log", "/task/t-nope"]) {
      const r = await call("dev", path);
      expect(r.headers.get("x-ateam-pull-idle"), path).toMatch(/^(\d+|never)$/);
    }
  });
});
