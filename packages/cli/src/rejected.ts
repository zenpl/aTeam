/**
 * t-116 (S7): a write the rules refused is visible for exactly one second — the moment it happens. At 01:11 I read a
 * successful `tell` and told two people a task was done; the `done` itself had been refused seconds earlier and I never
 * looked. Nothing connected the refusal to the two "it's finished" messages that followed.
 *
 * So the node keeps its own last refusal beside the cursor and says it again on the next `sync` or `board`, until the
 * same action goes through or the person crosses it off. Like the deaf notice (t-102): to this node only, no event, no
 * log line — a refusal is this node's business, not a broadcast.
 */
import { ago } from "@ateam/core";

export interface Refusal {
  /** ISO time of the refusal. */
  at: string;
  /** The rule that refused: what the server or the CLI named. */
  rule: string;
  /** The command as it was run, so it can be tried again after fixing it. */
  cmd: string;
  /** The action it identifies with, so a later success can cross it off: "task done t-113", "reading roles". */
  what: string;
}

/** What the record says right now. `clean` covers both "never refused" and "refused, then redone". */
export type RefusalState = { kind: "clean" } | { kind: "open"; refusal: Refusal } | { kind: "unreadable" };

export function readRefusal(raw: string | null): RefusalState {
  if (raw === null || !raw.trim()) return { kind: "clean" };
  let r: Partial<Refusal> | null = null;
  try { r = JSON.parse(raw) as Partial<Refusal>; } catch { r = null; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { kind: "unreadable" };
  const { at, rule, cmd, what } = r;
  if ([at, rule, cmd, what].some((x) => typeof x !== "string" || !x)) return { kind: "unreadable" };
  if (Number.isNaN(Date.parse(at as string))) return { kind: "unreadable" };
  return { kind: "open", refusal: { at: at as string, rule: rule as string, cmd: cmd as string, what: what as string } };
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

/** The one line, or null when there is nothing to say. Only `sync` and `board` carry it: they are what a turn starts with. */
export function refusalNotice(st: RefusalState, now: Date, clearWith = "ateam sync --clear-refused"): string | null {
  if (st.kind === "clean") return null;
  if (st.kind === "unreadable") return `⚠ 你上一次被拒的写入记坏了，说不出是哪一条。要划掉它：${clearWith}`;
  const { at, rule, cmd, what } = st.refusal;
  return `⚠ 你${howLong(now.getTime() - Date.parse(at))}有一次写入被拒（${rule}）：${what} 没有落下去。重做：${cmd}；确实不做了就划掉：${clearWith}`;
}
