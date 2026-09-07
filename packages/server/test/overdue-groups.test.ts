/**
 * t-140 (pd 05:15): three ways of not answering, told apart on the page. Each group's sentence is core's — t-139
 * counts them and writes the words once — so the page says that sentence and adds only who it is about. Nagging
 * about an unanswered instruction is never itself an instruction, and never a card for the human.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "@ateam/core";
import { renderBoard, esc } from "../src/html.js";

const HUMAN = "human";

describe("t-140 · 三种不答，页面说 core 那一句", () => {
  it("says each group's sentence, names who it is about, and does not print the count twice", async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3_600_000;
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const past = () => new Date(t - 30 * 60_000).toISOString();
    await emit({ kind: "note", actor: "reader", body: "我在读日志" });
    await emit({ kind: "instruction", actor: "pm", to: "reader", body: "看一眼这个", ack_by: past() });
    await emit({ kind: "instruction", actor: "pm", to: "gone", body: "看一眼那个", ack_by: past() });

    const s = reduce(await store.read());
    const b = board(s, HUMAN);
    const groups = [b.overdue_by_presence.missing, b.overdue_by_presence.deaf, b.overdue_by_presence.listening].filter((g) => g.count);
    expect(groups.length).toBeGreaterThan(0);

    const html = renderBoard(b, s, { sha: "abc1234", human: HUMAN });
    for (const g of groups) {
      expect(html, `page must say core's sentence: ${g.line}`).toContain(esc(g.line));
      // core's sentence already carries the count — printing it again beside the sentence says the number twice
      expect(html).not.toContain(`<span class="tag">${g.count}</span> ${esc(g.line)}`);
      for (const r of g.roles) expect(html).toContain(esc(r));
    }
    // pd 05:15: a role that is reading but has not answered asks nothing of the human, so it never becomes a card
    expect(b.needs_human.map((c) => c.body).join(" ")).not.toContain("条没确认");
  });
});
