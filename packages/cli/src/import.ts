import { parseImport, importAlready, importSummary, IMPORT_NOTHING_WRITTEN, type ImportRecord } from "@ateam/core";
import type { ClientEvent, Event } from "@ateam/core";
import { sendAll } from "./send.js";
import * as fmt from "./format.js";

/** 服务写完一条之后回的东西：事件本身，外加「这次真写了没有」（t-088 的去重发生在服务端）。 */
export type Written = Event & { created?: boolean };

/**
 * t-224：**`ateam import` 真正跑的那一段。**
 *
 * 住在 main.ts 之外，是 t-228 那一笔账的第二次付法：那次我先把逻辑抄进用例、再发现用例测的是抄件而不是
 * 命令行跑的东西。这里一开始就只有一份。
 *
 * **有一行不合格就一条都不发**：半份搬进去之后，人要自己算「哪几条已经在里面了」，而那正是 `from` 本来
 * 替他免掉的活。两个流都写：看它的进程只把 stdout 当事件流（t-225），人盯着终端时两处都看得见。
 */
export async function runImport(
  text: string,
  emit: (e: ClientEvent) => Promise<Written>,
  me: string,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const { records, problems } = parseImport(text);
  if (problems.length) {
    for (const l of [IMPORT_NOTHING_WRITTEN, ...problems.map((x) => x.why)]) { out(l); err(l); }
    return 2;
  }
  let written = 0, already = 0;
  const r = await sendAll<ImportRecord>(records.map((rec) => ({ what: rec.from, event: rec })), async (rec) => {
    const ev = await emit(rec.event as unknown as ClientEvent);
    // t-088 的去重在服务端；**这里要把它说出来**，否则「早就搬过了」与「刚搬进去」在终端上一模一样，
    // 而判据 2 要人看见的正是这个差别。
    if (ev.created === false) { already += 1; return { id: ev.id, line: `${ev.id}  ${importAlready(rec.from)}` }; }
    written += 1;
    return { id: ev.id, line: `${ev.id}  ${fmt.event(ev, me)}` };
  }, out, err);
  out(importSummary(written, already));
  return r.exit;
}
