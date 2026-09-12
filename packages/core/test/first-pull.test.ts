/**
 * t-226：**首次拉取要有一个绝对上限，超过时分页，且截断必须可见。**
 *
 * 量出来的起点：生产上一次无游标的拉取是 **6,193,295 字节／8,263 条，一次给全**（读数
 * `production:first.pull.size`）。qa 两分钟后独立复核得 6,330,848——**差的就是那两分钟里日志长出来的部分**，
 * 而这正是判据 1 要求「绝对值」而不是「比现在小」的理由：一条跟着被测物一起涨的地板不是地板。
 *
 * 门外那个人是谁：外部报告那支队伍每个节点都自己手写轮询（说明书教的 `ateam watch` 在人家机器上不存在），
 * **首次拉取是他们的第一条命令**。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, pull, capBytes, PULL_BYTES, type NewEvent, type Event } from "../src/index.js";

const HUMAN = "human";
async function logOf(n: number, body = "x".repeat(400)) {
  const s = new MemoryStore();
  let t = 0;
  await append(s, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, { human: HUMAN, now: new Date(++t * 1000) });
  for (let i = 0; i < n; i++) await append(s, { kind: "note", actor: "pm", body: `${i} ${body}` }, { human: HUMAN, now: new Date(++t * 1000) });
  return s;
}
const bytes = (evs: Event[]) => evs.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e), "utf8"), 0);

describe("t-226 判据 1 · 上限是一个写死的绝对值", () => {
  it("PULL_BYTES 是一个常数，不由日志算出来", () => {
    expect(PULL_BYTES).toBe(1_048_576);
    expect(typeof PULL_BYTES).toBe("number");
  });

  it("日志长大一倍，上限一个字节都不动——这正是「会涨的地板」那件事", async () => {
    const small = await logOf(50), big = await logOf(100);
    const a = capBytes((await small.read()).events, PULL_BYTES);
    const b = capBytes((await big.read()).events, PULL_BYTES);
    expect([a.more, b.more], "两边都还没到上限").toEqual([false, false]);
    expect(PULL_BYTES).toBe(1_048_576);   // 量完之后它还是那个数
  });
});

describe("t-226 判据 2、3 · 超过上限就分页，而且说得出「还有」", () => {
  it("一页装不下时：只给装得下的那些，more 为真，cursor 指向这一页最后一条", async () => {
    const s = await logOf(40);
    const r = await pull(s, "dev", null, new Date(), 4_000);
    const all = (await s.read()).events;
    expect(r.more, "截断必须看得见").toBe(true);
    expect(r.events.length, "少给了，但不是一条不给").toBeGreaterThan(0);
    expect(r.events.length).toBeLessThan(all.length);
    expect(bytes(r.events), "这一页不超上限").toBeLessThanOrEqual(4_000);
    expect(r.cursor, "cursor 是这一页最后一条，拿着它就能续").toBe(r.events[r.events.length - 1].id);
  });

  it("**一个只会「拉、存游标、再拉」的最小客户端能拉完全部**——不读文档，只看响应", async () => {
    const s = await logOf(60);
    const all = (await s.read()).events;
    // 这就是那个最小客户端：一个游标变量、一个循环，别的什么都不懂
    let cursor: string | null = null, got: Event[] = [], pages = 0;
    for (;;) {
      const r = await pull(s, "dev", cursor, new Date(), 4_000);
      got = got.concat(r.events);
      cursor = r.cursor;
      pages += 1;
      if (!r.more) break;
      expect(pages, "别转成死循环").toBeLessThan(100);
    }
    expect(got.map((e) => e.id), "一条不多、一条不少、顺序不变").toEqual(all.map((e) => e.id));
    expect(pages, "确实分了好几页").toBeGreaterThan(1);
  });

  it("最后一页不带 more——「还有」与「没了」必须分得开", async () => {
    const s = await logOf(10);
    const first = await pull(s, "dev", null, new Date(), 2_000);
    expect(first.more).toBe(true);
    let cursor = first.cursor, last = first;
    while (last.more) last = await pull(s, "dev", (cursor = last.cursor), new Date(), 2_000);
    expect(last.more, "拉到底那一次，字段不在").toBeUndefined();
    expect(cursor).toBeTruthy();
  });

  it("一条比上限还大的事件也要给得出去——否则游标永远卡在它前面", async () => {
    const s = await logOf(2, "y".repeat(5_000));
    const r = await pull(s, "dev", null, new Date(), 100);
    expect(r.events.length, "至少给一条").toBe(1);
    expect(r.more).toBe(true);
  });
});

describe("t-226 判据 4 · for_me 同样受限，而它按问的人算", () => {
  it("for_me 只含这一页里的那些；没给的不许记成已送达", async () => {
    const s = new MemoryStore();
    let t = 0;
    const put = (e: NewEvent) => append(s, e, { human: HUMAN, now: new Date(++t * 1000) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
    for (let i = 0; i < 12; i++) await put({ kind: "instruction", actor: "pm", to: "dev", body: `第 ${i} 条 ${"z".repeat(200)}`, ack_by: new Date(9e12).toISOString() });
    const r = await pull(s, "dev", null, new Date(), 1_800);
    expect(r.more).toBe(true);
    expect(r.for_me.length, "只含这一页的").toBe(r.events.filter((e) => e.kind === "instruction" && e.to === "dev").length);
    expect(r.for_me.length).toBeLessThan(12);
    const delivered = (await s.read()).deliveries?.filter((d) => d.to === "dev").length ?? 0;
    expect(delivered, "**记了投递却没给，就是「已送达」变成假话**").toBe(r.for_me.length);
  });

  it("对任一调用者都不超上限：同一批日志，两个人各自拉，各自都在上限内", async () => {
    const s = new MemoryStore();
    let t = 0;
    const put = (e: NewEvent) => append(s, e, { human: HUMAN, now: new Date(++t * 1000) });
    await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
    for (let i = 0; i < 20; i++) await put({ kind: "instruction", actor: "pm", to: i % 2 ? "dev" : "qa", body: `第 ${i} 条 ${"z".repeat(200)}`, ack_by: new Date(9e12).toISOString() });
    for (const who of ["dev", "qa"]) {
      const r = await pull(s, who, null, new Date(), 1_800);
      expect(bytes(r.events), who).toBeLessThanOrEqual(1_800);
      expect(bytes(r.for_me), `${who} 的 for_me 是 events 的子集，自然也在限内`).toBeLessThanOrEqual(1_800);
    }
  });
});
