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

describe("t-152 · 在途只留人有杠杆的那一堆", () => {
  it("keeps what a push would clear and drops what already runs in production", async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3_600_000;
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    const finish = async (id: string, title: string, sha: string) => {
      await emit({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["能用"] , no_human_impact: true});
      await emit({ kind: "task", op: "claim", actor: "dev", task: id, touches: [`src/${id}.ts`] });
      await emit({ kind: "task", op: "done", actor: "dev", task: id, evidence: `${sha}：做完了`, no_human_impact: true });
      await emit({ kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true, evidence: "跑过了" });
    };
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
    await finish("t-push", "推一次就没了", "1111111");
    await finish("t-running", "已经在生产上跑着", "2222222");
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks",
      value: { sha: "aaaaaaa1111", contained: ["t-running"], not_contained: ["t-push"], method: "逐件测" } });

    const s = reduce(await store.read());
    const b = board(s, HUMAN);
    expect(b.release.counts.pending_deploy).toBe(1);
    expect(b.release.counts.deployed_unverified).toBe(1);

    const html = renderBoard(b, s, { sha: "abc1234", human: HUMAN });
    const inflight = html.slice(html.indexOf("在途"), html.indexOf("谁在"));
    // 人有杠杆：推一次它就变小 (pd 06:54)
    expect(inflight).toContain("推一次就没了");
    // 没有杠杆：只会单调增长，从任何界面上拿掉，留在我们自己的账上
    expect(inflight).not.toContain("已经在生产上跑着");
    // pd 07:07: two numbers that mean the same thing must be one number — the group is exactly what the standing
    // line counts, so a person never sees 「1 件验过了，等一次上线」 beside 「验过了，等上线 2 件」
    const shown = (inflight.match(/推一次就没了/g) ?? []).length;
    expect(shown).toBe(b.release.counts.pending_deploy);
  });

  it("a task verified somewhere other than production, whose code was never shipped, is still ours to push", async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3_600_000;
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-s", title: "只在预演上验过", criteria: ["能用"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-s", touches: ["src/s.ts"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-s", evidence: "3333333：做完了" , no_human_impact: true });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-s", surface: "staging", pass: true, evidence: "预演过了" });
    const s = reduce(await store.read());
    const b = board(s, HUMAN);
    const html = renderBoard(b, s, { sha: "abc1234", human: HUMAN });
    // pd 07:07: it is waiting for a repo verification, not a deploy, so it is grouped by what it actually waits for
    expect(b.release.counts.deployed_unverified).toBe(0);
    const inflight = html.slice(html.indexOf("在途"), html.indexOf("谁在"));
    expect(inflight).toContain("只在预演上验过");
    const waitLabel = inflight.indexOf("验过了，等上线"), verifyLabel = inflight.indexOf("做完了，等验");
    const at = inflight.indexOf("只在预演上验过");
    expect(verifyLabel).toBeGreaterThanOrEqual(0);
    // it sits under 等验, not under 等上线 — and it never went missing, which was the first version's bug
    if (waitLabel >= 0) expect(Math.abs(at - verifyLabel)).toBeLessThan(Math.abs(at - waitLabel));
  });
});
