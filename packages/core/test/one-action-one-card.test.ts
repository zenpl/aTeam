/**
 * t-342 要求㉛：**同一个动作不许在人那一页占两张卡。**
 *
 * 真样本（pm 16:44 自己判的那一次，`01M69DJFS36WZV723K65TDMJ12`）：人那一页上「起一个 qa」占两张——
 * 服务那张（`qa 缺人 1020 分钟，0 条没送到。起一个 qa？`，id 铸于 2026-09-07）与 pm 那张带选项的
 * （`要不要起一个 qa？` ／ 选项 `起一个 qa` | `把 R6 暂给 dev`）。pm 当时自己的裁定是「留我那张，服务那张我动不了」。
 * 这一件就是把那句「动不了」落成代码：**收起服务那张，留带选项的那张**——后者带着他的另一条路。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, missingCard, SERVICE_ACTOR, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-31T16:24:00.000Z");
const at = (m: number) => new Date(T0 + m * 60_000);
const M = 60_000;

/** 人那一页上此刻有哪几张卡（按 id）。 */
const page = async (s: MemoryStore, m = 0) => board(reduce(await s.read(), at(m), HUMAN), HUMAN, at(m)).needs_human;

/**
 * pm 那一刻的局面：qa 真的缺人（没拉过日志），服务那张卡在，另有一张带选项的提问问同一件事。
 * `ask` 给 false 就只有服务那张（对照）。
 */
async function world(opts: { ask?: boolean; decided?: boolean; ackBy?: number } = {}) {
  const s = new MemoryStore();
  const put = (e: NewEvent, m: number) => append(s, e, { human: HUMAN, now: at(m) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -600);
  // qa 欠着一条到期没读的指令，而且从没拉过日志 ⇒ 它真的缺人，服务卡该在
  await put({ kind: "instruction", actor: "pm", to: "qa", body: "验一件", ack_by: at(-500).toISOString() }, -520);
  const service = await put({ kind: "instruction", actor: SERVICE_ACTOR, to: HUMAN, intent: "do",
    body: missingCard("qa", "missing", 1020 * M, 0), ack_by: at(600).toISOString() }, -300);
  let q: { id: string } | undefined;
  if (opts.ask) {
    q = await put({ kind: "instruction", actor: "pm", to: HUMAN, intent: "ask",
      body: "要不要起一个 qa？验收停了 10 件", ack_by: at(opts.ackBy ?? 600).toISOString(),
      options: ["起一个 qa", "把 R6 暂给 dev"], default_doer: "nothing", default: "起一个 qa" }, -200);
    if (opts.decided) await put({ kind: "note", actor: HUMAN, body: "decision: 起一个 qa", decision: true,
      decides: { of: q.id, option: "起一个 qa" } }, -100);
  }
  return { s, service, q };
}

describe("t-342 · 同一个动作只许占一张卡", () => {
  it("**判据 1、5**：两张都在 ⇒ 人那一页上只剩带选项的那张，服务那张收起来", async () => {
    const w = await world({ ask: true });
    const ids = (await page(w.s)).map((c) => c.id);
    expect(ids, "带选项的那张留着——它带着他的另一条路（把 R6 暂给 dev）").toContain(w.q!.id);
    expect(ids, "服务那张收起来：同一个动作不占两张卡").not.toContain(w.service.id);
  });

  it("**判据 2 的反面**：不许反过来收走带选项的那张（那会把他的另一条路一起收走）", async () => {
    const w = await world({ ask: true });
    const kept = (await page(w.s)).find((c) => c.id === w.q!.id)!;
    expect(kept, "它必须还在").toBeTruthy();
    expect(kept.options, "两条路都还在").toEqual(["起一个 qa", "把 R6 暂给 dev"]);
  });

  it("**对照**：没有那张带选项的提问 ⇒ 服务卡照常出现（这一件没有把服务卡一律关掉）", async () => {
    const w = await world({ ask: false });
    expect((await page(w.s)).map((c) => c.id)).toContain(w.service.id);
  });

  it("**判据 3**：那条提问已决 ⇒ 服务卡回来（否则这件事就没有任何一张卡在问他）", async () => {
    const w = await world({ ask: true, decided: true });
    const ids = (await page(w.s)).map((c) => c.id);
    expect(ids, "已决的那张自然不在").not.toContain(w.q!.id);
    expect(ids, "服务那张回来").toContain(w.service.id);
  });

  it("**判据 3 的另一档**：那条提问已经过期 ⇒ 服务卡也回来", async () => {
    const w = await world({ ask: true, ackBy: -150 });     // 它的期限在 -150 分钟就过了
    const ids = (await page(w.s)).map((c) => c.id);
    expect(ids, "过期的那张仍然在等他答（t-147），但它不再替服务那张站台").toContain(w.q!.id);
    expect(ids, "服务那张回来").toContain(w.service.id);
  });

  it("**判法要窄**：选项里那个「把 R6 暂给 dev」不许收走一张 dev 的服务卡", async () => {
    const w = await world({ ask: true });
    const put = (e: NewEvent, m: number) => append(w.s, e, { human: HUMAN, now: at(m) });
    await put({ kind: "instruction", actor: "pm", to: "dev", body: "做一件", ack_by: at(-500).toISOString() }, -520);
    const devCard = await put({ kind: "instruction", actor: SERVICE_ACTOR, to: HUMAN, intent: "do",
      body: missingCard("dev", "missing", 30 * M, 1), ack_by: at(600).toISOString() }, -250);
    // 这张卡说的是「起一个 dev」，而那个选项说的是「把 R6 暂给 dev」——**同一个角色名，不是同一个动作**。
    // 只按「角色名相同」判（判据 4 的字面）会把它误收，所以多了一条：那个选项的文字要原样出现在卡文里。
    expect((await page(w.s)).map((c) => c.id), "它不该被一条与它无关的选项收走").toContain(devCard.id);
  });
});
