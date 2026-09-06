import { describeShape, type Event, type Board, type BoardTask } from "@ateam/core";

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
    case "reading": return `${t} ${who} reading ${e.surface}:${e.key} = ${JSON.stringify(e.value)}${e.shape ? `  shape: ${describeShape(e.shape)}` : ""}${e.assumptions?.length ? `  assumes: ${e.assumptions.join("; ")}` : ""}`;
    case "note": return `${t} ${who} ${e.decision ? "DECISION" : "note"} ${e.task ? `[${e.task}] ` : ""}${e.body}${e.decides ? `  (chose "${e.decides.option}" for ${e.decides.of})` : ""}${e.supersedes ? `  (supersedes ${e.supersedes})` : ""}`;
    case "task":
      switch (e.op) {
        case "create": return `${t} ${who} task ${e.task} created: ${e.title}`;
        case "claim": return `${t} ${who} task ${e.task} claimed, touches ${e.touches.join(", ")}`;
        case "done": return `${t} ${who} task ${e.task} done${e.evidence ? `: ${e.evidence}` : ""}`;
        case "verify": return `${t} ${who} task ${e.task} ${e.pass ? "VERIFIED" : "FAILED"} on ${e.surface}${e.evidence ? `: ${e.evidence}` : ""}`;
        case "block": return `${t} ${who} task ${e.task} blocked on ${e.on}`;
        case "unblock": return `${t} ${who} task ${e.task} unblocked`;
        case "withdraw": return `${t} ${who} task ${e.task} WITHDRAWN: ${e.reason}`;
        case "criteria": return `${t} ${who} task ${e.task} criteria added: ${e.add.join(" | ")}`;
        case "reopen": return `${t} ${who} task ${e.task} REOPENED: ${e.reason}`;
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

  if (b.live) {
    const live = `LIVE       production ${b.live.deployed_sha ? b.live.deployed_sha.slice(0, 7) : "sha unknown"}`;
    const recent = b.live.recent ?? b.live.verified_on_production;
    const earlier = b.live.earlier?.length ? ` (+${b.live.earlier.length} earlier)` : "";
    out.push(recent.length || earlier ? `${live} · verified there${b.live.since_sha ? ` since ${b.live.since_sha.slice(0, 7)}` : ""}: ${recent.map((t) => t.id).join(", ") || "—"}${earlier}` : live);
  }

  if (b.needs_human.length) {
    out.push("", "NEEDS HUMAN");
    for (const n of b.needs_human) out.push(`  ${n.summary}  (${n.id})`);
  }

  if (b.undelivered?.length) {
    out.push("", "UNDELIVERED (sent 5+ minutes ago, never pulled)");
    for (const u of b.undelivered) out.push(`  ${u.to.padEnd(10)} ${u.count} 条没送到，最早 ${ago(u.oldest_sent)} 前${u.listening ? "" : "  没在听"}`);
  }

  if (b.overdue?.length) {
    out.push("", "OVERDUE");
    for (const o of b.overdue) out.push(`  ${o.to} has not acked "${o.body}" from ${o.from}  (${ago(o.ack_by)} past ack_by, ${o.instruction})`);
  }

  const open = b.instructions.filter((i) => i.status !== "acked");
  if (open.length) {
    out.push("", "OPEN INSTRUCTIONS");
    for (const i of open) {
      const you = i.to === me ? "  ⇐ YOU" : "";
      const ask = i.options?.length ? `  [${i.options.join(" | ")}${i.default ? `; default ${i.default}` : ""}]` : "";
      const defaulted = i.chosen?.by === "default" ? `  ⇒ ${i.chosen.option} by default at ack_by (human may still decide)` : "";
      out.push(`  ${i.status.padEnd(9)} ${i.from} → ${i.to}: ${i.body}${ask}${defaulted}  (sent ${ago(i.sent)} ago${i.delivered ? `, delivered ${ago(i.delivered)} ago` : ", not yet pulled"})${you}  ${i.id}`);
    }
  }

  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) {
    out.push("", "DECIDED");
    for (const i of decided.slice(-5)) out.push(`  ${i.from} → ${i.to}: ${i.body}  ⇒ ${i.chosen!.option}  (${i.chosen!.by}, ${ago(i.chosen!.at)} ago)  ${i.id}`);
  }

  out.push("", "TASKS");
  for (const status of ["blocked", "working", "done", "failed", "open", "verified", "withdrawn"]) {
    for (const t of b.tasks[status] ?? []) {
      const results = (t.surfaces ?? t.verified_on?.map((surface) => ({ surface, pass: true })) ?? []).map((r) => `${r.pass ? "✓" : "✗"} ${r.surface}`).join(" ");
      const extra = status === "blocked" ? ` ⏸ ${t.blocked_on}` : status === "withdrawn" ? `  ✗ ${t.withdrawn?.reason ?? ""}` : results ? `  ${results}` : "";
      out.push(`  ${status.padEnd(9)} ${t.id.padEnd(14)} ${t.title}${t.owner ? `  @${t.owner}` : ""}${extra}`);
    }
  }

  const openSeams = b.seams.filter((s) => s.open ?? (!s.resolved && !s.stacked));
  if (openSeams.length) {
    out.push("", "SEAMS (open: nobody owns these; they block verify)");
    for (const s of openSeams) out.push(`  ${s.tasks.join(" + ")} both touch ${s.overlap.join(", ")}`);
  }
  const stacked = b.seams.filter((s) => !s.resolved && s.stacked);
  const sameOwner = b.seams.filter((s) => !s.resolved && !s.stacked && s.same_owner);
  if (stacked.length || sameOwner.length) {
    out.push("", "STACKED (informational, blocks nothing)");
    for (const s of stacked) out.push(`  ${s.stacked!.on} stacks on ${s.stacked!.done} (done first) at ${s.overlap.join(", ")}: merge ${s.stacked!.done} first`);
    for (const s of sameOwner) out.push(`  ${s.tasks.join(" + ")} same owner at ${s.overlap.join(", ")}: sequential work, land them in order`);
  }

  const valid = b.readings.filter((r) => r.valid);
  const stale = b.readings.filter((r) => !r.valid);
  out.push("", `READINGS (${valid.length} valid, ${stale.length} stale)`);
  for (const r of valid) out.push(`  ${r.surface}:${r.key} = ${JSON.stringify(r.value)}  (${r.by}, ${ago(r.at)} ago)${r.assumptions?.length ? `  assumes: ${r.assumptions.join("; ")}` : ""}`);
  for (const r of stale.slice(-5)) out.push(`  ✗ ${r.surface}:${r.key} = ${JSON.stringify(r.value)}  ${r.why}`);

  out.push("", "PRESENCE");
  for (const p of b.presence) {
    const st = p.status ?? (p.present === false ? "missing" : "listening");
    const label = st === "listening" ? `在听  ${ago(p.last_seen!)} 前`
      : st === "deaf" ? `没在听 ${p.last_pull ? `${ago(p.last_pull)}` : "从未拉取"}（${ago(p.last_event!)} 前还说过话）`
      : `缺人  ${p.last_seen ? `${ago(p.last_seen)}` : "从未出现"}`;
    out.push(`  ${p.actor.padEnd(10)} ${label}`);
  }

  return out.join("\n");
}

