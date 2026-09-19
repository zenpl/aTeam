/**
 * t-116 (S7): a write the rules refused is visible for exactly one second — the moment it happens. At 01:11 I read a
 * successful `tell` and told two people a task was done; the `done` itself had been refused seconds earlier and I never
 * looked. Nothing connected the refusal to the two "it's finished" messages that followed.
 *
 * So the node keeps its own last refusal beside the cursor and says it again on the next `sync` or `board`, until the
 * same action goes through or the person crosses it off. Like the deaf notice (t-102): to this node only, no event, no
 * log line — a refusal is this node's business, not a broadcast.
 */
import { ago, alreadyDoneNotice } from "@ateam/core";

export interface Refusal {
  /** ISO time of the refusal. */
  at: string;
  /** The rule that refused: what the server or the CLI named. */
  rule: string;
  /** The command as it was run, so it can be tried again after fixing it. */
  cmd: string;
  /** The action it identifies with, so a later success can cross it off: "task done t-113", "reading roles". */
  what: string;
  /**
   * t-233：**这次拒绝是哪一类。** 带着它的，意思是「那件事已经发生过了，这一次是多余的」，`at` 是它发生的
   * 时刻（说不出是 null）。不带的是另一类：那件事没发生。**类别是拒绝自己带来的**（服务端 409 的正文里、
   * 或本地那次 Rejected 上），不是在这里靠匹配拒绝话的字猜出来的——判据 2。
   */
  already?: { at: string | null };
  /**
   * t-241：**一次发多件时，被拒的是哪一件。** `what` 仍然是这条命令的动作（划掉那条规矩认的是它），
   * 而人要看的是「没落下去的是哪一件」——`t-226 done` 成了、`解决接缝 t-226+t-070` 被拒，是两件事。
   */
  part?: string;
}

/** What the record says right now. `clean` covers both "never refused" and "refused, then redone". */
export type RefusalState = { kind: "clean" } | { kind: "open"; refusal: Refusal } | { kind: "unreadable" };

