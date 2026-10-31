/**
 * t-335 ①（pd ㉖，定稿在 `3a40fe9` 的 `docs/product.md:290`）：
 * **默认的计时从送达起算，不从发出起算；没送达的提问不许到期。**
 *
 * 真样本（判据③，出处 pd 的 decision `01M69CZN27VTY9MV8DVTG5T5AA`，量于 production 16:33）：pm 14:46:58 问
 * 「要不要起一个 qa？验收停了 10 件」，默认是「起一个 qa」，15:02:27 默认替人定了——而这一条的 reach 到那时
 * 还是 unread，人从 10-30 22:45 之后没有拉过日志。**他从没看见这个问题，系统已经代他答完，卡也从那一页上没了。**
 *
 * 所以这一份钉两件事：① 没送达就没有「到期」这回事；② 送达之后，那段时长从送达起算，不从发出起算。
 * 另有一格钉**两个钟不许合成一个**：默认问的是「他看见了、没点」，而 overdue 问的是「我们还在等一个到不了
 * 的人」——后者照旧按发出那个钟算（t-147 判据 7），否则缺席就能让自己闭嘴。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, pull, reduce, board, dueDefaults, sayDefault, DEFAULT_LINES, DEFAULT_DECIDER, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-31T14:46:58.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);
const MIN15 = 15;

/** pm 那张卡，逐字照它当时的形状：发给人、带选项、默认是只有他做得到的那个动作、期限 15 分钟。 */
async function theCard(opts: { deliveredAt?: number } = {}) {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -10);
  const q = await put({ kind: "instruction", actor: "pm", to: HUMAN, intent: "ask",
    body: "要不要起一个 qa？验收停了 10 件", ack_by: at(MIN15).toISOString(), options: ["起一个 qa", "把 R6 暂给 dev"], default: "起一个 qa" }, 0);
  if (opts.deliveredAt !== undefined) await pull(s, HUMAN, null, at(opts.deliveredAt));
  return { s, q };
}
const st = async (s: MemoryStore, m: number) => reduce(await s.read(), at(m), HUMAN);

describe("t-335 ① · 没送达的提问不许到期", () => {
  it("**判据①、③**：reach 还是 unread、期限已过 ⇒ 没有到期、没有按默认定掉、卡还在他那一页上", async () => {
    const { s, q } = await theCard();
    const state = await st(s, MIN15 + 1);
    const one = state.instructions.get(q.id)!;
    expect(one.reach, "他一次都没来读过").toBe("unread");
    expect(one.default_by, "没送达就没有「这张卡什么时候到期」这回事").toBeUndefined();
    expect(one.default_due, "① 之前这里是 true，于是服务下一扫就替他定了").toBe(false);
    expect(dueDefaults(state, at(MIN15 + 1)), "一条都不许落").toEqual([]);
    expect(state.instructions.get(q.id)!.chosen, "默认没有替他答").toBeUndefined();
    // 卡没有从那一页上消失：pd ㉖ 说的「继续等，或者升级给别人」里的「继续等」就是这一格
    const b = board(state, HUMAN, at(MIN15 + 1));
    expect(b.needs_human.map((n) => n.id)).toContain(q.id);
  });

  it("**判据①**：十五分钟之后才送到 ⇒ 期限从送到那一刻起重新给他十五分钟", async () => {
    const { s, q } = await theCard({ deliveredAt: MIN15 });
    const justAfterOldDeadline = await st(s, MIN15 + 1);
    expect(justAfterOldDeadline.instructions.get(q.id)!.default_by, "送达 + 发问人给的那段时长").toBe(at(MIN15 * 2).toISOString());
    expect(justAfterOldDeadline.instructions.get(q.id)!.default_due, "按发出那个钟它早该到期了").toBe(false);
    expect(dueDefaults(justAfterOldDeadline, at(MIN15 + 1))).toEqual([]);
    const after = await st(s, MIN15 * 2 + 1);
    expect(after.instructions.get(q.id)!.default_due, "他拿到了整整十五分钟，然后才到期").toBe(true);
    expect(dueDefaults(after, at(MIN15 * 2 + 1))).toHaveLength(1);
  });

  it("送达就在发出的那一刻（他正好在读）⇒ 期限还是卡上那个 ack_by，一分钟都不多给", async () => {
    const { s, q } = await theCard({ deliveredAt: 0 });
    expect((await st(s, 1)).instructions.get(q.id)!.default_by).toBe(at(MIN15).toISOString());
    const after = await st(s, MIN15 + 1);
    expect(after.instructions.get(q.id)!.default_due).toBe(true);
    const landed = dueDefaults(after, at(MIN15 + 1));
    expect(landed).toHaveLength(1);
    expect((landed[0] as { decides?: { option: string } }).decides?.option).toBe("起一个 qa");
  });

  it("**两个钟不许合成一个**：没送达的卡照旧算「晚」（我们还在等一个到不了的人），只是不许按默认结掉", async () => {
    const { s, q } = await theCard();
    const state = await st(s, MIN15 + 1);
    const one = state.instructions.get(q.id)!;
    expect(one.overdue, "t-147 判据 7：没人开过牌桌的那几个小时恰恰最该说出来").toBe(true);
    expect(one.default_due, "而默认问的是另一件事：他看见了、没点").toBe(false);
    expect(board(state, HUMAN, at(MIN15 + 1)).overdue.map((o) => o.instruction)).toContain(q.id);
  });

  it("没送达的卡，牌桌那一行什么都不说——不许印「过期了，默认还没生效」（那是一句故障报告）", async () => {
    const unseen = await theCard();
    const one = (await st(unseen.s, MIN15 + 1)).instructions.get(unseen.q.id)!;
    expect(sayDefault(one, at(MIN15 + 1)), "措辞归 pd：定稿之前不印，不印不说假话").toBeUndefined();
    // 对照：送到过的那张照旧说得出话，这一支没有被一起关掉
    const seen = await theCard({ deliveredAt: 0 });
    const said = sayDefault((await st(seen.s, 1)).instructions.get(seen.q.id)!, at(1))!;
    expect(said.state).toBe("waiting");
    const stuck = sayDefault((await st(seen.s, MIN15 + 1)).instructions.get(seen.q.id)!, at(MIN15 + 1))!;
    expect(stuck).toEqual({ state: "stuck", line: DEFAULT_LINES.stuck("起一个 qa") });
  });

  it("人自己点了的，一切照旧（① 没有把真人的决定也拦住）", async () => {
    const { s, q } = await theCard();
    await append(s, { kind: "note", actor: HUMAN, body: "decision: 把 R6 暂给 dev", decision: true, decides: { of: q.id, option: "把 R6 暂给 dev" } }, { human: HUMAN, now: at(5) });
    const state = await st(s, MIN15 + 1);
    expect(state.instructions.get(q.id)!.chosen).toMatchObject({ option: "把 R6 暂给 dev", by: HUMAN });
    expect(state.instructions.get(q.id)!.chosen!.by).not.toBe(DEFAULT_DECIDER);
  });
});
