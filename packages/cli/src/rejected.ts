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
 */
export function actionOf(argv: string[]): string {
  const words = argv.filter((a) => !a.startsWith("-"));
  return words.slice(0, 3).join(" ");
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
  return `⚠ 你${howLong(now.getTime() - Date.parse(at))}有一次写入被拒（${rule}）：${part ?? what} 没有落下去。重做：${cmd}；确实不做了就划掉：${clearWith}`;
}
