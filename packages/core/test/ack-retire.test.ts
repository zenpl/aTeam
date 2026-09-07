/**
 * t-147: ack 退役。送达由服务从每个角色自己的拉取算出，显式回执只留给带选项的卡。
 *
 * 今晚的病灶：一条指令「送到了没有」以有没有 ack 事件为准，于是 release 一边稳定产出一边挂着 22 条「没确认」，
 * 而真正没人在的角色和它堆在一处——那一堆两件事都说不清。pd 05:40 的口径是：读没读到、动没动，日志里本来就写着
 * （游标和当事人自己的事件），不必回执；人只欠两件——带选项的卡要一个答案，不打算办的写一句「不办：<原因>」。
 *
 * 时间一律相对 now。
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { MemoryStore, append, empty, advance, settle, reduce, board, owedNow, owedTo, owedSentences, ruleLiveAt, ACTED_RULE_TASK, REACH_STATES, REACH_WORDS, REACH_RULE, DECLINE_PREFIX, type NewEvent, type Event } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  return { s, put };
}
const st = async (s: MemoryStore, mins = 0) => reduce(await s.read(), at(mins));

describe("t-147 · 判据 1：读到哪一条了，是从游标算出来的", () => {
  it("拉过就算读到，没拉过就算没读到；同一条指令，有没有 ack 事件都不改变这个值", async () => {
    const w = await world();
    const one = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    const two = await w.put({ kind: "instruction", actor: "pm", to: "qa", body: "验 A", ack_by: at(15).toISOString() }, -60);
    expect((await st(w.s)).instructions.get(one.id)!.reach).toBe("unread");

    // dev 拉到了 one：游标越过它的 id
    await w.s.setCursor({ actor: "dev", last_event_id: one.id, at: at(-50).toISOString() });
    expect((await st(w.s)).instructions.get(one.id)!.reach).toBe("read");
    expect((await st(w.s)).instructions.get(two.id)!.reach).toBe("unread");   // qa 没拉过

    // t-193 (pd 11:15)：**这里原来把一条光秃秃的 ack 算成「办了」**，还在这行注释里给自己讲了个理由——
    // 「它确实动了，只是那事件叫 ack」。那句话正是把「看见」读成「做了」的那一步：按 CLAUDE.md，ack 是
    // 「看见」，不是「同意」，更不是「做了」。用例名说的口径（有没有人办，不是有没有 ack）从此真的成立。
    await w.put({ kind: "ack", actor: "qa", of: two.id }, -40);
    const s2 = await st(w.s);
    expect(s2.instructions.get(two.id)!.reach, "光秃秃的 ack 不算办了").toBe("unread");   // qa 仍然没拉过
    expect(s2.instructions.get(two.id)!.acked_at, "回执照旧记下：它是一条「看见了」的记录").toBeTruthy();
    // 真动过才算：写一条引用它的 note
    await w.put({ kind: "note", actor: "qa", body: "验完了", refs: [two.id] }, -30);
    expect((await st(w.s)).instructions.get(two.id)!.reach).toBe("acted");
    expect(REACH_STATES).toEqual(["unread", "read", "acted"]);
  });

  it("「办了」由当事人自己的事件证明，牌桌把那条事件的 id 一并给出来，读的人可以自己去看", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "认领 t-9", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: i.id, at: at(-50).toISOString() });
    // 一条 note 正文里写下这条指令的 id，就是动过它的证据；不必回执
    const n = await w.put({ kind: "note", actor: "dev", body: `按 ${i.id} 认领了 t-9` }, -40);
    const b = board(await st(w.s), HUMAN, at(0));
    const row = b.instructions.find((x) => x.id === i.id)!;
    expect(row.reach).toBe("acted");
    expect(row.acted_by_event).toBe(n.id);
    expect(REACH_WORDS[row.reach]).toBe("办了");
  });
});

describe("t-147 · 判据 2 与 3：欠的是答案，不是回执", () => {
  it("不带选项的指令过了期限也不算逾期；带选项的卡到期没答案才算", async () => {
    const w = await world();
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(-10).toISOString() }, -60);
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: card.id, at: at(-5).toISOString() });
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    const s = await st(w.s);
    expect(s.instructions.get(plain.id)!.overdue).toBe(false);
    expect(s.instructions.get(card.id)!.overdue).toBe(true);
    const b = board(s, HUMAN, at(0));
    expect(b.overdue.map((o) => o.instruction)).toEqual([card.id]);
  });

  it("同一条不在两处各算一次——而且这不是巧合：带选项只发给人（rules.ts），人不进在场三态，两处按构造就不相交", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    await w.s.setCursor({ actor: "dev", last_event_id: plain.id, at: at(-1).toISOString() });
    const b = board(await st(w.s), HUMAN, at(0));
    const grouped = Object.values(b.overdue_by_presence).flatMap((g) => g.instructions);
    expect(b.overdue.map((o) => o.instruction)).toEqual([card.id]);
    expect(grouped).toEqual([plain.id]);
    expect(grouped.filter((id) => b.overdue.some((o) => o.instruction === id))).toEqual([]);
    // 给角色发带选项的指令，服务当场拒绝——这是「不相交」的出处，不是我们排出来的巧合
    await expect(w.put({ kind: "instruction", actor: "pm", to: "dev", body: "你选一个", options: ["A", "B"], ack_by: at(15).toISOString() }, -1)).rejects.toThrow(/options are for the human/);
  });

  it("一句「不办：<原因>」是答案，卡就此了结；沉默不是答案", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    expect((await st(w.s)).instructions.get(card.id)!.overdue).toBe(true);
    await w.put({ kind: "note", actor: HUMAN, body: `${DECLINE_PREFIX}这一批不该带上它，理由在 t-129 的 note 里`, refs: [card.id] }, -3);
    const s = await st(w.s);
    expect(s.instructions.get(card.id)!.overdue).toBe(false);
    expect(s.instructions.get(card.id)!.chosen).toBeTruthy();
    expect(owedTo(s, HUMAN).map((x) => x.instruction.id)).not.toContain(card.id);
  });
});

/**
 * 判据 7（pm 07:04）：人五小时没打开牌桌，那期间发出的卡照样算晚。
 *
 * 对 agent「没读到不算你欠」是对的；对人主语变了——这张单子说的是「我们还在等一个到不了的人」，而人不在的那几
 * 小时恰恰是最该被看见的。今天全队静默 4.4 小时，若把「没读到」当成「不算晚」，那 4.4 小时会显示成「什么都不晚」。
 */
