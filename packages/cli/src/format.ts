import type { Event, Board, BoardTask } from "@ateam/core";

const hhmm = (iso: string) => iso.slice(11, 16);

export function event(e: Event, me: string): string {
  const t = hhmm(e.at);
  const who = e.actor.padEnd(9);
  switch (e.kind) {
    case "instruction": {
      const mark = e.to === me ? "  ⇐ FOR YOU, ack it: ateam ack " + e.id : "";
      const ask = e.options?.length ? `  options: ${e.options.join(" | ")}${e.default ? ` (default ${e.default})` : ""}` : "";
      return `${t} ${who} INSTRUCTION → ${e.to}: ${e.body}  [ack by ${hhmm(e.ack_by)}]${ask}${mark}`;
    }
    case "ack": return `${t} ${who} ack ${e.of}`;
    case "reading": return `${t} ${who} reading ${e.surface}:${e.key} = ${JSON.stringify(e.value)}${e.assumptions?.length ? `  assumes: ${e.assumptions.join("; ")}` : ""}`;
    case "note": return `${t} ${who} ${e.decision ? "DECISION" : "note"} ${e.body}${e.decides ? `  (chose "${e.decides.option}" for ${e.decides.of})` : ""}${e.supersedes ? `  (supersedes ${e.supersedes})` : ""}`;
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
      const ask = i.options?.length ? `  [${i.options.join(" | ")}${i.default ? `; default ${i.default}` : ""}]` : "";
      out.push(`  ${i.status.padEnd(9)} ${i.from} → ${i.to}: ${i.body}${ask}  (sent ${ago(i.sent)} ago${i.delivered ? `, delivered ${ago(i.delivered)} ago` : ", not yet pulled"})${you}  ${i.id}`);
    }
  }

  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) {
    out.push("", "DECIDED");
    for (const i of decided.slice(-5)) out.push(`  ${i.from} → ${i.to}: ${i.body}  ⇒ ${i.chosen!.option}  (${i.chosen!.by}, ${ago(i.chosen!.at)} ago)  ${i.id}`);
  }

  out.push("", "TASKS");
  for (const status of ["blocked", "working", "done", "failed", "open", "verified"]) {
    for (const t of b.tasks[status] ?? []) {
      const results = (t.surfaces ?? t.verified_on?.map((surface) => ({ surface, pass: true })) ?? []).map((r) => `${r.pass ? "✓" : "✗"} ${r.surface}`).join(" ");
      const extra = status === "blocked" ? ` ⏸ ${t.blocked_on}` : results ? `  ${results}` : "";
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

/** `ateam task show <id>`: everything the log knows about one task. */
export function task(t: BoardTask, seams: Board["seams"]): string {
  const out: string[] = [];
  // A server older than this CLI (pre t-003) sends tasks without these fields; show that rather than crash.
  const touches = t.touches ?? [];
  const verifications = t.verifications ?? [];
  out.push(`${t.id}  ${t.title}`);
  out.push(`status     ${t.status ?? "?"}${t.blocked_on ? `  ⏸ ${t.blocked_on}` : ""}`);
  out.push(`owner      ${t.owner ?? "—"}`);
  if (!t.criteria) out.push("criteria   (not reported by this server; read them with ateam log)");
  else {
    out.push(`criteria   (by ${t.criteria_by})`);
    if (!t.criteria.length) out.push("  (none)");
    t.criteria.forEach((c, i) => out.push(`  ${i + 1}. ${c}`));
  }
  out.push(`touches    ${touches.length ? touches.join(", ") : "—"}`);
  out.push(`evidence   ${t.evidence ?? "—"}`);
  out.push("verifications");
  if (!verifications.length) out.push("  (none)");
  for (const v of verifications) out.push(`  ${v.pass ? "✓ pass" : "✗ fail"}  ${v.surface}  by ${v.by} ${hhmm(v.at)}${v.evidence ? `: ${v.evidence}` : ""}`);
  const mine = seams.filter((s) => s.tasks.includes(t.id));
  out.push("seams");
  if (!mine.length) out.push("  (none)");
  for (const s of mine) {
    const other = s.tasks.find((x) => x !== t.id);
    out.push(`  ${s.resolved ? `resolved by ${s.resolved}` : "OPEN"}  with ${other}: ${s.overlap.join(", ")}`);
  }
  return out.join("\n");
}
