/**
 * t-307：**人那一页由什么组成。**
 *
 * 判据① 要的是「那一页里历史的占比是 0」，而今天的基线（qa 16:29，生产）是 **80% 是历史**：
 * tasks 53.7% ＋ instructions 26.4%。判据⑤ 另立了一条禁令：**不许把成因说成缓存**——`GET /` 早就走
 * 增量缓存（`stateFor`），而缓存不封顶回包，回包仍随历史线性长。所以这里钉的是**组成**，不是缓存。
 *
 * 这一份用例只问 core 那一个函数（`livingBoard`）：谁留谁走、留下的理由是什么、以及它说不说出自己砍了什么。
 * 页面那一端（真字节、`/release`）在 `packages/server/test/page-history.test.ts`。
 */
import { describe, it, expect } from "vitest";
import { reduce, board, livingBoard, isPageHistory, isPageClosed, reachCounts, RECENT_ANSWER_MS, SLIM_DECIDED, PAGE_LIST_SHOWN, type Event } from "../src/index.js";

const HUMAN = "human";
const NOW = new Date("2026-10-30T18:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000).toISOString();

/** ULID-shaped ids that sort the way the real ones do: the board sorts instructions by id. */
let n = 0;
const id = () => `01M66Z${String(++n).padStart(4, "0")}AAAAAAAAAAAAAAAA`.slice(0, 26);

const ev = (e: Partial<Event> & { kind: string; actor: string }, when = at(10)): Event => ({ id: id(), at: when, ...e } as Event);

/**
 * One log with every shape that matters: a task finished and shipped, a task done but not shipped, a withdrawn
 * task, an instruction acked without options, an instruction acked **with** options, and one nobody acked.
 */
function log(): Event[] {
  const cardAcked = id(), cardOptions = id(), cardOpen = id();
  return [
    ev({ kind: "reading", actor: "dev", surface: "production", key: "deployed.sha", value: "aaaaaaa1111", method: "GET /health" }, at(60)),
    // 完结且上过生产：没有任何人还能对它做一件事
    ev({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "已完结且上线", criteria: ["成立"], no_human_impact: true }, at(50)),
    ev({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["src/a.ts"] }, at(49)),
    ev({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "提交 1111111", no_human_impact: true }, at(48)),
    ev({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上看到" }, at(47)),
    // 验过了但没上生产：人推一把就上线，那是一个杠杆，所以它还活着
    ev({ kind: "task", actor: "pm", op: "create", task: "t-2", title: "验过了等上线", criteria: ["成立"], no_human_impact: true }, at(46)),
    ev({ kind: "task", actor: "dev", op: "claim", task: "t-2", touches: ["src/b.ts"] }, at(45)),
    ev({ kind: "task", actor: "dev", op: "done", task: "t-2", evidence: "提交 2222222", no_human_impact: true }, at(44)),
    ev({ kind: "task", actor: "qa", op: "verify", task: "t-2", surface: "repo", pass: true, evidence: "测试通过" }, at(43)),
    // 还在做的
    ev({ kind: "task", actor: "pm", op: "create", task: "t-3", title: "在做", criteria: ["成立"], no_human_impact: true }, at(42)),
    ev({ kind: "task", actor: "frontend", op: "claim", task: "t-3", touches: ["src/c.ts"] }, at(41)),
    // 签收过、不带选项：这正是普查里那 2,247 条的形状（qa 17:21）
    { ...ev({ kind: "instruction", actor: "pm", to: "dev", body: "认领 t-3", ack_by: at(-30) }, at(40)), id: cardAcked } as Event,
    ev({ kind: "ack", actor: "dev", of: cardAcked }, at(39)),
    // 带选项、签收过而没人选：t-193 判据 6，一次签收不替人把问题从桌上收走
    { ...ev({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", ack_by: at(-30), options: ["报表", "限流"], default: "报表" }, at(38)), id: cardOptions } as Event,
    ev({ kind: "ack", actor: HUMAN, of: cardOptions }, at(37)),
    // 没人签收的
    { ...ev({ kind: "instruction", actor: "pm", to: "qa", body: "复核限流", ack_by: at(-30) }, at(36)), id: cardOpen } as Event,
  ];
}

/**
 * 游标那一头是刻意给满的：`reach` 读的是「收件人自己拉到哪儿了」（`reduce.ts:637-643`），
 * 而三桶里真正有歧义的那一桶（`read`）只有在收件人拉过那一条之后才出现。
 */
const boards = (events: Event[] = log()) => {
  const last = events[events.length - 1]?.id ?? null;
  const cursors = ["dev", "qa", "frontend", HUMAN].map((actor) => ({ actor, last_event_id: last, at: at(5) }));
  const s = reduce({ events, cursors, deliveries: [] }, NOW, HUMAN);
  const full = board(s, HUMAN, NOW);
  return { full, living: livingBoard(full, HUMAN) };
};

describe("t-307 判据① · 人那一页里历史的占比是 0", () => {
  it("已经完结并上过生产的任务离开这一页；验过而还没上线的留下——判的是「还有没有杠杆」，不是状态名", () => {
    const { full, living } = boards();
    expect((full.tasks.verified ?? []).map((t) => t.id)).toEqual(["t-1", "t-2"]);
    expect((living.tasks.verified ?? []).map((t) => t.id)).toEqual(["t-2"]);
    expect((living.tasks.working ?? []).map((t) => t.id)).toEqual(["t-3"]);
  });

  it("签收过而不带选项的指令离开这一页；带选项而还没选的留下（t-193 判据 6）", () => {
    const { full, living } = boards();
    const bodies = (b: typeof full) => b.instructions.map((i) => i.body);
    expect(bodies(full)).toEqual(["认领 t-3", "先发哪个？", "复核限流"]);
    expect(bodies(living)).toEqual(["先发哪个？", "复核限流"]);
  });

  it("砍了多少说得出来：`page_cut` 四个数，`omitted` 按 core 一直在用的那个形状", () => {
    const { living } = boards();
    // 「这一版里已经在生产上验过的」那两张名单是同一批历史走另一条路上来的，所以它们各有一个数，
    // 而**不并进上面那两个**：同一件事数两遍是假话（这里一件完结任务，recent 名单只有一条，没到上限）。
    expect(living.page_cut).toEqual({ tasks: 1, instructions: 1, live_recent: 0, live_earlier: 0 });
    expect(living.omitted).toContain("instructions[1 of 3]");
    expect(living.omitted).toContain("tasks.verified[1 of 2]");
  });

  it("完整板上没有 `page_cut`——它什么也没砍，所以它不许说自己砍了 0 条", () => {
    expect(boards().full.page_cut).toBeUndefined();
  });

  it("那两张名单超过 `PAGE_LIST_SHOWN` 就砍，而砍了几条自己有一个数——不并进「已经完结的 N 件任务」那一句", () => {
    const events = log();
    const extra: Event[] = [];
    for (let i = 10; i < 20; i++) {
      extra.push(ev({ kind: "task", actor: "pm", op: "create", task: `t-${i}`, title: `完结${i}`, criteria: ["成立"], no_human_impact: true }, at(30)));
      extra.push(ev({ kind: "task", actor: "dev", op: "claim", task: `t-${i}`, touches: [`src/${i}.ts`] }, at(29)));
      extra.push(ev({ kind: "task", actor: "dev", op: "done", task: `t-${i}`, evidence: `提交 ${i}`, no_human_impact: true }, at(28)));
      extra.push(ev({ kind: "task", actor: "qa", op: "verify", task: `t-${i}`, surface: "production", pass: true, evidence: "线上看到" }, at(27)));
    }
    const { full, living } = boards([...events, ...extra]);
    expect(full.live.recent.length).toBe(11);
    expect(living.live.recent).toHaveLength(PAGE_LIST_SHOWN);
    expect(living.page_cut!.live_recent).toBe(11 - PAGE_LIST_SHOWN);
    expect(living.page_cut!.tasks, "完结的任务数是它自己那一个，不含名单里砍掉的那几条").toBe(11);
    expect(living.omitted).toContain(`live.recent[${11 - PAGE_LIST_SHOWN} of 11]`);
    // `verified_on_production` 一条不动：它只被印成一个数，砍它就是把那个数改小
    expect(living.live.verified_on_production).toEqual(full.live.verified_on_production);
  });

  it("一栏整栏都是历史时，那一栏不留一个空数组：空数组读起来是「一件都没有」，而真相是「都不在这一页上」", () => {
    const only = log().filter((e) => !(e.kind === "task" && ["t-2", "t-3"].includes((e as { task?: string }).task ?? "")));
    const { living } = boards(only);
    expect(living.tasks.verified).toBeUndefined();
    expect(living.omitted).toContain("tasks.verified[1 of 1]");
  });
});

describe("t-307 · 人自己刚答过的那张卡留着", () => {
  it("一小时内答过的留下——否则人点完按钮回到这一页，看不见自己点了什么", () => {
    const { living } = boards();
    expect(living.instructions.map((i) => i.body)).toContain("先发哪个？");
  });

  it("出了那个窗口就走：一张不带选项、人在三小时前签收过的卡不再印", () => {
    const card = id();
    const events: Event[] = [
      { ...ev({ kind: "instruction", actor: "pm", to: HUMAN, body: "请读部署说明", ack_by: at(150) }, at(200)), id: card } as Event,
      ev({ kind: "ack", actor: HUMAN, of: card }, at(180)),
    ];
    const s = reduce({ events, cursors: [{ actor: HUMAN, last_event_id: events[events.length - 1].id, at: at(170) }], deliveries: [] }, NOW, HUMAN);
    const full = board(s, HUMAN, NOW);
    expect(full.instructions).toHaveLength(1);
    expect(livingBoard(full, HUMAN).instructions).toHaveLength(0);
    // 窗口是一个常数，而它只有一份：页面那一行（「你刚点了：…」）import 的就是它
    expect(RECENT_ANSWER_MS).toBe(60 * 60_000);
  });

  it("留的只是**人自己**那张：同样刚签收过、收件人是别人的，照旧走", () => {
    const { living } = boards();
    expect(living.instructions.map((i) => i.body)).not.toContain("认领 t-3");
  });
});

describe("t-307（pm 17:27）· 开着的指令按 reach 分三桶", () => {
  it("只数开着的，而那三桶加起来正是开着的总数", () => {
    const { full } = boards();
    const c = full.reach_counts;
    expect(c.unread + c.read + c.acted).toBe(c.open);
    expect(c.open).toBe(full.instructions.filter((i) => !isPageClosed(i)).length);
  });

  it("这个数在砍之前算：被砍掉的那一条仍然算在里面，否则这一页就说不出自己之外还有什么", () => {
    const { full, living } = boards();
    expect(living.reach_counts).toEqual(full.reach_counts);
    expect(living.reach_counts.open).toBeGreaterThan(living.instructions.filter((i) => !isPageClosed(i)).length - 1);
  });

  it("`read` 那一桶是「可能已经办完、只是账上没清」的上界：它只装「收件人拉过它、而没有任何事件引用过它」", () => {
    const { full } = boards();
    const read = full.instructions.filter((i) => !isPageClosed(i) && i.reach === "read");
    for (const i of read) expect(i.acted_by_event).toBeUndefined();
    expect(reachCounts(full.instructions).read).toBe(read.length);
  });
});

describe("t-307 · 两张板对「什么算关上了」给出同一个答案", () => {
  it("`isPageClosed` 是唯一那一处判断：撤回、已决、签收过且不带选项", () => {
    const i = (x: Partial<ReturnType<typeof boards>["full"]["instructions"][number]>) =>
      ({ id: id(), from: "pm", to: "dev", body: "x", status: "acked", reach: "read", sent: at(10), ...x }) as ReturnType<typeof boards>["full"]["instructions"][number];
    expect(isPageClosed(i({ status: "acked" }))).toBe(true);
    expect(isPageClosed(i({ status: "acked", options: ["A", "B"] }))).toBe(false);
    expect(isPageClosed(i({ status: "acked", options: ["A", "B"], chosen: { option: "A", by: HUMAN, at: at(1) } }))).toBe(true);
    expect(isPageClosed(i({ status: "withdrawn" }))).toBe(true);
    expect(isPageClosed(i({ status: "delivered" }))).toBe(false);
    expect(isPageClosed(i({ status: "pending" }))).toBe(false);
  });

  it("`isPageHistory` 同理：撤回、作废、验在生产上；而 done、failed、验在仓库上的都还活着", () => {
    const t = (x: Record<string, unknown>) => ({ id: "t-x", title: "x", status: "verified", ...x }) as Parameters<typeof isPageHistory>[0];
    expect(isPageHistory(t({ status: "verified", verified_on: ["production"] }))).toBe(true);
    expect(isPageHistory(t({ status: "verified", verified_on: ["repo"] }))).toBe(false);
    expect(isPageHistory(t({ status: "verified" }))).toBe(false);
    expect(isPageHistory(t({ status: "withdrawn" }))).toBe(true);
    expect(isPageHistory(t({ status: "obsolete" }))).toBe(true);
    expect(isPageHistory(t({ status: "done" }))).toBe(false);
    expect(isPageHistory(t({ status: "failed" }))).toBe(false);
  });

  it("最近几条已决的留着（`SLIM_DECIDED`，与瘦身板同一个常数），更早的走", () => {
    expect(SLIM_DECIDED).toBe(5);
  });
});
