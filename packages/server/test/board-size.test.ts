/**
 * t-070: the board does not grow with the log. GET /board is slim by default — what the page and the CLI read — and
 * ?full=1 is the whole thing. Built with the Builder; times relative.
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { Builder, board, slimBoard, omittedPaths, evidenceSha, type Board } from "@ateam/core";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp> | undefined;
afterAll(() => new Promise<void>((r) => (app ? app.close(() => r()) : r())));

/**
 * A day like today's, in shape: 40 tasks with long criteria, evidence, notes and a second round on every third, each
 * touching its own files plus one shared file now and then (a handful of seams, like a real day); 200 instructions,
 * most acked; a few decided asks. What grows with the log is the text, and that is what the slim board leaves out.
 */
async function bigDay() {
  const b = new Builder({ start: Date.now() - 6 * 3600_000, stepMs: 10_000 });
  const long = (n: number, s: string) => Array.from({ length: n }, (_, i) => `${s} ${i} ${"判据正文很长，说明人能看到什么，以及在哪个表面验".repeat(4)}`); // today's tasks carry ~6KB of text each
  for (let i = 0; i < 40; i++) {
    const id = `t-${String(i).padStart(3, "0")}`;
    await b.task.create("pm", id, `任务 ${i}：牌桌上的一件事`, long(3, "判据"), { no_human_impact: true });
    const owner = i % 2 ? "dev" : "frontend";
    await b.task.claim(owner, id, [`packages/x/${i}.ts`, `packages/x/${i}.test.ts`, ...(i % 7 === 0 ? ["packages/server/src/app.ts"] : [])]);
    await b.note(owner, "note 正文也很长：".repeat(40), { task: id });
    await b.task.done(owner, id, { evidence: `${(1000000 + i).toString(16).padStart(7, "0")}abcd @ 分支：${"证据正文很长，逐条对应判据".repeat(40)}`, shows: "人能看到的一句话" });
    if (i % 3 === 0) {
      await b.task.verify("qa", id, "repo", false, { evidence: "判据 2 未满足：".repeat(30) });
      await b.task.reopen(owner, id, "修");
      await b.task.done(owner, id, { no_human_impact: true, evidence: `${(2000000 + i).toString(16).padStart(7, "0")}abcd 改了：${"证据正文".repeat(60)}` });
    }
  }
  for (let i = 0; i < 200; i++) {
    const to = ["dev", "frontend", "qa", "pd"][i % 4];
    const ins = await b.tell("pm", to, `第 ${i} 条指令：${"正文说明要做什么以及为什么".repeat(12)}`); // ~440 bytes, like today's
    if (i % 20) await b.ack(to, ins.id); // today: 14 of 486 still open
  }
  for (let i = 0; i < 5; i++) {
    const ask = await b.tell("pd", b.human, `问题 ${i}：A 还是 B？`, { options: ["A", "B"], default: "B" });
    await b.ack(b.human, ask.id);
    await b.note(b.human, `decision: ${ask.id} -> A`, { decision: true, decides: { of: ask.id, option: "A" }, refs: [ask.id] });
  }
  return b;
}

