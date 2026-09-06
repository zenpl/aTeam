import type { Event, Board } from "@ateam/core";

const hhmm = (iso: string) => iso.slice(11, 16);

export function event(e: Event, me: string): string {
  const t = hhmm(e.at);
  const who = e.actor.padEnd(9);
  switch (e.kind) {
    case "instruction": {
      const mark = e.to === me ? "  ⇐ FOR YOU, ack it: ateam ack " + e.id : "";
      return `${t} ${who} INSTRUCTION → ${e.to}: ${e.body}  [ack by ${hhmm(e.ack_by)}]${mark}`;
    }
    case "ack": return `${t} ${who} ack ${e.of}`;
    case "reading": return `${t} ${who} reading ${e.surface}:${e.key} = ${JSON.stringify(e.value)}${e.assumptions?.length ? `  assumes: ${e.assumptions.join("; ")}` : ""}`;
    case "note": return `${t} ${who} ${e.decision ? "DECISION" : "note"} ${e.body}${e.supersedes ? `  (supersedes ${e.supersedes})` : ""}`;
    case "task":
      switch (e.op) {
        case "create": return `${t} ${who} task ${e.task} created: ${e.title}`;
        case "claim": return `${t} ${who} task ${e.task} claimed, touches ${e.touches.join(", ")}`;
        case "done": return `${t} ${who} task ${e.task} done${e.evidence ? `: ${e.evidence}` : ""}`;
        case "verify": return `${t} ${who} task ${e.task} ${e.pass ? "VERIFIED" : "FAILED"} on ${e.surface}${e.evidence ? `: ${e.evidence}` : ""}`;
        case "block": return `${t} ${who} task ${e.task} blocked on ${e.on}`;
        case "unblock": return `${t} ${who} task ${e.task} unblocked`;
        case "seam": return `${t} ${who} seam ${e.tasks.join("+")} resolved: ${e.resolution}`;
      }
  }
  return `${t} ${who} ${JSON.stringify(e)}`;
}

export function board(b: Board, me: string): string {
  const out: string[] = [];
  const now = Date.parse(b.now);
  const ago = (iso: string) => {
    const s = Math.round((now - Date.parse(iso)) / 1000);
    return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  };

  out.push(`FOCUS      ${b.focus ? `${JSON.stringify(b.focus.body)}  (${b.focus.set_by}, ${ago(b.focus.at)} ago)` : "—"}`);

  if (b.needs_human.length) {
    out.push("", "NEEDS HUMAN");
    for (const n of b.needs_human) out.push(`  [${n.kind}] ${n.summary}  (${n.id})`);
  }

  const open = b.instructions.filter((i) => i.status !== "acked");
  if (open.length) {
    out.push("", "OPEN INSTRUCTIONS");
    for (const i of open) {
      const you = i.to === me ? "  ⇐ YOU" : "";
      out.push(`  ${i.status.padEnd(9)} ${i.from} → ${i.to}: ${i.body}  (sent ${ago(i.sent)} ago${i.delivered ? `, delivered ${ago(i.delivered)} ago` : ", not yet pulled"})${you}  ${i.id}`);
    }
  }

  out.push("", "TASKS");
  for (const status of ["blocked", "working", "done", "failed", "open", "verified"]) {
    for (const t of b.tasks[status] ?? []) {
      const extra = status === "blocked" ? ` ⏸ ${t.blocked_on}` : status === "verified" ? ` ✓ ${t.verified_on?.join(",")}` : "";
      out.push(`  ${status.padEnd(9)} ${t.id.padEnd(14)} ${t.title}${t.owner ? `  @${t.owner}` : ""}${extra}`);
    }
  }

  const openSeams = b.seams.filter((s) => !s.resolved);
  if (openSeams.length) {
    out.push("", "OPEN SEAMS");
    for (const s of openSeams) out.push(`  ${s.tasks.join(" + ")} both touch ${s.overlap.join(", ")}`);
  }

  const valid = b.readings.filter((r) => r.valid);
  const stale = b.readings.filter((r) => !r.valid);
  out.push("", `READINGS (${valid.length} valid, ${stale.length} stale)`);
  for (const r of valid) out.push(`  ${r.surface}:${r.key} = ${JSON.stringify(r.value)}  (${r.by}, ${ago(r.at)} ago)${r.assumptions?.length ? `  assumes: ${r.assumptions.join("; ")}` : ""}`);
  for (const r of stale.slice(-5)) out.push(`  ✗ ${r.surface}:${r.key} = ${JSON.stringify(r.value)}  ${r.why}`);

  out.push("", "PRESENCE");
  for (const p of b.presence) out.push(`  ${p.actor.padEnd(10)} ${ago(p.last_seen)} ago`);

  return out.join("\n");
}
