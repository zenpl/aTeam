/**
 * t-140: `ateam board` says the same three sentences the page does, from the same place (t-139's
 * overdue_by_presence), so a reader of either sees one picture of who has not answered and why.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
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

/**
 * t-140's other half — the two sentences a node hears about itself at sync — was written against `owedLines`,
 * which t-147 retired: what a node owes is now the server's `owed` (core's `owedNow`), sent with every pull.
 * The assertions come back in t-140 reading that field: 「在等你答」, 「你读过还没动的有」, the way out 「不办：原因」,
 * said at sync and never in watch's own rounds. They are not deleted because they stopped mattering.
 */
