/**
 * t-062: the Builder writes a log the way the server does; what the server would reject, it rejects while building.
 * Times relative to now.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Builder, sampleLog, Rejected, reduce, board, surfaceResults, manual, WATCH_INTERVAL, REACH_RULE } from "../src/index.js";
import { DEFAULT_WATCH_CMD } from "../../cli/src/deaf.js";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ulidTime = (id: string) => [...id.slice(0, 10)].reduce((n, c) => n * 32 + ALPHABET.indexOf(c), 0);
const min = (n: number) => n * 60_000;

describe("t-062 · Builder", () => {
  it("field names are the server's; deliveries and cursors carry event_id and last_event_id; ids carry the clock", async () => {
    const start = Date.now() - min(60);
    const b = new Builder({ start, stepMs: min(1) });
    const i = await b.tell("pm", "dev", "做 t-1");
    expect(i).toMatchObject({ kind: "instruction", actor: "pm", to: "dev", body: "做 t-1", at: new Date(start + min(1)).toISOString(), ack_by: new Date(start + min(16)).toISOString() });
    expect(ulidTime(i.id)).toBe(start + min(1));
    const p = await b.pull("dev");
    expect(p.for_me.map((e) => e.id)).toEqual([i.id]);
    const log = await b.log();
    expect(log.deliveries).toEqual([{ event_id: i.id, to: "dev", at: new Date(start + min(2)).toISOString() }]);
    expect(log.cursors).toEqual([{ actor: "dev", last_event_id: i.id, at: new Date(start + min(2)).toISOString() }]);
    await b.ack("dev", i.id);
    const st = await b.state();
    expect(st.instructions.get(i.id)).toMatchObject({ delivered_at: new Date(start + min(2)).toISOString(), acked_at: new Date(start + min(3)).toISOString() });
    // a second pull reads only what came after the cursor
    await b.note("pm", "x");
    const p2 = await b.pull("dev");
    expect(p2.events.map((e) => e.kind)).toEqual(["ack", "note"]);
    expect(b.steps.map((s) => s.kind)).toEqual(["event", "pull", "event", "event", "pull"]);
  });

  it("an illegal move is rejected at build time: done before claim, reopen then done without claim is fine, verify by the owner, ack of a stranger's instruction", async () => {
    const b = new Builder();
    await b.task.create("pm", "t-1", "题", ["能用"]);
    await expect(b.task.done("dev", "t-1")).rejects.toBeInstanceOf(Rejected);
    await b.task.claim("dev", "t-1", ["x"]);
    await b.task.done("dev", "t-1", { evidence: "abc1234" });
    await expect(b.task.verify("dev", "t-1", "repo", true)).rejects.toThrow(/owner cannot pass/);
    await b.task.verify("qa", "t-1", "repo", false, { evidence: "不对" });
    await expect(b.task.done("dev", "t-1")).rejects.toThrow(/is failed/); // must reopen (or claim) first
    await b.task.reopen("dev", "t-1", "改");
    await b.task.done("dev", "t-1", { evidence: "def5678" });
    await b.task.verify("qa", "t-1", "repo", true);
    const i = await b.tell("pm", "dev", "x");
    await expect(b.ack("qa", i.id)).rejects.toThrow(/addressed to dev/);
    const t = (await b.state()).tasks.get("t-1")!;
    expect(t.round).toBe(2);
    expect(surfaceResults(t)).toEqual([{ surface: "repo", pass: true }]);
    expect(t.verifications.map((v) => [v.round, v.pass])).toEqual([[1, false], [2, true]]);
    // nothing rejected made it into the log; the service's fail notice after the failed verify is there, as on the server
    expect((await b.log()).events.map((e) => e.kind + ("op" in e ? ":" + e.op : ""))).toEqual(["task:create", "task:claim", "task:done", "task:verify", "instruction", "task:reopen", "task:done", "task:verify", "instruction"]);
    expect(b.steps.find((s) => s.kind === "event" && s.event.kind === "task" && s.event.op === "verify")).toMatchObject({ followed: [{ kind: "instruction", to: "dev" }] });
  });

  it("the sample log holds an instruction with its delivery, cursors for three roles, a decision and a two-round task; it reduces and boards", async () => {
    const start = Date.now() - min(120);
    const log = await sampleLog({ start });
    expect(log.events.some((e) => e.kind === "instruction" && e.to === "dev")).toBe(true);
    expect(log.deliveries.map((d) => d.to)).toContain("dev");
    expect(log.cursors.map((c) => c.actor).sort()).toEqual(["dev", "pm", "qa"]);
    for (const c of log.cursors) expect(log.events.some((e) => e.id === c.last_event_id)).toBe(true);
    for (const d of log.deliveries) expect(log.events.find((e) => e.id === d.event_id)?.kind).toBe("instruction");
    for (const e of log.events) { expect(Date.parse(e.at)).toBeLessThan(Date.now()); expect(ulidTime(e.id)).toBe(Date.parse(e.at)); }
    const now = new Date(Date.parse(log.events.at(-1)!.at) + min(1));
    const s = reduce(log, now);
    const t = s.tasks.get("t-1")!;
    expect(t.status).toBe("verified");
    expect(t.round).toBe(2);
    expect(t.history.map((h) => h.op)).toEqual(["done", "verify", "reopen", "done", "verify"]);
    const b = board(s, "human", now);
    expect(b.tasks.verified.map((x) => x.id)).toEqual(["t-1"]);
    expect(b.instructions.find((i) => i.to === "dev")).toMatchObject({ status: "acked" });
    expect(b.instructions.find((i) => i.to === "human")!.chosen).toMatchObject({ option: "A", by: "human" });
    expect(b.needs_human).toEqual([]);
  });
});

/**
 * t-145: the watch interval is one number in one place. It was four places holding three: the CLI's real default
 * (20s), the manual and CLAUDE.md teaching 25s, and t-139's reminder suggesting 60s — and pm ruled on 25 while the
 * default was 20, because nobody could see all four at once.
 *
 * Same instrument as t-108: the prose is filled from the constant that decides it, and a hard-coded one turns the
 * build red. What the number should *be* is not settled — see WATCH_INTERVAL — but where it lives now is.
 */