describe("t-147 · 判据 7：人没读到不豁免——把缺席消音是最坏的一种沉默", () => {
  it("人从没打开过牌桌：那期间的卡照样进 overdue", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    const s = await st(w.s);
    expect(s.read_upto.get(HUMAN)).toBeUndefined();          // 人一次都没拉过
    expect(s.instructions.get(card.id)!.reach).toBe("unread");
    expect(s.instructions.get(card.id)!.overdue).toBe(true);  // 仍然算晚
    const b = board(s, HUMAN, at(0));
    expect(b.overdue.map((o) => o.instruction)).toEqual([card.id]);
  });

  it("但仍然只有一处：它不进 t-139 的在场三态，也不生成第二张给人的卡", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -60);
    const b = board(await st(w.s), HUMAN, at(0));
    expect(Object.values(b.overdue_by_presence).flatMap((g) => g.instructions)).not.toContain(card.id);
    expect(b.needs_human.filter((n) => n.id === card.id)).toHaveLength(1);   // NEEDS HUMAN 里就那一张，没有第二张
    expect(b.needs_human.filter((n) => n.from === "ateam")).toEqual([]);     // 服务没有为「它晚了」另发一张卡
  });

  it("agent 那一侧不受影响：没读到的普通指令仍然不算逾期", async () => {
    const w = await world();
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(-10).toISOString() }, -60);
    expect((await st(w.s)).instructions.get(plain.id)!.overdue).toBe(false);
  });
});

