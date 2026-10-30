/**
 * t-062: `ateam fixture` prints the sample log as JSON, built with the server's own code; no server, no config.
 */
import { describe, it, expect } from "vitest";
import { reduce, board, type Log } from "@ateam/core";
import { fixtureText } from "../src/fixture.js";
import { SERVICE_ACTOR, CLI_SHA_UNKNOWN_PREFIX } from "@ateam/core";

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

  /**
   * t-278：**样本里要有服务自己发的那张卡。** 真跑一遍的服务端一定会发它（`GET /board` 上的 remindFor），
   * 所以一份没有它的样本不是「干净」，是「不像真的」——而 built≡served 曾经绿着，正是因为那张造成分歧的卡
   * 没上场。这一条钉的是样本这一侧：`fixture-parity` 钉的是两边一致，两条缺一不可（我实测过：只把
   * `sampleBuilder` 里那一次 remind 删掉，`fixture-parity` 仍然绿，因为它自己也会 remind 一次）。
   */
  it("t-278：样本里有服务自己发的那张「说不出你是哪一版」，而且发给的是节点本人", async () => {
    const log = JSON.parse(await fixtureText()) as Log;
    const cards = log.events.filter((e) => e.kind === "instruction" && e.actor === SERVICE_ACTOR && e.body.startsWith(CLI_SHA_UNKNOWN_PREFIX));
    expect(cards.length, "改前是 0 条").toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.to, "发给节点本人，不是发给人").not.toBe("human");
      expect(c.body, "样本里这几个节点都跑过普通 sync，所以说的是两种成因那一句").not.toContain("偶尔跑一次");
    }
  });
});
