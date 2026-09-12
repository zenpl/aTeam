/**
 * t-232：**`verify` 那一路的多件事还没被 t-228 盖住。**
 *
 * t-228 在 `done` 上做对了「一条命令发多件事，每一件各自报结果」；而 `verify --pass` 这一路当时一行都没被盖到
 * ——`main.ts` 里两个裸 `emit` 循环加结尾一条，**一条接缝说明被拒就把整条命令掀翻，判决那一件根本没发出去**，
 * 而终端上看不出是哪一件坏的。这是我按 pm 给的判法自答之后自己报的「没好」：同病的第二处不会自动变好，
 * 得去动它——所以修法上移到公共层（`send.ts` 的 `sendAll`），组装搬进 `verifyparts.ts`。
 *
 * **用例导入的是命令行真跑的那两份**（`verifyParts` + `sendAll`），不是它们的抄件。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, PART_NAMES, EXIT_PARTIAL, partRefused, type NewEvent, type ClientEvent } from "@ateam/core";
import { verifyParts } from "../src/verifyparts.js";
import { sendAll } from "../src/send.js";
import { ClientError } from "../src/client.js";
import type { CommitsSince, ChangedSince } from "../src/seamcheck.js";

/** t-a 交了活、t-b 认领了同一块地但还没写代码：一条真接缝挡着 t-a 的验收。 */
const world = async () => {
  const store = new MemoryStore();
  let t = Date.now() - 3600_000;
  const emit = (e: NewEvent) => append(store, e, { human: "human", now: new Date((t += 1000)) });
  for (const id of ["t-a", "t-b"]) await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"], no_human_impact: true });
  await emit({ kind: "task", op: "claim", actor: "frontend", task: "t-b", touches: ["packages/core/src/board.ts"] });
  await emit({ kind: "task", op: "claim", actor: "dev", task: "t-a", touches: ["packages/core/src/board.ts"] });
  await emit({ kind: "task", op: "done", actor: "dev", task: "t-a", evidence: "aaaaaaa 完成", no_human_impact: true });
  return board(reduce(await store.read()), "human");
};
const noCommits: CommitsSince = () => false;
const noChanges: ChangedSince = () => [];
const verdictOf = (pass: boolean) => ({ kind: "task", op: "verify", task: "t-a", surface: "repo", pass, evidence: "跑过了" } as unknown as ClientEvent);

const run = async (parts: { what: string; event: ClientEvent }[], fails: (e: ClientEvent) => string | null) => {
  const out: string[] = [], err: string[] = [], sent: string[] = [];
  const r = await sendAll(parts, async (e) => {
    const why = fails(e);
    if (why) throw new ClientError(409, { error: "rejected", rule: "seam", message: why });
    sent.push((e as { op?: string }).op ?? "");
    return { id: "01X", line: `事件行 ${(e as { op?: string }).op}` };
  }, (l) => out.push(l), (l) => err.push(l));
  return { ...r, out, err, sent };
};

describe("t-232 判据 1 · verify 一次发的那几件，各报一行，判决排最后", () => {
  it("接缝说明与判决排在同一份里，名字各自说得出是哪一件，判决排最后", async () => {
    const b = await world();
    const verdict = verdictOf(true);
    const { parts } = verifyParts(b, "t-a", verdict, { commitsSince: noCommits, changedSince: noChanges }, true);
    expect(parts.map((p) => p.what)).toEqual([PART_NAMES.seamUnjudgeable("t-a+t-b"), PART_NAMES.verify("t-a", true)]);
    expect(parts[parts.length - 1].event, "判决是最后一件，而且就是传进去的那一条").toBe(verdict);
    expect((parts[0].event as { op?: string }).op, "前面那件是接缝").toBe("seam");
  });

  it("**这就是没被盖住的那一幕**：接缝说明被拒，而判决照样发得出去、终端上说得清是哪一件坏的", async () => {
    const b = await world();
    const { parts } = verifyParts(b, "t-a", verdictOf(true), { commitsSince: noCommits, changedSince: noChanges }, true);
    const r = await run(parts, (e) => ((e as { op?: string }).op === "seam" ? "no seam between t-a and t-b" : null));
    expect(r.sent, "判决真的发出去了——在这之前它根本发不到").toEqual(["verify"]);
    expect(r.out[0]).toBe(partRefused(PART_NAMES.seamUnjudgeable("t-a+t-b"), "REJECTED (seam): no seam between t-a and t-b"));
    expect(r.out[1]).toContain("verify");
    expect(r.exit, "有成有拒 ⇒ 部分成功，不是 2").toBe(EXIT_PARTIAL);
  });

  it("判据 4：全成仍是 0，全拒仍是 2", async () => {
    const b = await world();
    const { parts } = verifyParts(b, "t-a", verdictOf(true), { commitsSince: noCommits, changedSince: noChanges }, true);
    expect((await run(parts, () => null)).exit).toBe(0);
    expect((await run(parts, () => "全拒")).exit).toBe(2);
  });

  it("**接缝那几条不带 stopOnFail**：它们是顺带落的说明，判决不靠它们（与 decide 那两件正相反）", async () => {
    const b = await world();
    const { parts } = verifyParts(b, "t-a", verdictOf(true), { commitsSince: noCommits, changedSince: noChanges }, true);
    expect(parts.map((p) => p.stopOnFail ?? false)).toEqual([false, false]);
  });

  it("--fail 与 --no-seam-check 都只发判决一件：接缝从来只挡 pass（t-112）", async () => {
    const b = await world();
    expect(verifyParts(b, "t-a", verdictOf(false), { commitsSince: noCommits, changedSince: noChanges }, true).parts).toHaveLength(1);
    expect(verifyParts(b, "t-a", verdictOf(true), { commitsSince: noCommits, changedSince: noChanges }, false).parts).toHaveLength(1);
  });

  it("判不了的那几条走 notes、不走事件——它们是说给人看的，不是要写进日志的", async () => {
    const b = await world();
    const blind: CommitsSince = () => null;
    const v = verifyParts(b, "t-a", verdictOf(true), { commitsSince: blind, changedSince: noChanges }, true);
    expect(v.notes.length).toBeGreaterThan(0);
    expect(v.parts.map((p) => p.what)).toEqual([PART_NAMES.verify("t-a", true)]);
  });
});
