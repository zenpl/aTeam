import { append, reduce, projectRoles, Rejected, VERIFIER_ROLES, FAIL_NOTICE, VERIFY_ASK, SERVICE_ACTOR, INSTRUCTION_MAX_CHARS, PROJECT_SURFACE, type Event, type NewEvent, type EventStore, type State } from "@ateam/core";

/** Reading key (surface project) naming where a task is judged when the human judges it; "repo" when unset. */
export const VERIFY_SURFACE_KEY = "verify.surface";
export const DEFAULT_VERIFY_SURFACE = "repo";
/** How long the owner has to ack a fail notice. */
export const FAIL_NOTICE_ACK_MS = 15 * 60_000;
/** How long the human has to answer a verify ask. */
export const VERIFY_ASK_ACK_MS = 24 * 3600_000;
const FAIL_REASON_CHARS = 60;
const ASK_EVIDENCE_CHARS = 200;

export function verifySurface(s: State): string {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${VERIFY_SURFACE_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : DEFAULT_VERIFY_SURFACE;
}

const head = (text: string, n: number) => { const cs = [...text.trim()]; return cs.length > n ? cs.slice(0, n).join("") + "…" : cs.join(""); };

/**
 * What the service says after an event landed (t-054, t-055). Pure: `state` already contains `e`.
 * - verify --fail: one notice to the owner per round, "改完重新 done"; none when the owner judged their own task.
 * - done in a project whose roles include no verifier: ask the human 过 / 不过, with the evidence and the surface.
 * - the human's choice on that ask: a verify by the human on that surface; 不过 then earns the owner a fail notice.
 */
export function followUps(s: State, e: Event, human: string, now: Date): NewEvent[] {
  if (e.kind === "task" && e.op === "verify" && !e.pass) {
    const t = s.tasks.get(e.task);
    if (!t?.owner || t.owner === e.actor) return [];
    const thisRound = new Set(t.verifications.filter((v) => v.round === t.round).map((v) => v.id));
    const already = [...s.instructions.values()].some((st) => st.instruction.actor === SERVICE_ACTOR && st.instruction.body.includes(FAIL_NOTICE) && thisRound.has(st.instruction.refs?.[0] ?? ""));
    if (already) return [];
    const reason = head(e.evidence ?? `${e.actor} 在 ${e.surface} 判不过，没给理由`, FAIL_REASON_CHARS);
    return [{ kind: "instruction", actor: SERVICE_ACTOR, to: t.owner, body: `${t.id}${FAIL_NOTICE}${reason}。改完重新 done。`, ack_by: new Date(now.getTime() + FAIL_NOTICE_ACK_MS).toISOString(), refs: [e.id] }];
  }
  if (e.kind === "task" && e.op === "done") {
    if (projectRoles(s).some((r) => VERIFIER_ROLES.includes(r))) return [];
    const t = s.tasks.get(e.task);
    if (!t || t.owner === human) return [];
    const surface = verifySurface(s);
    const tail = `判在 ${surface}。`;
    const lead = `${t.title}${VERIFY_ASK}`;
    const room = INSTRUCTION_MAX_CHARS - [...lead].length - [...tail].length - 4;
    const evidence = e.evidence?.trim() ? `证据：${head(e.evidence, Math.min(ASK_EVIDENCE_CHARS, room))}。` : "没给证据。";
    return [{ kind: "instruction", actor: SERVICE_ACTOR, to: human, intent: "ask", options: ["过", "不过"], body: `${lead}${evidence}${tail}`, ack_by: new Date(now.getTime() + VERIFY_ASK_ACK_MS).toISOString(), refs: [e.id] }];
  }
  if (e.kind === "note" && e.decides) {
    const st = s.instructions.get(e.decides.of);
    const i = st?.instruction;
    if (!i || i.actor !== SERVICE_ACTOR || !i.body.includes(VERIFY_ASK)) return [];
    if (st!.chosen?.note !== e.id) return []; // a second decision on the same ask changes nothing
    const ref = i.refs?.[0] ?? "";
    const t = [...s.tasks.values()].find((x) => x.history.some((h) => h.op === "done" && h.id === ref));
    const done = t?.history.find((h) => h.op === "done" && h.id === ref);
    if (!t || !done || done.round !== t.round) return []; // the owner did it again since: this ask is about an old round
    const pass = e.decides.option === "过";
    return [{ kind: "task", op: "verify", actor: e.actor, task: t.id, surface: verifySurface(s), pass, evidence: pass ? "human 在牌桌上确认" : "human 在牌桌上判不过", refs: [e.id] }];
  }
  return [];
}

/** Append `e`'s follow-ups, and theirs, until nothing follows. A rejected follow-up becomes a note saying why, not a crash. */
export async function runFollowUps(store: EventStore, e: Event, human: string, now: Date = new Date()): Promise<Event[]> {
  const out: Event[] = [];
  const queue: Event[] = [e];
  while (queue.length) {
    const x = queue.shift()!;
    const state = reduce(await store.read(), now);
    for (const ne of followUps(state, x, human, now)) {
      try {
        const appended = await append(store, ne, { human, now });
        out.push(appended);
        queue.push(appended);
      } catch (err) {
        if (!(err instanceof Rejected)) throw err;
        const task = ne.kind === "task" && ne.op === "verify" ? ne.task : undefined;
        out.push(await append(store, { kind: "note", actor: SERVICE_ACTOR, body: `human 判了，但 verify 被拒（${err.rule}）：${err.message}`, task, refs: [x.id] }, { human }));
      }
    }
  }
  return out;
}