describe("t-147 · 判据 4：历史不重算", () => {
  it("已有的 ack 事件原样留在日志里，acked_at 仍在，新口径只作用于显示与判定", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    const a = await w.put({ kind: "ack", actor: "dev", of: i.id }, -50);
    const log = await w.s.read();
    expect(log.events.find((e: Event) => e.id === a.id)).toMatchObject({ kind: "ack", of: i.id, actor: "dev" });
    const s = await st(w.s);
    expect(s.instructions.get(i.id)!.acked_at).toBe(a.at);   // 事件与 acked_at 都原样留着
    // t-193：只是它不再被读成「办了」。dev 没拉过这条，也没写过引用它的事件，所以它还欠着。
    expect(s.instructions.get(i.id)!.reach).toBe("unread");
  });

  it("增量折叠与全量重算给出同一个 reach：新口径可以被 t-128 的增量状态承载", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: i.id, at: at(-50).toISOString() });
    await w.put({ kind: "note", actor: "dev", body: `办完了 ${i.id}` }, -40);
    const inc = settle(advance(empty(), await w.s.read()), at(0));
    const full = await st(w.s);
    expect(inc.instructions.get(i.id)!.reach).toBe(full.instructions.get(i.id)!.reach);
    expect(inc.instructions.get(i.id)!.acted_by_event).toBe(full.instructions.get(i.id)!.acted_by_event);
  });
});

describe("t-147 · 判据 5：新口径在 core 一处有中文说明", () => {
  it("REACH_RULE 说清了两件欠的事和沉默的代价，t-141 的说明书直接引用它，不转述", () => {
    expect(REACH_RULE).toContain("不必回执");
    expect(REACH_RULE).toContain("带选项的卡要一个答案");
    expect(REACH_RULE).toContain(DECLINE_PREFIX);
    expect(REACH_RULE).toContain("沉默不是答案");
  });
});

describe("t-147 · 判据 6：拉取时随手给出「此刻你欠什么」", () => {
  it("角色欠的是「读过还没动」那一类；办了的和别人的都不在里面", async () => {
    const w = await world();
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(15).toISOString() }, -60);
    const done = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "认领 t-9", ack_by: at(15).toISOString() }, -60);
    const other = await w.put({ kind: "instruction", actor: "pm", to: "qa", body: "验 t-9", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: other.id, at: at(-5).toISOString() });
    await w.put({ kind: "note", actor: "dev", body: "认领了", refs: [done.id] }, -4);

    const o = owedNow(await st(w.s), "dev");
    expect(o.untouched.map((x) => x.instruction)).toEqual([plain.id]);
    expect(o.untouched[0]).toMatchObject({ from: "pm", body: "去看一眼 CI" });
    // 带选项只发给人，所以今天角色这一类必然是空的——这是规则的后果，不是这条用例的巧合
    expect(o.unanswered).toEqual([]);
    expect(JSON.stringify(o)).not.toContain(done.id);   // 办了的不欠
    expect(JSON.stringify(o)).not.toContain(other.id);  // 别人的不欠
  });

  it("人拉取时，欠的是那些还没答的卡：同一个字段，两类都用得上", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], default: "B", ack_by: at(10).toISOString() }, -60);
    await w.s.setCursor({ actor: HUMAN, last_event_id: card.id, at: at(-5).toISOString() });
    const o = owedNow(await st(w.s), HUMAN);
    expect(o.unanswered.map((x) => x.instruction)).toEqual([card.id]);
    expect(o.unanswered[0]).toMatchObject({ from: "pm", options: ["A", "B"], default: "B", overdue: false });
  });
});

/**
 * t-193（pd 11:15、11:16）：**一条光秃秃的 ack 不算「办了」。**
 *
 * 按 CLAUDE.md，ack 是「看见」，不是「同意」，更不是「做了」。而 `didAct` 原来把 ack 直接算成办了，这个文件里
 * 那条用例名（「有没有人办，不是有没有 ack」）说的口径因此**不成立**——注释里还替它讲了个理由：「它确实动了，
 * 只是那事件叫 ack」。那句话正是把「看见」读成「做了」的那一步。今晚同族的第七种：名字说的和做的不一样。
 *
 * 判据 6 更宽一层：**结掉一张给人的卡，理由只能是人的答复，不能是任何人的一次 ack。**一次签收把问题从他桌上
 * 收走，和替他答没有区别。
 */