describe("t-070 · GET /board is slim by default", () => {
  it("under a day like today's, the default board is under 12% of the full one, keeps every field the page and CLI use, and ?full=1 is the whole thing", async () => {
    const b = await bigDay();
    const full = await b.board();
    const fullBytes = Buffer.byteLength(JSON.stringify(full));
    expect(fullBytes).toBeGreaterThan(150 * 1024); // the problem is real in this sample
    const slim = slimBoard(full);
    const slimBytes = Buffer.byteLength(JSON.stringify(slim));
    expect(slimBytes / fullBytes).toBeLessThan(0.12); // t-070 criterion 3 (pm 21:32): a share of the full board, never an absolute size
    expect(slim.release).toEqual({ deployed_sha: full.release.deployed_sha, counts: full.release.counts, basis: full.release.basis }); // lists are derived from tasks: the full board has them; absent, not empty (t-077); the counts stay (t-078)
    expect(slim.omitted).toEqual(omittedPaths(full, slim)); // computed, not written; the recursive walk itself is proven in core
    expect(slim.omitted).toContain("tasks.done[].criteria");
    expect(full.omitted).toEqual([]);
    // what stays: every task with the fields the board and CLI read
    const tasks = Object.values(slim.tasks).flat();
    expect(tasks).toHaveLength(40);
    for (const t of tasks) {
      expect(Object.keys(t).filter((k) => (t as Record<string, unknown>)[k] !== undefined).sort()).toEqual(["era", "evidence_sha", "id", "owner", "shows", "status", "summary", "surfaces", "title", "verified_on"].sort());
      for (const k of ["criteria", "notes", "history", "verifications", "touches", "evidence", "created_at"]) expect(k in t && (t as Record<string, unknown>)[k] !== undefined, k).toBe(false);
      expect(t.evidence_sha).toBe(evidenceSha(Object.values(full.tasks).flat().find((x) => x.id === t.id)!.evidence) ?? undefined);
      expect(["this_version", "earlier"]).toContain(t.era);
    }
    // acked instructions go; open ones, undelivered, overdue, presence, roles, coverage, allocation, live, release, said, seams stay
    expect(slim.instructions.every((i) => i.status !== "acked" || i.chosen)).toBe(true);
    expect(slim.instructions.filter((i) => i.chosen)).toHaveLength(5);
    expect(slim.instructions.filter((i) => i.status !== "acked").length).toBe(full.instructions.filter((i) => i.status !== "acked").length);
    for (const k of ["undelivered", "overdue", "presence", "roles", "coverage", "allocation", "live", "said", "focus", "now", "alert"] as (keyof Board)[]) expect(slim[k]).toEqual(full[k]);
    expect(slim.needs_human.map((c) => [c.id, c.summary, c.title])).toEqual(full.needs_human.map((c) => [c.id, c.summary, c.title]));
    expect(slim.needs_human.every((c) => !("detail" in c))).toBe(true);
    expect(Object.values(slim.in_flight).map((g) => [g.total, g.all.length])).toEqual(Object.values(full.in_flight).map((g) => [g.total, g.all.length]));
    expect(slim.seams.filter((x) => x.open)).toEqual(full.seams.filter((x) => x.open)); // open seams in full
    expect(slim.seams.every((x) => x.open || x.overlap === undefined)).toBe(true);
    expect(slim.seams.some((x) => !x.open && !x.resolved && !x.stacked)).toBe(false); // one-owner sequences left out
    expect(slim.readings.filter((r) => r.valid)).toEqual(full.readings.filter((r) => r.valid));

    // the server: default slim, ?full=1 identical to board()
    let t = Date.now();
    app = createApp({ store: b.store, token: "k", human: "human", sha: "abc1234", alertIntervalMs: 0, clock: () => new Date(t) });
    await new Promise<void>((r) => app!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    const get = (p: string, client: string | null = "2") => fetch(`${base}${p}`, { headers: { authorization: "Bearer k", "x-actor": "qa", ...(client ? { "x-ateam-client": client } : {}) } });
    // t-080: a client that does not say it knows the slim shape (an older CLI) gets the full board, so a server upgrade never breaks it
    const old = await (await get("/board", null)).json();
    expect(old.shape).toBe(2);
    expect(old.omitted).toEqual([]);
    expect(old.tasks.done[0].criteria.length).toBe(3);
    expect((await (await get("/board", "1")).json()).omitted).toEqual([]);
    expect((await (await get("/task/t-000")).json()).shape).toBe(2);
    expect((await (await get("/events")).json()).shape).toBe(2);
    const served = await (await get("/board")).text();
    expect(Buffer.byteLength(served) / Buffer.byteLength(JSON.stringify(await (await get("/board?full=1")).json()))).toBeLessThan(0.12);
    const servedFull = await (await get("/board?full=1")).json();
    const expected = JSON.parse(JSON.stringify(board(await b.state(new Date(t)), "human", new Date(t))));
    delete servedFull.invite_url;
    expect(servedFull.owner_key).toEqual({ state: "none" });   // t-103: comes from the keys, not the log
    delete servedFull.owner_key;
    expect(servedFull).toEqual(expected);
    expect(JSON.parse(served).tasks.done[0].criteria).toBeUndefined();
    expect(JSON.parse(served).omitted).toContain("tasks.done[].criteria");
    expect(servedFull.omitted).toEqual([]);
    expect(servedFull.tasks.done[0].criteria.length).toBe(3);
  }, 30_000); // building ~600 events through append is quadratic; a real server pays this once per event, not per test
});