/** `ateam task show <id>`: everything the log knows about one task. */
export function task(t: BoardTask, seams: Board["seams"]): string {
  const out: string[] = [];
  // A server older than this CLI (pre t-003) sends tasks without these fields; show that rather than crash.
  const touches = t.touches ?? [];
  const verifications = t.verifications ?? [];
  out.push(`${t.id}  ${t.title}`);
  out.push(`status     ${t.status ?? "?"}${t.blocked_on ? `  ⏸ ${t.blocked_on}` : ""}${t.withdrawn ? `  ✗ withdrawn by ${t.withdrawn.by} ${hhmm(t.withdrawn.at)}: ${t.withdrawn.reason}` : ""}`);
  out.push(`owner      ${t.owner ?? "—"}`);
  if (!t.criteria) out.push("criteria   (not reported by this server; read them with ateam log)");
  else {
    out.push(`criteria   (by ${t.criteria_by})`);
    if (!t.criteria.length) out.push("  (none)");
    t.criteria.forEach((c, i) => {
      const added = t.criteria_added?.find((a) => a.index === i);
      out.push(`  ${i + 1}. ${c}${added ? `  (added by ${added.by} ${hhmm(added.at)})` : ""}`);
    });
  }
  out.push(`touches    ${touches.length ? touches.join(", ") : "—"}`);
  out.push(`evidence   ${t.evidence ?? "—"}`);
  const notes = t.notes ?? [];
  for (const n of notes.filter(isEvidenceUpdate)) out.push(`  + ${n.body.replace(EVIDENCE_PREFIX, "").trim()}  (${n.actor} ${hhmm(n.at)})`);
  out.push("verifications");
  if (!verifications.length) out.push("  (none)");
  for (const v of verifications) out.push(`  ${v.pass ? "✓ pass" : "✗ fail"}  ${v.surface}  by ${v.by} ${hhmm(v.at)}${v.evidence ? `: ${v.evidence}` : ""}`);
  if (t.history?.length) {
    out.push("history");
    for (const h of t.history) {
      const line = h.op === "done" ? `done${h.evidence ? `: ${h.evidence}` : ""}`
        : h.op === "verify" ? `${h.pass ? "✓ pass" : "✗ fail"} ${h.surface}${h.evidence ? `: ${h.evidence}` : ""}`
        : `reopened: ${h.reason}`;
      out.push(`  r${h.round} ${hhmm(h.at)} ${h.by}  ${line}`);
    }
  }
  const mine = seams.filter((s) => s.tasks.includes(t.id));
  out.push("seams");
  if (!mine.length) out.push("  (none)");
  for (const s of mine) {
    const other = s.tasks.find((x) => x !== t.id);
    const state = s.resolved ? `resolved by ${s.resolved}` : s.stacked ? `stacked (${s.stacked.on} on ${s.stacked.done}, blocks nothing)` : s.same_owner ? "same owner (blocks nothing)" : "OPEN";
    out.push(`  ${state}  with ${other}: ${s.overlap.join(", ")}`);
  }
  out.push("notes");
  if (!notes.length) out.push("  (none)");
  for (const n of notes) out.push(`  ${hhmm(n.at)} ${n.actor.padEnd(9)} ${n.decision ? "DECISION " : ""}${n.body}`);
  return out.join("\n");
}

