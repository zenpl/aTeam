/**
 * t-239：**每一次拉取都背着 121,817 字节永远不会变的历史。**
 *
 * qa 19:41 实测：一次真增量拉取 182,477 字节，其中约 175 KB 是 `owed`，而 121,817 字节是
 * `legacy_before_acted_rule` 那 315 条——**96%**。粗账：五个角色各 25 秒一轮 ≈ 131 MB/小时。
 * 那一批按定义不会再变（t-193 判据 7：起算点由日志算，之后的指令进不来），**而且没有一个读它内容的人**：
 * `owedSentences` 只说前两个桶，页面一处都没取过它。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, owedNow, owedFull, owedSentences, capOwed, postReply, ACTED_RULE_TASK, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-12T12:00:00.000Z");
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** `n` 条规矩上线之前发给 dev 的旧指令，外加 `live` 条之后的。 */
async function world(n: number, live: number) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  for (let i = 0; i < n; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `旧的第 ${i} 条：${"很长的正文".repeat(20)}`, ack_by: at(-500).toISOString() }, -500);
  // 那条规矩上线：**起算点由日志算出来**（t-193 判据 7）——它随哪一批到的生产，`batch.*` 的 contains 说了算
  await put({ kind: "reading", actor: "release", surface: "repo", key: "batch.14", value: { sha: "736967c", base: "b23b325", contains: [ACTED_RULE_TASK] } }, -400);
  for (let i = 0; i < live; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `新的第 ${i} 条：${"很长的正文".repeat(20)}`, ack_by: at(-100).toISOString() }, -300);
  return { s, put };
}
const st = async (w: Awaited<ReturnType<typeof world>>) => reduce(await w.s.read(), at(0), HUMAN);
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");

describe("t-239 判据 1、4 · 历史只给一个数，全量另有一条路", () => {
  it("每次拉取带的那一份里，历史那一桶是一个数，不是 315 条正文", async () => {
    const w = await world(300, 4);
    const owed = owedNow(await st(w), "dev");
    expect(owed.legacy_before_acted_rule_count).toBe(300);
    expect((owed as unknown as { legacy_before_acted_rule?: unknown }).legacy_before_acted_rule, "逐条不再随每次拉取出门").toBeUndefined();
    expect(owed.untouched).toHaveLength(4);
  });

  it("**少的那一段有一条拿得到的路**：`owedFull` 给全量，两份由同一段代码算出来", async () => {
    const w = await world(300, 4);
    const s = await st(w);
    const full = owedFull(s, "dev");
    expect(full.legacy_before_acted_rule).toHaveLength(300);
    expect(full.legacy_before_acted_rule[0].body).toContain("旧的第 0 条");
    // 同一段代码：两份的活欠账逐条相同
    expect(full.untouched.map((x) => x.instruction)).toEqual(owedNow(s, "dev").untouched.map((x) => x.instruction));
  });

  it("省下多少：同一份状态，带全量与只带一个数，两个字节数并排（判据 2 的形状）", async () => {
    const w = await world(300, 4);
    const s = await st(w);
    const now = bytes(owedNow(s, "dev"));
    const before = bytes({ ...owedNow(s, "dev"), legacy_before_acted_rule: owedFull(s, "dev").legacy_before_acted_rule });
    expect(now).toBeLessThan(before / 10);          // 一个数 vs 三百条正文
    expect(before - now).toBeGreaterThan(100_000);  // 这份夹具里省下的与生产那一档同量级
  });

  it("那句话一个字没变：它本来就只说前两个桶——**少给的这一段没有任何人在读**", async () => {
    const w = await world(300, 4);
    const lines = owedSentences(owedNow(await st(w), "dev"), at(0));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("你读过还没动的有 4 条");
    expect(lines.join(), "那 300 条历史不进这句话——它本来就只说活欠账").not.toContain("有 300 条");
  });

  it("预算那一层：历史那个数不参与截断（它是常量大小），前两个桶照旧按字节截", async () => {
    const w = await world(300, 40);
    const owed = owedNow(await st(w), "dev");
    const capped = capOwed(owed, 2_000);
    expect(capped.legacy_before_acted_rule_count, "数照旧给全").toBe(300);
    expect(capped.untouched.length).toBeLessThan(40);
    expect(capped.more).toBe(true);
  });

  it("POST 的回包：同一个上限里装得下活欠账了——**原来那一份连上限都装不下**", async () => {
    const w = await world(300, 5);
    const s = await st(w);
    const LIMIT = 200_000;
    const reply = postReply(s, "dev", { id: "01X", kind: "note" }, LIMIT);
    expect(reply.owed.legacy_before_acted_rule_count).toBe(300);
    expect(bytes(reply)).toBeLessThanOrEqual(LIMIT);
    expect(reply.owed.untouched, "活欠账一条不少").toHaveLength(5);
    // 把那 315 条塞回去是什么样：同一个上限装不下，于是原来它要么截断活欠账、要么超标
    const wouldBe = bytes({ ...reply, owed: { ...reply.owed, legacy_before_acted_rule: owedFull(s, "dev").legacy_before_acted_rule } });
    expect(wouldBe).toBeGreaterThan(LIMIT);
  });
});