describe("t-145 · watch 的间隔只有一处", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("说明书教的间隔是填进去的，不是抄的", () => {
    expect(read("../manual/common.md")).toContain("--interval {{watch_interval}}");
    const filled = manual("dev")!;
    expect(filled).toContain(`--interval ${WATCH_INTERVAL}`);
    expect(filled).not.toContain("{{watch_interval}}");            // the hole is filled, never shown to a reader
  });

  it("说明书与帮助文本里都不再写死一个间隔数字", () => {
    const hard = /--interval\s+\d+\s*(?:s|ms|m)\b/g;
    // t-156: CLAUDE.md 也在里面。今晚它是唯一漏网的那一处——t-145 把四份合成一份时没查它，于是默认值已经是 60
    // 秒了，而每个 agent 每天读的那份文件还在教 25 秒。被教的那个数看起来就像默认值。
    for (const [what, text] of [["说明书", read("../manual/common.md")], ["CLI 帮助", read("../../cli/src/main.ts")], ["提醒", read("../../cli/src/deaf.ts")], ["CLAUDE.md", read("../../../CLAUDE.md")]] as const) {
      const found = [...text.matchAll(hard)].map((m) => m[0]);
      expect(found, `${what} 里写死了间隔：${found.join("、")}——它该从 WATCH_INTERVAL 取`).toEqual([]);
    }
  });

  it("t-156：一个新节点什么都不配，拿到的就是这个数", () => {
    // 「默认值就是协议」：不给 --interval 时走的就是 WATCH_INTERVAL，CLI 里没有第二个默认值
    const src = read("../../cli/src/main.ts");
    expect(src).toMatch(/str\(a,\s*"interval"\)\s*\?\?\s*WATCH_INTERVAL/);
    expect(WATCH_INTERVAL).toBe("60s");
    // 全仓库只有这一处写着这个数（t-145 的不变式）：源码里搜不到第二个裸的 60s / 60_000 当间隔用
    for (const p of ["../../cli/src/main.ts", "../../cli/src/loop.ts", "../../cli/src/deaf.ts", "../manual/common.md", "../../../CLAUDE.md"]) {
      expect(read(p), `${p} 里写死了间隔`).not.toMatch(/--interval\s+\d+\s*(?:s|ms|m)\b/);
    }
  });

  it("三处说的是同一个数：从常量取的那一个", () => {
    const cmd = DEFAULT_WATCH_CMD;
    expect(cmd).toBe(`ateam watch --interval ${WATCH_INTERVAL}`);
    expect(manual("dev")!).toContain(cmd.replace("ateam ", "ateam "));
    expect(read("../../cli/src/main.ts")).toContain("--interval ${WATCH_INTERVAL}");   // the help line, as a template
  });

  it("改常量就是改全部：没有第二处需要跟着改", () => {
    // every place that teaches the interval reads the same source, so this test is the whole list of them
    const sources = ["../manual/common.md", "../../cli/src/main.ts", "../../cli/src/deaf.ts"];
    for (const p of sources) expect(read(p)).toMatch(/watch_interval|WATCH_INTERVAL/);
  });
});

/**
 * t-141: 「你欠什么」那一段是 pd 06:27 的字。它在 core 里只有一份（REACH_RULE），说明书填进去，不抄。
 *
 * 这一件的整个由来就是「一边停一边教」：说明书教「先 ack 再做别的」，而行为已经不这么算了。抄一份到 markdown
 * 里，下一次口径变的时候两份就会又分开——同一条 t-108/t-145 的规矩，这次守的是一段话不是一个数。
 */
describe("t-141 · 说明书里「你欠什么」那一段只有一处出处", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("说明书是填 REACH_RULE，不是抄它的字", () => {
    const src = read("../manual/common.md");
    expect(src).toContain("{{reach_rule}}");
    expect(src).not.toContain("沉默不是答案");                 // 一个字都不在 markdown 里
    const filled = manual("dev")!;
    expect(filled).toContain(REACH_RULE);
    expect(filled).not.toContain("{{reach_rule}}");
  });

  it("三份说明书都不再教已经退役的「先 ack 再做别的」", () => {
    for (const p of ["../manual/common.md", "../manual/invite.md", "../manual/welcome.md"]) {
      const text = read(p);
      expect(text, `${p} 还在教 ack`).not.toMatch(/先\s*ack|必须\s*ack|每一条发给你的指令.*ack/);
      expect(text, `${p} 还在教发 ack 事件`).not.toContain('"kind":"ack"');
    }
  });

  it("代价说在明处：不是「你会被记一笔」，是「发的人会一直以为你还没读到」", () => {
    expect(REACH_RULE).toContain("沉默不是答案");
    expect(REACH_RULE).toContain("发的人会一直以为你还没读到");
    expect(manual("dev")!).toContain("发的人会一直以为你还没读到");
  });
});