describe("t-193 · 签收不是答复，也不是做过", () => {
  it("判据 4 反例：只 ack 没动作的仍留在欠账里", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: i.id, at: at(-50).toISOString() });
    await w.put({ kind: "ack", actor: "dev", of: i.id }, -40);
    const st1 = (await st(w.s)).instructions.get(i.id)!;
    expect(st1.reach, "签收不是做过").toBe("read");
    expect(st1.acked_at, "但回执照旧记下：它是一条「看见了」的记录").toBeTruthy();
  });

  it("判据 4 正例：真动过（引用了那条指令）的清掉", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "做 A", ack_by: at(15).toISOString() }, -60);
    const n = await w.put({ kind: "note", actor: "dev", body: "认领了", refs: [i.id] }, -40);
    const row = (await st(w.s)).instructions.get(i.id)!;
    expect(row.reach).toBe("acted");
    expect(row.acted_by_event).toBe(n.id);
  });

  it("判据 6：一次 ack 不结掉给人的卡——它要留在「需要你」里，直到人真的选", async () => {
    const w = await world();
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", intent: "ask", options: ["A", "B"], ack_by: at(15).toISOString() }, -60);
    await w.put({ kind: "ack", actor: HUMAN, of: card.id }, -40);
    const b1 = board(await st(w.s), HUMAN, at(0));
    expect(b1.needs_human.map((x) => x.id), "一次签收把问题从他桌上收走了，那和替他答没有区别").toEqual([card.id]);
    // 他真的选了，才结掉
    await w.put({ kind: "note", actor: HUMAN, body: "就 A", decision: true, decides: { of: card.id, option: "A" } }, -30);
    const b2 = board(await st(w.s), HUMAN, at(0));
    expect(b2.needs_human).toEqual([]);
    expect(b2.instructions.find((x) => x.id === card.id)!.chosen).toMatchObject({ option: "A", by: HUMAN });
  });

  it("不带选项的指令没有「答案」这回事：ack 仍然把它了结，不再挂在那里等一个不存在的答复", async () => {
    const w = await world();
    const i = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(-10).toISOString() }, -60);
    await w.put({ kind: "ack", actor: "dev", of: i.id }, -40);
    const b = board(await st(w.s), HUMAN, at(0));
    expect(b.instructions.find((x) => x.id === i.id)!.status).toBe("acked");
    expect(b.overdue.map((o) => o.instruction), "它没有选项，谈不上「到期没答案」").toEqual([]);
  });

  it("判据 2：口径与用例名一致——ack 那一支真的从『办了』的判定里拿掉了，不是靠注释解释", () => {
    const src = readFileSync(new URL("../src/reduce.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const didAct = src.slice(src.indexOf("function didAct"), src.indexOf("function dirtySeams"));
    expect(didAct, "didAct 里还认 ack，那用例名说的口径就还是假的").not.toMatch(/kind === "ack"/);
    expect(didAct, "untell 留着：撤回是发的人说「不用做了」，不是收件人替自己签收").toMatch(/kind === "untell"/);
  });
});

/**
 * t-193 判据 7（pm 11:25，按 10:54 定的通则）：**t-147 上线之前的那一批，进一个具名的旁桶，不进任何人的活欠账。**
 *
 * 那 1690 条不是谁突然不干活了：那时还没有「引用才算办了」这条规矩，签收就是当时的正确做法。把它算进今天的
 * 欠账，等于用今天的规矩去数昨天的人——每个人 sync 的第一句会一次变成三位数。
 *
 * 起算点**由日志算出来**：那条规矩随 t-147 上线，而一件任务什么时候到生产，`batch.*` 那些事实里的 `contains`
 * 已经记着了。写死一个时间戳是同一条毛病的又一次：一个数与它描述的东西分开维护。
 */
