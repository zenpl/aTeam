/**
 * t-050: when every node has stopped listening, or the human is very late, nobody inside the sessions can notice.
 * The service calls out over a channel the project declared (fact project:alert.webhook). Pure decision + a runner
 * with injected fetch/clock, so it is testable and runs whether or not any node is online.
 */
import { append, reduce, projectRoles, isMissing, type EventStore, type State, ALERT_WEBHOOK_KEY, PROJECT_SURFACE, ALL_MISSING_AFTER_MS, HUMAN_OVERDUE_AFTER_MS, ALERT_COOLDOWN_MS, LISTEN_WINDOW_MS, SERVICE_ACTOR } from "@ateam/core";

export type AlertKind = "all_missing" | "human_overdue";
export interface Alert { kind: AlertKind; since: string; detail: string; summary: string }
export interface AlertPayload extends Alert { project: string; board_url: string }

const NOTE_PREFIX = "外呼：";

/** The declared call-out address, when its fact is valid. */
export function webhookOf(s: State): string | null {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ALERT_WEBHOOK_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  return typeof v === "string" && /^https:\/\//.test(v) ? v : null;
}

/** Situations that warrant a call-out right now, with the moment each began. */
export function situations(s: State, human: string, now: Date): Alert[] {
  const out: Alert[] = [];
  const roles = projectRoles(s);
  if (roles.every((r) => isMissing(s, r, now))) {
    // the team went silent when the last listener's window closed; a team that never pulled: since its first event
    const pulls = roles.map((r) => s.presence.get(r)?.last_pull).filter((x): x is string => !!x).sort();
    const firstEvent = [...s.ids].sort()[0];
    const base = pulls.length ? Date.parse(pulls[pulls.length - 1]) + LISTEN_WINDOW_MS : firstEvent ? ulidTime(firstEvent) : now.getTime();
    if (now.getTime() - base >= ALL_MISSING_AFTER_MS) {
      const since = new Date(base).toISOString();
      const minutes = Math.round((now.getTime() - base) / 60_000);
      out.push({ kind: "all_missing", since, detail: `角色 ${roles.join("、")} 都已 ${minutes} 分钟没有拉取`, summary: `全队失联 ${minutes} 分钟：${roles.join("、")} 都没有在听。请起一个节点。` });
    }
  }
  const late = [...s.instructions.values()].filter((st) => st.instruction.to === human && !st.acked_at && !st.chosen && now.getTime() - Date.parse(st.instruction.ack_by) >= HUMAN_OVERDUE_AFTER_MS)
    .sort((a, b) => a.instruction.ack_by.localeCompare(b.instruction.ack_by));
  if (late.length) {
    const oldest = late[0].instruction;
    const since = new Date(Date.parse(oldest.ack_by) + HUMAN_OVERDUE_AFTER_MS).toISOString();
    const minutes = Math.round((now.getTime() - Date.parse(oldest.ack_by)) / 60_000);
    out.push({ kind: "human_overdue", since, detail: late.map((st) => `${st.instruction.id}：${st.instruction.body}`).join("\n"), summary: `有 ${late.length} 条给你的事等了 ${minutes} 分钟没人答。最早的：${oldest.body}` });
  }
  return out;
}

/** The last successful call-out note for a situation, as (since, at). A failed one leaves a note but no cooldown: next tick retries. */
function lastCallout(s: State, kind: AlertKind): { since: string; at: string } | undefined {
  const notes = s.notes.filter((n) => n.actor === SERVICE_ACTOR && n.body.startsWith(`${NOTE_PREFIX}${kind} `) && n.body.includes(" 已发到 "));
  const n = notes[notes.length - 1];
  const since = n && /自 (\S+)/.exec(n.body)?.[1];
  return n && since ? { since, at: n.at } : undefined;
}

/** Due = a situation with no call-out for the same episode within the cooldown. A new episode (different since) is due at once. */
export function due(s: State, human: string, now: Date): Alert[] {
  return situations(s, human, now).filter((a) => {
    const last = lastCallout(s, a.kind);
    if (!last) return true;
    if (last.since !== a.since) return true;
    return now.getTime() - Date.parse(last.at) >= ALERT_COOLDOWN_MS;
  });
}

export interface AlerterDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
  now?: () => Date;
  /** The clock that stamps the note (t-063: a test offset moves `now`, never what is written). Default the real one. */
  real?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  human: string;
  boardUrl: (project: string) => string;
}

/** One pass over one project: call out what is due, and leave a note either way. Returns what was sent. */
export async function runAlerts(project: string, store: EventStore, deps: AlerterDeps): Promise<AlertPayload[]> {
  const now = deps.now?.() ?? new Date();
  const state = reduce(await store.read(), now);
  const url = webhookOf(state);
  if (!url) return [];
  const sent: AlertPayload[] = [];
  for (const a of due(state, deps.human, now)) {
    const payload: AlertPayload = { ...a, project, board_url: deps.boardUrl(project) };
    let ok = false, status = 0;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const r = await deps.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        ok = r.ok; status = r.status;
      } catch { status = 0; }
      if (!ok && attempt < 3) await (deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(1000 * attempt);
    }
    await append(store, {
      kind: "note", actor: SERVICE_ACTOR,
      body: `${NOTE_PREFIX}${a.kind} 自 ${a.since} ${ok ? "已发到" : `发送失败（三次，最后状态 ${status}）`} ${url}。${a.summary}`,
    }, { human: deps.human, now: deps.real?.() ?? deps.now?.() }); // stamped with the real clock (t-063): a test offset never writes a time
    if (ok) sent.push(payload);
  }
  return sent;
}

function ulidTime(id: string): number {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + alphabet.indexOf(ch);
  return t;
}
