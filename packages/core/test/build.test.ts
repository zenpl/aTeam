/**
 * t-062: the Builder writes a log the way the server does; what the server would reject, it rejects while building.
 * Times relative to now.
 */
import { describe, it, expect } from "vitest";
import { Builder, sampleLog, Rejected, reduce, board, surfaceResults } from "../src/index.js";

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
    await expect(b.task.verify("dev", "t-1", "repo", true)).rejects.toThrow(/owner cannot verify/);
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