const EVIDENCE_PREFIX = /^evidence:/i;
/** A note attached to a task whose body starts "evidence:" is an evidence update (done cannot be re-emitted). */
export function isEvidenceUpdate(n: { body: string }): boolean {
  return EVIDENCE_PREFIX.test(n.body.trimStart());
}

/** Echo of a task just created, so the author can check what the team will read. */
export function created(title: string, criteria: string[]): string {
  return [`  title: ${title}`, ...criteria.map((c, i) => `  ${i + 1}. ${c}`)].join("\n");
}

/** `ateam release`: what is verified on repo and not yet on production, for the deploy instruction to the human. */
export function release(b: Board): string {
  const r = b.release ?? { deployed_sha: b.live?.deployed_sha ?? null, candidates: [] };
  const out: string[] = [];
  out.push(`待上线清单  生产当前 sha：${r.deployed_sha ? r.deployed_sha.slice(0, 7) : "未知（没有有效的 production:deployed.sha 事实）"}`);
  if (!r.candidates.length) { out.push("  没有待上线的任务：仓库验过的都已在生产验过。"); return out.join("\n"); }
  out.push(`  任务      证据 sha   验收（表面：谁）              标题`);
  for (const c of r.candidates) {
    const who = Object.entries(c.verified_by).map(([surface, by]) => `${surface}：${by}`).join("，");
    out.push(`  ${c.task.padEnd(9)} ${(c.evidence_sha ? c.evidence_sha.slice(0, 7) : "（证据无 sha）").padEnd(10)} ${who.padEnd(28)} ${c.title}`);
  }
  out.push(`  共 ${r.candidates.length} 项，按 done 先后排序。`);
  return out.join("\n");
}
