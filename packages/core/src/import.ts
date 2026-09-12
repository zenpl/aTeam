import type { NewEvent } from "./events.js";

/**
 * t-224：**把别处的记录搬进日志的那条路。**
 *
 * S9（搬家）是 human 09-06 排的第三个场景：用户本来就有几个在协作的 agent，给其中一个一个地址，**在途的任务、
 * 决策、事实、待人拍板的卡要出现在牌桌上，一件都不丢**。平台那一侧 t-088 早就做好了（带 `from` 的事件只写一次，
 * 重导一遍不翻倍）；**缺的是我们指给客户的那支 CLI 送不出 `from`**——t-088 上线至今 7051 条事件里，`from` 出现
 * 过 0 次。一条从来没有人走过的路，和没有这条路，对要搬家的人是同一件事。
 *
 * 这里只做解析与判决，不碰网络：**`from` 的值必须逐字来自被搬的那份记录**，工具不替它编一个（用文件名、行号
 * 或时间戳凑一个 `from` 出来，看着也能去重，但它说的不是「这条在原处是哪一条」，而是「我这次跑在第几行」——
 * 换一次文件名就重导一遍，而重导一遍本来是这套机制唯一要防的事）。
 */

/** 搬进来的一条：`from` 是它在原处的身份，`event` 是它在这里的样子。 */
export interface ImportRecord {
  /** 文件里的行号，从 1 数。人拿着它去改文件。 */
  line: number;
  from: string;
  event: NewEvent;
}

/** 某一行搬不进来，以及为什么。`why` 是给人读的一整句话。 */
export interface ImportProblem { line: number; why: string }

/**
 * 一行 JSON 里，**由这里铸、不许由文件给**的那几个字段。
 *
 * `id` 与 `at` 是日志在写入那一刻铸的；`actor` 是服务按谁在发这条请求签的。文件里写了也不会被采纳——
 * **而「写了不被采纳」与「没写」在结果上一模一样，那正是这套东西整天在栽的那一族**。所以不静默丢掉，明说。
 */
export const IMPORT_MINTED = ["id", "at", "actor"] as const;

/**
 * 判据 3 那一句：**没给 `from` 就不写**。
 *
 * **措辞待 pd 定稿**（本件按 pm 的判据先用占位；这是唯一一处出处，改也只改这里）。它要说清三件事：不写，
 * 为什么要 `from`，以及不带会怎样——不带 `from` 的记录在这里就是一条普通新事件，**下一次再导一遍就多一份**。
 */
export const importNoFrom = (line: number): string =>
  `第 ${line} 行没有 from，这一条没搬进去。from 是它在原处的身份（单号、路径、链接、消息 id 都行，原样抄过来即可）：日志按它认出「这条搬过了」，所以带着它重导一遍不会多出第二份，不带它重导一遍就会。`;

export const importNotJson = (line: number, snippet: string): string =>
  `第 ${line} 行不是一条 JSON：${snippet}`;

export const importNotObject = (line: number): string =>
  `第 ${line} 行不是一条记录（要的是一个 JSON 对象，一行一条）`;

export const importNoKind = (line: number): string =>
  `第 ${line} 行没有 kind，不知道要把它写成哪一种事件`;

export const importMinted = (line: number, field: string): string =>
  `第 ${line} 行自带了 ${field}，这一条没搬进去。${field} 由日志在写入那一刻定，文件里给的不会被采纳——与其悄悄换掉、让你以为搬过来的还是原样，不如在这里停下`;

/** 这份文件一条都没搬：先改好下面这几行，再跑一次。 */
export const IMPORT_NOTHING_WRITTEN =
  "这份文件一条都没搬进去。下面每一行各是什么问题，改好之后原样再跑一次——已经搬过的不会重复。";

/** 一条原处早就搬过了：日志把第一条还回来，没有多出第二份。 */
export const importAlready = (from: string): string =>
  `原处 ${from} 早就搬过了，日志里还是那一条，没有多出第二份`;

/** 一次搬家的收尾：搬进去几条，几条本来就在。 */
export const importSummary = (written: number, already: number): string =>
  `搬完：新写 ${written} 条，本来就在的 ${already} 条`;

/**
 * 一份 JSONL 文本（一行一条 JSON）解析成要搬的那些记录，与搬不进去的那些行。
 *
 * 空行与 `#` 开头的行跳过，两者都不算记录也不算问题——一份人手工整理出来的搬家清单里会有注释。
 *
 * **有一行搬不进去，就一条都不发**（调用方据 `problems` 非空决定）：半份搬进去之后，人要自己算「哪几条已经
 * 在里面了」，而这正是 `from` 本来要替他免掉的活。全停下、全改完、原样再跑一遍，是这条路最便宜的用法。
 */
export function parseImport(text: string): { records: ImportRecord[]; problems: ImportProblem[] } {
  const records: ImportRecord[] = [];
  const problems: ImportProblem[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const s = raw.trim();
    if (!s || s.startsWith("#")) return;
    let parsed: unknown;
    try { parsed = JSON.parse(s) as unknown; }
    catch { problems.push({ line, why: importNotJson(line, s.slice(0, 60)) }); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { problems.push({ line, why: importNotObject(line) }); return; }
    const o = parsed as Record<string, unknown>;
    for (const field of IMPORT_MINTED) {
      if (o[field] !== undefined) { problems.push({ line, why: importMinted(line, field) }); return; }
    }
    const from = o.from;
    // 判据 1：**值由调用者给**。空串、空白、不是字符串，都算没给——一个空的 `from` 去重不了任何东西，
    // 而它长得像「给了」。
    if (typeof from !== "string" || !from.trim()) { problems.push({ line, why: importNoFrom(line) }); return; }
    if (typeof o.kind !== "string" || !o.kind.trim()) { problems.push({ line, why: importNoKind(line) }); return; }
    records.push({ line, from: from.trim(), event: { ...o, from: from.trim() } as unknown as NewEvent });
  });
  return { records, problems };
}