describe("t-193 判据 7 · 旧的进具名旁桶，活欠账只从那条规矩上线起算", () => {
  const batchAt = (w: Awaited<ReturnType<typeof world>>, mins: number, contains: string[]) =>
    w.put({ kind: "reading", actor: "release", surface: "repo", key: "batch.14", value: { sha: "736967c", base: "b23b325", contains } }, mins);

  it("起算点由日志算出来，不写死：那一批到生产的时刻就是它", async () => {
    const w = await world();
    expect(ruleLiveAt(await st(w.s), ACTED_RULE_TASK), "还没有那一批，就没有起算点").toBeUndefined();
    const b = await batchAt(w, -30, ["t-140", ACTED_RULE_TASK, "t-154"]);
    expect(ruleLiveAt(await st(w.s), ACTED_RULE_TASK)).toBe(b.at);
    expect(ruleLiveAt(await st(w.s), "t-999"), "不在任何一批里的任务没有起算点").toBeUndefined();
  });

  it("旧的进旁桶、新的进活欠账；那句话数的是活欠账", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "很久以前的一条", ack_by: at(15).toISOString() }, -60);
    await batchAt(w, -30, [ACTED_RULE_TASK]);
    const fresh = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "上线之后的一条", ack_by: at(15).toISOString() }, -10);
    await w.s.setCursor({ actor: "dev", last_event_id: fresh.id, at: at(-5).toISOString() });   // 两条都读到了，都没动
    const owed = owedNow(await st(w.s), "dev");
    expect(owed.legacy_before_acted_rule.map((x) => x.instruction)).toEqual([old.id]);
    expect(owed.untouched.map((x) => x.instruction)).toEqual([fresh.id]);
    const line = owedSentences(owed, at(0)).find((l) => l.includes("读过还没动"))!;
    expect(line, "那句话把历史也数进去了").toContain("有 1 条");
    expect(line).toContain("上线之后的一条");
  });

  it("旁桶不归零，也不会再长：起算点之后的指令按定义进不来", async () => {
    const w = await world();
    await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "很久以前的一条", ack_by: at(15).toISOString() }, -60);
    await batchAt(w, -30, [ACTED_RULE_TASK]);
    const before = owedNow(await st(w.s), "dev").legacy_before_acted_rule.length;
    const news = [];
    for (let i = 0; i < 3; i++) news.push(await w.put({ kind: "instruction", actor: "pm", to: "dev", body: `新的第 ${i} 条`, ack_by: at(15).toISOString() }, -5));
    await w.s.setCursor({ actor: "dev", last_event_id: news[news.length - 1].id, at: at(-4).toISOString() });
    const after = owedNow(await st(w.s), "dev");
    expect(after.legacy_before_acted_rule.length, "旁桶又长了：那它就不是历史").toBe(before);
    expect(after.untouched.length, "新的都该进活欠账").toBe(3);
  });

  it("算不出起算点时，一条都不进旁桶——宁可把历史算进活欠账，也不悄悄把今天的欠账藏起来", async () => {
    const w = await world();
    const old = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "很久以前的一条", ack_by: at(15).toISOString() }, -60);
    await w.s.setCursor({ actor: "dev", last_event_id: old.id, at: at(-50).toISOString() });
    const owed = owedNow(await st(w.s), "dev");     // 日志里没有那一批
    expect(owed.legacy_before_acted_rule).toEqual([]);
    expect(owed.untouched.map((x) => x.instruction)).toEqual([old.id]);
  });
});

/**
 * t-194 判据 1、2：**「你读过还没动」那句话里要带得出那条指令的 id。**
 *
 * pm 11:05 的实测是这样发生的：他攒下 15 条，每一条都真的动过，但那几条**不在这一批里**——所以事件那几行
 * 早已滚过去了，此刻他看得到的只有这一句。id 只能在这里给，否则新口径要求的引用他做不到。
 */
describe("t-194 · 欠账那句话带得出 id", () => {
  it("两句话都点出最久那一条的 id，能直接抄进 --refs", async () => {
    const w = await world();
    const plain = await w.put({ kind: "instruction", actor: "pm", to: "dev", body: "去看一眼 CI", ack_by: at(15).toISOString() }, -60);
    const card = await w.put({ kind: "instruction", actor: "pm", to: HUMAN, body: "先发哪个？", options: ["A", "B"], ack_by: at(-10).toISOString() }, -55);
    await w.s.setCursor({ actor: "dev", last_event_id: card.id, at: at(-50).toISOString() });
    const mine = owedSentences(owedNow(await st(w.s), "dev"), at(0));
    expect(mine.find((l) => l.includes("读过还没动"))).toContain(plain.id);
    const theirs = owedSentences(owedNow(await st(w.s), HUMAN), at(0));
    expect(theirs.find((l) => l.includes("在等你答"))).toContain(card.id);
    // 判据 3：各人只看到自己那条的 id
    expect(mine.join("\n")).not.toContain(card.id);
    expect(theirs.join("\n")).not.toContain(plain.id);
  });
});