export function readRefusal(raw: string | null): RefusalState {
  if (raw === null || !raw.trim()) return { kind: "clean" };
  let r: Partial<Refusal> | null = null;
  try { r = JSON.parse(raw) as Partial<Refusal>; } catch { r = null; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { kind: "unreadable" };
  const { at, rule, cmd, what, already } = r;
  if ([at, rule, cmd, what].some((x) => typeof x !== "string" || !x)) return { kind: "unreadable" };
  if (Number.isNaN(Date.parse(at as string))) return { kind: "unreadable" };
  // t-233：类别读不出来就是「没带类别」，也就是另一类——**记坏了不许被当成「已经办好了」**，那会让人不去重做一件真没落下去的事
  const part = typeof r.part === "string" && r.part.trim() ? r.part : undefined;
  const at2 = already && typeof already === "object" && !Array.isArray(already) ? (already as { at?: unknown }).at : undefined;
  const done = at2 === null || typeof at2 === "string" ? { at: (at2 ?? null) as string | null } : undefined;
  return { kind: "open", refusal: { at: at as string, rule: rule as string, cmd: cmd as string, what: what as string, ...(part ? { part } : {}), ...(done ? { already: done } : {}) } };
}

/**
 * Which action a command line is about, so a later success can cross off the refusal it left. Two words is enough to
 * tell `task done t-113` from `task claim t-113`: the same task, and only one of them was refused.
 *
 * t-283：**上一版取前三个非选项词，于是 `tell <谁> <正文>` 把整条正文算进了指纹**——实测三次（qa 两次、pm 一次）
 * 都是 `what = "tell " + 收件人 + " " + 整条正文`，前缀恰好 8 字。而这一族被拒的唯一成因是**正文超长**，
 * 唯一的修法是**改短正文**：于是重发必然换指纹，那条记录**永远划不掉**——「重发」与「改指纹」在这一类里是同一个动作。
 *
 * **所以指纹只认「这是在对谁做哪件事」，不认自由正文。** 逐条写死在 `IDENTITY_WORDS` 里：
 * · `tell <收件人>`——收件人进，正文不进；
 * · `note` / `say` / `focus`——整条都是自由正文，只剩子命令；
 * · `reading <key>`——键进，值是数据，不进；
 * · 其余（`task <op> <id>`、`untell <id>`、`ack <id>`…）照旧取前三个词：**那第三个词是 id，不是正文。**
 *
 * **这笔交换是有代价的，写在明处**：粒度变粗之后，「对同一个人的另一条 tell 成功了」也会划掉那条被拒记录——
 * **误划一次的代价有界**（要真的再跑一次同一个命令、对同一个目标），**而漏划是无界的**（那条记录永远在，
 * 每次 `sync` 都再说一遍同一件已经办完的事）。有界的错换无界的错，换。
 */
const IDENTITY_WORDS: Record<string, number> = {
  tell: 2,      // tell <收件人> <正文>
  note: 1,      // note <正文>
  say: 1,       // say <正文>
  focus: 1,     // focus <正文>
  reading: 2,   // reading <key> <值>
  // **选项的「值」不是选项**：`words` 只滤掉以 `-` 开头的那一个词，紧跟其后的值照旧算位置词。
  // 于是 `untell <id> --reason "写错了"` 的第三个词是那句理由、`premise <id> --depends-on a,b` 的是那串依赖，
  // **与 tell 是同一个病的另外两处**——我第一版只修了 tell，是这条用例把它们照出来的。
  untell: 2,    // untell <指令 id> --reason <理由>
  premise: 2,   // premise <指令 id> --depends-on/--valid-until <值>
};

function take(words: string[]): string {
  return words.slice(0, IDENTITY_WORDS[words[0] ?? ""] ?? 3).join(" ");
}

export function actionOf(argv: string[]): string {
  return take(argv.filter((a) => !a.startsWith("-")));
}

/**
 * t-283：**盘上已经有的那些记录是旧规则写的**——它们的 `what` 里带着整条正文。只改 `actionOf` 不够：
 * 修好之后，一条旧记录的 `what`（`"tell pm <三百字>"`）仍然对不上新的指纹（`"tell pm"`），**它照样永远划不掉**。
 * 所以读的时候按同一张表把存下来的那串也收窄一次。**没有这一步，四份真标本一份都划不掉，而单元测试全绿**——
 * 这正是判据 4 坚持要用真文件的理由。
 */
export function identityOf(what: string): string {
  return take(what.split(/\s+/).filter(Boolean));
}

// t-180: was a fourth copy of the ladder, under a different name — which is why a search for `ago` did not find it.
const howLong = ago;

/**
 * t-233：**说完就划掉的那一类。** 「那件事已经发生过了」没有「重做一次就消失」这条出路（再做一次只会再被拒），
 * 留着它就会每一次 sync 都再说一遍同一件不用做的事——**一个说不完的提醒，和一个不起作用的期限是同一个病**。
 * 另一类照旧留着：它要么被同一个动作的一次成功划掉，要么由人自己划。
 */
export const clearsAfterNotice = (st: RefusalState): boolean => st.kind === "open" && !!st.refusal.already;

/** The one line, or null when there is nothing to say. Only `sync` and `board` carry it: they are what a turn starts with. */
export function refusalNotice(st: RefusalState, now: Date, clearWith = "ateam sync --clear-refused"): string | null {
  if (st.kind === "clean") return null;
  if (st.kind === "unreadable") return `⚠ 你上一次被拒的写入记坏了，说不出是哪一条。要划掉它：${clearWith}`;
  const { at, rule, cmd, what, already, part } = st.refusal;
  // t-233：两类各说各的。**「已经办好了」那一类不说「没有落下去」，也不给「重做」**——真样本是 qa 16:55 那次，
  // 拒绝话逐字写着 already acked at 16:54:51.880Z，而这里照旧叫人重做一遍。句子在 core（措辞待 pd 定稿）。
  if (already) return alreadyDoneNotice(what, already.at, clearWith);
  // t-283 判据 6：**这两句随事实一起改，不等 pd**——这段字只出现在 agent 的命令行输出里，人看不到。
  // 我核过前提：`.ateam/refused.<me>` 只由 `packages/cli/src/main.ts` 读写（`refusalFile` 三处），从不发往服务端；
  // `core/src/store.ts` 里那个 `refused` 是服务端那本账（`POST /refusals` 收的），两回事。
  // 改的是「重做」那半：旧话叫人把原样那条再跑一遍，而这一类被拒的成因就是正文超长——**原样重跑只会再被拒一次**。
  return `⚠ 你${howLong(now.getTime() - Date.parse(at))}有一次写入被拒（${rule}）：${part ?? what} 没有落下去。重做：${cmd}（正文改短也算：指纹只认对谁做哪件事）；确实不做了就划掉：${clearWith}`;
}
