/**
 * t-062: `ateam fixture` prints the sample log as JSON, built with the server's own code; no server, no config.
 */
import { describe, it, expect } from "vitest";
import { reduce, board, type Log } from "@ateam/core";
import { fixtureText } from "../src/fixture.js";

describe("t-062 · ateam fixture", () => {
  it("prints a parseable log with events, cursors and deliveries; --start pins the clock; a bad start is an error", async () => {
    const text = await fixtureText();
    const log = JSON.parse(text) as Log;
    expect(Object.keys(log).sort()).toEqual(["cursors", "deliveries", "events"]);
    expect(log.events.length).toBeGreaterThan(10);
    expect(log.deliveries.length).toBeGreaterThan(0);
    expect(log.cursors.length).toBe(3);
    const b = board(reduce(log, new Date()), "human", new Date());
    expect(b.tasks.verified?.map((t) => t.id)).toEqual(["t-1"]);
    const start = new Date(Date.now() - 3 * 3600_000);
    const pinned = JSON.parse(await fixtureText({ start: start.toISOString(), stepMs: 60_000 })) as Log;
    expect(Date.parse(pinned.events[0].at)).toBe(start.getTime() + 60_000);
    await expect(fixtureText({ start: "yesterday" })).rejects.toThrow(/ISO/);
  });
});
