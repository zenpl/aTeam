/**
 * `ateam trace <task-id | sha>`: from a change that shipped back to what asked for it, who decided what, and who
 * judged it where. Pure over the raw log, so it is testable without a server and does not touch the board.
 */
import { SAID_PREFIX, movedTrace, type Event } from "@ateam/core";

const hhmm = (iso: string) => iso.slice(11, 16);
const SHA = /^[0-9a-f]{7,40}$/;

export function isSha(target: string): boolean { return SHA.test(target); }

/** Does a piece of evidence name this sha (either may be the short form of the other)? */
export function evidenceNames(evidence: string | undefined, sha: string): boolean {
  const words = (evidence ?? "").match(/[0-9a-f]{7,40}/g) ?? [];
  return words.some((w) => w.startsWith(sha) || sha.startsWith(w));
}

/** Task ids whose done evidence names the sha, in log order, without duplicates. */
export function tasksForSha(events: Event[], sha: string): string[] {
  const out: string[] = [];
  for (const e of events) if (e.kind === "task" && e.op === "done" && evidenceNames(e.evidence, sha) && !out.includes(e.task)) out.push(e.task);
  return out;
}

/** The story of one task, in time order, as lines. Null when the log has no such task. */
export function traceTask(events: Event[], id: string): string[] | null {
  const byId = new Map(events.map((e) => [e.id, e] as const));
  const create = events.find((e) => e.kind === "task" && e.op === "create" && e.task === id);
  if (!create || create.kind !== "task" || create.op !== "create") return null;

  const mine = new Set<string>();           // ids of this task's own events
  const rows: { at: string; id: string; lines: string[] }[] = [];
  const add = (e: Event, lines: string[]) => rows.push({ at: e.at, id: e.id, lines });
  const who = (e: Event) => `${hhmm(e.at)} ${e.actor.padEnd(9)}`;

  // what an event builds on: the human's sentence, a requirement, a decision, a reading
  const basis = (refs: string[] | undefined): string[] =>
    (refs ?? []).map((r) => {
      const e = byId.get(r);
      if (!e) return `  依据 → ${r}（不在日志里）`;
      if (e.kind === "note" && e.actor === "human" && e.body.startsWith(SAID_PREFIX)) return `  依据 → human 说：${e.body.slice(SAID_PREFIX.length).trim()}（${e.id}，${hhmm(e.at)}）`;
      if (e.kind === "note" && e.decision) return `  依据 → 决策（${e.actor}）：${e.body}（${e.id}，${hhmm(e.at)}）`;
      if (e.kind === "note") return `  依据 → note（${e.actor}）：${e.body}（${e.id}）`;
      if (e.kind === "reading") return `  依据 → 事实 ${e.surface}:${e.key} = ${JSON.stringify(e.value)}（${e.id}）`;
      if (e.kind === "instruction") return `  依据 → 指令（${e.actor} → ${e.to}）：${e.body}（${e.id}）`;
      return `  依据 → ${e.kind} ${e.id}`;
    });

  for (const e of events) {
    if (e.kind !== "task") continue;
    if (e.op === "seam") { if (e.tasks.includes(id)) { mine.add(e.id); add(e, [`${who(e)} 接缝 ${e.tasks.join(" + ")} 已解决：${e.resolution}`]); } continue; }
    if (e.task !== id) continue;
    mine.add(e.id);
    switch (e.op) {
      case "create": add(e, [`${who(e)} 创建任务：${e.title}`, ...e.criteria.map((c, i) => `  判据 ${i + 1}. ${c}`), ...basis(e.refs)]); break;
      case "claim": add(e, [`${who(e)} 认领；touches：${e.touches.join(", ")}`, ...basis(e.refs)]); break;
      case "done": add(e, [`${who(e)} 完成；证据：${e.evidence ?? "（无）"}`, ...basis(e.refs)]); break;
      case "verify": add(e, [`${who(e)} 验收 ${e.surface} ${e.pass ? "✓ 通过" : "✗ 未通过"}${e.evidence ? `：${e.evidence}` : ""}`]); break;
      case "block": add(e, [`${who(e)} 阻塞：${e.on}`]); break;
      case "unblock": add(e, [`${who(e)} 解除阻塞`]); break;
      case "reopen": add(e, [`${who(e)} 重开：${e.reason}`]); break;
      case "withdraw": add(e, [`${who(e)} 撤回：${e.reason}`]); break;
      // t-166：搬走的判据在回溯里也要看得见——只读判据不读 note 的人，正是靠这一行知道它不再属于这件。
      case "criteria": add(e, [e.moved
        // 记号加任务 id，不新造句子（冻结开着）；整句住在 core，这里不留人可见的字面量
        ? `${who(e)} ${movedTrace(e.moved.index, e.moved.to)}`
        : `${who(e)} 追加判据：${(e.add ?? []).map((c) => `「${c}」`).join(" ")}`]); break;
    }
  }

  // notes on the task, and decisions that build on it or on what it was built on (refs), plus their supersedes chains
  const basisIds = new Set(create.refs ?? []);
  const seeds = new Set([...mine, ...basisIds]);
  const related = new Set<string>();
  const decisions = events.filter((e): e is Event & { kind: "note" } => e.kind === "note" && !basisIds.has(e.id));
  const touches = (n: Event & { kind: "note" }) => n.task === id || (n.refs ?? []).some((r) => seeds.has(r)) || (n.decides && mine.has(n.decides.of));
  for (const n of decisions) if (touches(n)) related.add(n.id);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of decisions) {
      if (related.has(n.id)) continue;
      if ((n.supersedes && related.has(n.supersedes)) || [...related].some((r) => byId.get(r)?.kind === "note" && (byId.get(r) as Event & { kind: "note" }).supersedes === n.id)) { related.add(n.id); grew = true; }
    }
  }
  for (const n of decisions) {
    if (!related.has(n.id)) continue;
    const kind = n.decision ? "决策" : n.task === id ? "任务 note" : "note";
    add(n, [`${who(n)} ${kind}：${n.body}${n.supersedes ? `（取代 ${n.supersedes}）` : ""}`, ...basis((n.refs ?? []).filter((r) => !seeds.has(r)))]);
  }

  rows.sort((x, y) => x.id.localeCompare(y.id));
  return [`回溯 ${id}  ${create.title}`, ...rows.flatMap((r) => r.lines)];
}

/** What `ateam trace` prints. Null when nothing matches. */
export function trace(events: Event[], target: string): string[] | null {
  if (isSha(target)) {
    const ids = tasksForSha(events, target);
    if (!ids.length) return null;
    const out = [`sha ${target} 出现在 ${ids.length} 个任务的完成证据里：${ids.join("、")}`];
    for (const id of ids) out.push("", ...(traceTask(events, id) ?? []));
    return out;
  }
  return traceTask(events, target);
}
