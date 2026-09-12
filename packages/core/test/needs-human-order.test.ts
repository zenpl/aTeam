/**
 * t-236：**人那一页把最急的一张排在最下面。**
 *
 * `needs_human` 按指令 id 升序（＝建卡的先后），填完之后一处都没重排过（frontend 读数 `repo:needs_human.order`）。
 * pm 18:25 量到那一页自上而下是：起一个 pd？／起一个 release？／换外呼地址（挂 8 天）／放行快进／**今天那个 P0
 * 排第五**——而上面那两张是 pm 自己就能做、今天已经自己做过两次的事。
 *
 * 这份用例用的是**此刻真牌桌上那六张卡的形状与正文**（2026-09-12T21:49Z，9,045 条），不是编的样本。
 */
import { describe, it, expect } from "vitest";
import { needsHumanOrder, SERVICE_ACTOR, type Board } from "../src/index.js";

type Card = Board["needs_human"][number];
const card = (x: Partial<Card> & { id: string }): Card => ({
  kind: "ask", from: "pm", body: "", title: "", summary: "", since: "2026-09-12T18:00:00.000Z", ...x,
} as Card);

/** 此刻真牌桌上的六张，按它们真正的 id 顺序（也就是旧排法的样子）。 */
const REAL: Card[] = [
  card({ id: "01M1VNSX5KDRJ9ACJHH3STX70D", from: SERVICE_ACTOR, kind: "do", body: "pd 从没读过日志，239 条没送到。起一个 pd？", ack_by: "2026-09-07T12:00:00.000Z" }),
  card({ id: "01M1WSJF65FZ86AE7T3RVG4NEH", from: SERVICE_ACTOR, kind: "do", body: "release 从没读过日志，111 条没送到。起一个 release？", ack_by: "2026-09-07T13:00:00.000Z" }),
  card({ id: "01M1XJFRE9EB06FWJS0B23H8EV", from: SERVICE_ACTOR, kind: "do", body: "frontend 从没读过日志，357 条没送到。起一个 frontend？", ack_by: "2026-09-07T14:00:00.000Z" }),
  card({ id: "01M2BCA5KHKSFXAQ3MCA43AY8F", body: "**试一条命令，这个洞可能当场就关。**", options: ["A 我去试这条命令", "B 先不动"], default: "B 先不动", ack_by: "2026-09-13T07:00:00.000Z" }),
  card({ id: "01M2BEKGPZ5RPBJDH1GQT1DKTF", body: "**给一个 https 的外呼地址。**", options: ["A 我给一个 https 地址", "B 先不给"], default: "B 先不给", ack_by: "2026-09-13T20:00:00.000Z" }),
  card({ id: "01M2BSFXXXXXXXXXXXXXXXXXXX", body: "**把这一行粘进去，我们自己的主干就跟上了。**", options: ["A 我粘", "B 先不动"], default: "B 先不动", ack_by: "2026-09-13T06:00:00.000Z" }),
];
const titles = (cs: Card[]) => cs.map((c) => c.body);

