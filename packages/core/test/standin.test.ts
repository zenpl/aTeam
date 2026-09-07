/**
 * t-130 (pd 02:53): 「人顶了几次」. Not "how many things are waiting to ship" — pd already judged that the human chose
 * that cost. This counts the part of the cost nobody chose: the times a person did by hand what a finished rule
 * would have done.
 *
 * The limit is the design, not an omission (pm, criterion 4): **the service cannot notice a stand-in by itself**.
 * When pm resolves a seam by hand, nothing tells the service that t-113 would have done it. So a person declares, and
 * the service checks the one half it can — that the task named really is verified and really is not running yet.
 * These tests hold that line: they check the checkable half, and never pretend to the other.
 *
 * All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, standIns, followUps, Rejected, STOOD_IN_PREFIX, STAND_IN_ASK_TITLE, STAND_IN_OPTIONS, SERVICE_ACTOR, type NewEvent, type Event } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);
const SHA = "eae0b22e1c645274e3cebdd1b569c26326b98aaf";

/** A project with one verified task (t-113) and one that is only done. */
async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, 0);
  for (const [id, title] of [["t-113", "接缝按符号判"], ["t-9", "还没验的一件"]] as const) {
    await put({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["能用"] , no_human_impact: true}, 1);
    await put({ kind: "task", op: "claim", actor: "dev", task: id, touches: [`packages/${id}.ts`] }, 2);
    await put({ kind: "task", op: "done", actor: "dev", task: id, evidence: `abc1234: ${id}` , no_human_impact: true}, 3);
  }
  await put({ kind: "task", op: "verify", actor: "qa", task: "t-113", surface: "repo", pass: true }, 4);
  const stood = (mins: number, actor = "pm", task = "t-113", body = "我又手裁了一条接缝") =>
    put({ kind: "note", actor, body: `${STOOD_IN_PREFIX}${body}`, task }, mins);
  const state = async (mins: number) => reduce(await s.read(), at(mins));
  return { s, put, stood, state };
}

describe("t-130 · 人顶了几次：人声明，服务校验它能校验的那一半", () => {
  it("a legal declaration: the rule it names is verified and is not running yet", async () => {
    const w = await world();
    const n = await w.stood(5);
    expect(n.id).toBeTruthy();
    const st = await w.state(6);
    const c = standIns(st, at(6));
    expect(c.total).toBe(1);
    expect(c.by_task).toEqual([{ task: "t-113", title: "接缝按符号判", count: 1, last_at: n.at, who: ["pm"] }]);
    expect(c.summary).toContain("人顶了 1 次");
    expect(c.summary).toContain("本可以自动");
  });

  it("without naming a task it is a remark, not a number: refused", async () => {
    const w = await world();
    const err = await append(w.s, { kind: "note", actor: "pm", body: `${STOOD_IN_PREFIX}又手裁了一条` }, { human: HUMAN, now: at(5) }).catch((e: Rejected) => e);
    expect(err).toBeInstanceOf(Rejected);
    expect((err as Rejected).rule).toBe("stand-in");
    expect((err as Rejected).message).toContain("要指名它替代的是哪一件任务");
  });

  it("a rule nobody has verified cannot be stood in for: that is the cost of unfinished work, not of unshipped work", async () => {
    const w = await world();
    const err = await w.stood(5, "pm", "t-9").catch((e: Rejected) => e) as Rejected;
    expect(err).toBeInstanceOf(Rejected);
    expect(err.message).toContain("是 done，不是 verified");
    expect(standIns(await w.state(6), at(6)).total).toBe(0);
  });

  it("a rule that is already running cannot be stood in for — the containment fact, and failing that, a production pass", async () => {
    // strongest: production's own containment fact, measured against the head production is at
    const w = await world();
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: SHA, method: "ateam release --deploy", writes: ["production:deployed.sha"] }, 5);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks", value: { sha: SHA, contained: ["t-113"], not_contained: [], method: "git 逐件" } }, 6);
    const err = await w.stood(7).catch((e: Rejected) => e) as Rejected;
    expect(err.message).toContain("已经在生产上");
    expect(err.message).toContain("它已经在替你干活了");

    // no containment fact for this head: a production pass is what the log knows, and it is enough to refuse
    const w2 = await world();
    await w2.put({ kind: "task", op: "verify", actor: "qa", task: "t-113", surface: "production", pass: true }, 5);
    const err2 = await w2.stood(6).catch((e: Rejected) => e) as Rejected;
    expect(err2.message).toContain("已经有人在 production 上判过 pass");

    // and with neither, the declaration stands: the ordinary day, when nobody has run `ateam release` yet
    const w3 = await world();
    expect((await w3.stood(5)).id).toBeTruthy();
  });

  it("the third time in a day becomes one specific card, and a fourth adds nothing", async () => {
    const w = await world();
    await w.stood(5);
    await w.stood(6, "qa");
    const st2 = await w.state(6);
    const third: Event = { id: "01THIRD", at: at(7).toISOString(), kind: "note", actor: "pm", body: `${STOOD_IN_PREFIX}第三次`, task: "t-113" };
    // the two before it raise nothing: a number is not a card until it is worth acting on
    for (const n of st2.notes.filter((x) => x.body.startsWith(STOOD_IN_PREFIX))) expect(followUps(st2, n, HUMAN, at(6))).toEqual([]);
    await w.s.appendRaw(third);
    const st3 = await w.state(7);
    const [card] = followUps(st3, third, HUMAN, at(7));
    expect(card).toMatchObject({ kind: "instruction", actor: SERVICE_ACTOR, to: HUMAN, intent: "ask", options: [...STAND_IN_OPTIONS], default: STAND_IN_OPTIONS[1], refs: ["01THIRD"] });
    expect(card.body).toContain(STAND_IN_ASK_TITLE);
    expect(card.body).toContain("t-113");
    expect(card.body).toContain("接缝按符号判");
    expect(card.body).toContain("pm、qa 今天手工做了 3 次");
    expect(card.body).not.toContain("37");                       // never "you have N things waiting": pd judged that already

    // a fourth, same day: nothing. One a day, whichever rule it is about.
    const fourth: Event = { id: "01FOURTH", at: at(8).toISOString(), kind: "note", actor: "qa", body: `${STOOD_IN_PREFIX}第四次`, task: "t-113" };
    await w.s.appendRaw({ ...card, id: "01CARD", at: at(7).toISOString() } as Event);
    await w.s.appendRaw(fourth);
    expect(followUps(await w.state(8), fourth, HUMAN, at(8))).toEqual([]);
  });

  it("it is a number about how the team runs, so it is on the dig layer and never in 需要你", async () => {
    const w = await world();
    await w.stood(5);
    const b = board(await w.state(6), HUMAN, at(6));
    expect(b.stand_ins.total).toBe(1);
    expect(b.stand_ins.by_task[0].task).toBe("t-113");
    expect(b.needs_human.map((x) => x.id)).not.toContain(b.stand_ins.by_task[0].task);
    expect(JSON.stringify(b.needs_human)).not.toContain("人顶了");
    // and it is a day's window, not all history
    const old = board(await w.state(60 * 25), HUMAN, at(60 * 25));
    expect(old.stand_ins.total).toBe(0);
    expect(old.stand_ins.summary).toBe("人顶了 0 次");
  });
});
