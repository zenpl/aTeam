import { PART_NAMES, type Board, type ClientEvent } from "@ateam/core";
import { unjudgeableSeams, seamTruths, seamTruthEvents, type CommitsSince, type ChangedSince } from "./seamcheck.js";
import type { Part } from "./send.js";

/**
 * t-232：**`verify` 这一路也一次发多件事，而 t-228 没盖到它。**
 *
 * `done` 那一路早就走公共层了（一件被拒不再把「done 已经落库」这个事实从终端上抹掉），而 `verify --pass`
 * 这一路仍是两个裸 `emit` 循环加结尾一条：**挡不住的接缝各落一条说明、三方比较各落一条、最后才是判决本身**。
 * 一条接缝说明被拒，整条命令就掀翻——**而判决那一件根本没发出去，终端上却看不出是哪一件坏的**。
 *
 * 组装搬到这里，而不是留在 `main.ts` 的 switch 里，是 t-228 那笔账的第三次付法：用例要测命令行真跑的那一份，
 * 不是它的抄件。
 *
 * **顺序与依赖**：接缝那几条在前、判决在后，而**判决不靠它们**——所以一条都不带 `stopOnFail`。它们是顺带落的
 * 说明；一条落不下去不该让「这件验过了」消失。与 `decide` 正相反（那两件有真先后），这个差别是判据 3 要的。
 */
export function verifyParts(
  b: Board,
  task: string,
  verdict: ClientEvent,
  deps: { commitsSince: CommitsSince; changedSince: ChangedSince },
  seamCheck: boolean,
): { parts: Part<ClientEvent>[]; notes: string[] } {
  const parts: Part<ClientEvent>[] = [];
  const notes: string[] = [];
  const pass = (verdict as { pass?: boolean }).pass === true;
  // fail 不走这一段：一条接缝从来只挡 pass，不挡「它坏了」这条消息（t-112）
  if (pass && seamCheck) {
    const un = unjudgeableSeams(b, task, deps.commitsSince);
    notes.push(...un.notes);
    const truth = seamTruthEvents(seamTruths(b, task, deps.changedSince), task);
    notes.push(...truth.notes);
    for (const e of un.events) parts.push({ what: PART_NAMES.seamUnjudgeable(seamOf(e)), event: e });
    for (const e of truth.events) parts.push({ what: PART_NAMES.seamTruth(seamOf(e)), event: e });
  }
  parts.push({ what: PART_NAMES.verify(task, pass), event: verdict });
  return { parts, notes };
}

/** 接缝事件自己带着是哪两件，名字从它身上取，不另外记一份。 */
const seamOf = (e: ClientEvent): string => {
  const t = (e as { tasks?: string[] }).tasks ?? [];
  return `${t[0] ?? ""}+${t[1] ?? ""}`;
};
