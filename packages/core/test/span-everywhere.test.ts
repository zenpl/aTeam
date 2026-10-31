/**
 * t-346（pd 要求⑱ 是**一律**，所以这是违例不是新规矩）：时长走同一把梯子，剩下那几处也要走。
 *
 * 落点出自我在 t-341 的证据里交回去的那张清单，而**其中一处我当时报错了**，这一份把它记在这里：
 * `packages/cli/src/format.ts:242` **本来就走梯子**（它调 `ago`，与 `span` 共用同一个 `band`），
 * 不是「还没走」。真正印着没换算过的分钟数的是另两处：`packages/server/src/i18n.ts` 那两句（在场那一栏，
 * 见 server 那一份用例）与下面这条牌桌汇总行。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, pull, reduce, board, span, ago, SPAN_UNDER_A_MINUTE, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

/** qa 最后一次读日志是 `ago` 之前，且手上欠着一条早就到期的指令。 */
async function world(agoMs: number | null) {
  const s = new MemoryStore();
  const put = (e: NewEvent, at: number) => append(s, e, { human: HUMAN, now: new Date(at) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "qa"] }, T0 - 10 * D);
  await put({ kind: "instruction", actor: "pm", to: "qa", body: "验一件", ack_by: new Date(T0 - 9 * D).toISOString() }, T0 - 9 * D - M);
  if (agoMs !== null) await pull(s, "qa", null, new Date(T0 - agoMs));
  return board(reduce(await s.read(), new Date(T0), HUMAN), HUMAN, new Date(T0));
}

describe("t-346 · 牌桌汇总行的时长走梯子", () => {
  // **只有「缺人」那一态才有这一行**：59 秒前、3 分钟前读过日志的角色此刻是 listening，那一桶本来就是空的
  // （听窗 5 分钟）。所以这两档在这一处不是漏掉，是**按定义不该出现**——判据 4 要的四档，这一处只摸得到两档，
  // 另两档由 `span` 自己那一格与 i18n 那一份覆盖。这一点写在这里，免得被读成「少测了两档」。
  it("1286 分钟 ⇒ 「缺人 21 小时」，不再是「缺人 1286 分钟」", async () => {
    const b = await world(1286 * M);
    expect(b.overdue_by_presence.missing.line).toBe("缺人 21 小时，1 条没送到");
    expect(b.overdue_by_presence.missing.line).not.toContain("1286");
  });

  it("3 天 ⇒ 「缺人 3 天」", async () => {
    expect((await world(3 * D)).overdue_by_presence.missing.line).toBe("缺人 3 天，1 条没送到");
  });

  it("**判据 5**：从没读过日志 ⇒ 不进梯子（没有起点就没有时长，t-091）", async () => {
    const b = await world(null);
    expect(b.overdue_by_presence.missing.line).toBe("从没读过日志，1 条没送到");
    expect(b.overdue_by_presence.missing.line, "一个时长都不许出现").not.toMatch(/\d+ (分钟|小时|天)/);
  });

  it("**判据 6**：按分档断言，不一刀切——「3 分钟」这种输出是对的", () => {
    // 这一格钉的是判据 6 本身：梯子答分钟的那两档，答案里**就该**有「分钟」。
    expect(span(59 * S)).toBe(SPAN_UNDER_A_MINUTE);
    expect(span(3 * M)).toBe("3 分钟");
    expect(span(1286 * M)).toBe("21 小时");
    expect(span(3 * D)).toBe("3 天");
  });

  it("**我在 t-341 报错的那一处**：命令行那一行本来就走梯子（ago 与 span 同一个 band）", () => {
    // 它印的是「缺人  <多久前>」，四档都由梯子给，不是一个没换算过的分钟数。
    expect(ago(59 * S)).toBe("刚刚");
    expect(ago(3 * M)).toBe("3 分钟前");
    expect(ago(1286 * M)).toBe("21 小时前");
    expect(ago(3 * D)).toBe("3 天前");
  });
});