describe("t-236 · 最急的那一张排到最上面", () => {
  it("真牌桌那六张：旧排法把 P0 排在第四，新排法把它排第一；服务发的「起一个 X？」沉到最后", () => {
    const before = [...REAL].sort((a, b) => a.id.localeCompare(b.id));
    expect(titles(before)[0]).toContain("pd 从没读过日志");
    expect(titles(before).findIndex((t) => t.includes("试一条命令"))).toBe(3);

    const after = needsHumanOrder(REAL);
    expect(titles(after)[0], "**不答就会替他落一个决定、而且最先到期的那一张在最上面**").toContain("把这一行粘进去");
    expect(titles(after).slice(0, 3).some((t) => t.includes("试一条命令"))).toBe(true);
    expect(titles(after).slice(3).every((t) => t.includes("从没读过日志")), "别人也做得了的沉到最后").toBe(true);
  });

  it("同一档里先到期的在前，没有期限的排在有期限的之后；再平手才按 id", () => {
    const cs = [
      card({ id: "01C", body: "没有期限的", options: ["A", "B"], default: "B" }),
      card({ id: "01B", body: "明天到期", options: ["A", "B"], default: "B", ack_by: "2026-09-13T20:00:00.000Z" }),
      card({ id: "01A", body: "一小时后到期", options: ["A", "B"], default: "B", ack_by: "2026-09-12T22:00:00.000Z" }),
      card({ id: "01D", body: "与 01A 同刻", options: ["A", "B"], default: "B", ack_by: "2026-09-12T22:00:00.000Z" }),
    ];
    expect(needsHumanOrder(cs).map((c) => c.id)).toEqual(["01A", "01D", "01B", "01C"]);
  });

  it("t-190 重算过的期限算数：读的是 ack_by_again，不是那个已经过去的 ack_by", () => {
    const cs = [
      card({ id: "01A", body: "原期限早就过了，重算到后天", options: ["A", "B"], default: "B", ack_by: "2026-09-01T00:00:00.000Z", ack_by_again: "2026-09-14T00:00:00.000Z" }),
      card({ id: "01B", body: "今晚到期", options: ["A", "B"], default: "B", ack_by: "2026-09-12T23:00:00.000Z" }),
    ];
    expect(needsHumanOrder(cs).map((c) => c.id)).toEqual(["01B", "01A"]);
  });

  it("「只有他能做」怎么判：服务发的「起一个 X？」不算——那件事队里别人也做得了（pm 今天做过两次）", () => {
    const cs = [
      card({ id: "01A", from: SERVICE_ACTOR, kind: "do", body: "qa 从没读过日志，3 条没送到。起一个 qa？", ack_by: "2026-09-12T22:00:00.000Z" }),
      card({ id: "01B", from: SERVICE_ACTOR, kind: "ask", body: "记下一个外呼地址？", options: ["记下", "不要了"], ack_by: "2026-09-13T22:00:00.000Z" }),
    ];
    // 同是服务发的：问他要东西的那张在前，「起一个 X？」在后——**判的是这件事除了他还有没有人做得了**
    expect(needsHumanOrder(cs).map((c) => c.id)).toEqual(["01B", "01A"]);
  });

  it("排序是纯函数，不改原数组；一张卡都没有时给空", () => {
    const cs = [...REAL];
    const out = needsHumanOrder(cs);
    expect(cs.map((c) => c.id), "原数组不动").toEqual(REAL.map((c) => c.id));
    expect(out).not.toBe(cs);
    expect(needsHumanOrder([])).toEqual([]);
  });
});

/**
 * 上面那几条只问了排序函数自己。**注入之后它们全绿**——因为没有一条盯着「board() 有没有真去排」。
 * 这一条走真路：从日志算出整块板，读 `board().needs_human` 的顺序。
 */
describe("t-236 · 真路：板算出来的那一份就是排好的", () => {
  it("同一份日志：服务那张「起一个 pd？」沉到最后，带默认的卡在最上面", async () => {
    const { MemoryStore, append, reduce, board } = await import("../src/index.js");
    const HUMAN = "human";
    const T0 = Date.parse("2026-09-12T12:00:00.000Z");
    const at = (m: number) => new Date(T0 + m * 60_000);
    const s = new MemoryStore();
    const put = (e: unknown, m: number) => append(s, e as never, { human: HUMAN, now: at(m) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "pd"] }, -600);
    // 先建的是服务那张（所以按 id 升序它在最上面），后建的是那张 P0
    await put({ kind: "instruction", actor: SERVICE_ACTOR, to: HUMAN, intent: "do", body: "pd 从没读过日志，239 条没送到。起一个 pd？", ack_by: at(600).toISOString() }, -500);
    await put({ kind: "instruction", actor: "pm", to: HUMAN, body: "**试一条命令，这个洞可能当场就关。**", options: ["A 我去试", "B 先不动"], default: "B 先不动", ack_by: at(60).toISOString() }, -400);
    const b = board(reduce(await s.read(), at(0), HUMAN), HUMAN, at(0));
    expect(b.needs_human).toHaveLength(2);
    expect(b.needs_human[0].body, "**这一步以前没有人做**：填完就是 id 的顺序").toContain("试一条命令");
    expect(b.needs_human[1].body).toContain("起一个 pd？");
  });
});
