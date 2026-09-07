import { DEPLOY_SOURCE, describeShape, ambiguousLabels, taskHeading, roleNamer, nameRoles, type Event, type Board, type BoardRelease, type BoardTask, SEAM_UNDECIDED, SEAM_SAME_FILE, alsoHere, nobodyElse, lightSeamLine, seamFiles } from "@ateam/core";

const hhmm = (iso: string) => iso.slice(11, 16);

export function event(e: Event, me: string): string {
  const t = hhmm(e.at);
  const who = e.actor.padEnd(9);
  switch (e.kind) {
    case "instruction": {
      // t-147: no ack nag. Reading it is already recorded (your cursor moved); what closes it is doing it, or one
      // line 「不办：<原因>」. Only a card with options still owes an answer.
      const mark = e.to === me ? (e.options?.length ? "  ⇐ FOR YOU, answer it: ateam decide " + e.id + " <option>" : "  ⇐ FOR YOU") : "";
      const ask = e.options?.length ? `  options: ${e.options.join(" | ")}${e.default ? ` (default ${e.default})` : ""}` : "";
      return `${t} ${who} INSTRUCTION → ${e.to}: ${e.body}  [ack by ${hhmm(e.ack_by)}]${ask}${mark}`;
    }
    case "ack": return `${t} ${who} ack ${e.of}`;
    case "untell": return `${t} ${who} UNTELL ${e.of}  已撤回：${e.reason}`;
    case "reading": return `${t} ${who} reading ${e.surface}:${e.key} = ${JSON.stringify(e.value)}${e.shape ? `  shape: ${describeShape(e.shape)}` : ""}${e.assumptions?.length ? `  assumes: ${e.assumptions.join("; ")}` : ""}`;
    case "note": return `${t} ${who} ${e.decision ? "DECISION" : "note"} ${e.task ? `[${e.task}] ` : ""}${e.body}${e.decides ? `  (chose "${e.decides.option}" for ${e.decides.of})` : ""}${e.supersedes ? `  (supersedes ${e.supersedes})` : ""}`;
    case "task":
      switch (e.op) {
        case "create": return `${t} ${who} task ${e.task} created: ${e.title}`;
        case "claim": return `${t} ${who} task ${e.task} claimed, touches ${e.touches.join(", ")}`;
        case "done": return `${t} ${who} task ${e.task} done${e.shows ? ` — ${e.shows}` : ""}${e.evidence ? `: ${e.evidence}` : ""}`;
        case "verify": return `${t} ${who} task ${e.task} ${e.pass ? "VERIFIED" : "FAILED"} on ${e.surface}${e.shows ? ` — ${e.shows}` : ""}${e.evidence ? `: ${e.evidence}` : ""}`;
        case "block": return `${t} ${who} task ${e.task} blocked on ${e.on}`;
        case "unblock": return `${t} ${who} task ${e.task} unblocked`;
        case "withdraw": return `${t} ${who} task ${e.task} WITHDRAWN: ${e.reason}`;
        case "obsolete": return `${t} ${who} task ${e.task} OBSOLETE, superseded by ${e.decision}${e.reason ? `: ${e.reason}` : ""}`;
        case "criteria": return `${t} ${who} task ${e.task} criteria added: ${e.add.join(" | ")}`;
        case "reopen": return `${t} ${who} task ${e.task} REOPENED: ${e.reason}`;
        case "seam": return `${t} ${who} seam ${e.tasks.join("+")} resolved: ${e.resolution}`;
      }
  }
  return `${t} ${who} ${JSON.stringify(e)}`;
}

/** " at a, b" when the board carries the overlap; nothing when the slim board dropped it (t-075). */
function at(overlap: string[] | undefined): string {
  return overlap?.length ? ` at ${overlap.join(", ")}` : "";
}

export function board(b: Board, me: string): string {
  const out: string[] = [];
  const who = roleNamer(b); // t-107: the CLI shows the same names the board does
  const now = Date.parse(b.now);
  const ago = (iso: string) => {
    const s = Math.round((now - Date.parse(iso)) / 1000);
    return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
  };

  out.push(`FOCUS      ${b.focus ? `${JSON.stringify(b.focus.body)}  (${who(b.focus.set_by)}, ${ago(b.focus.at)} ago)` : "—"}`);

  if (b.live) {
    // t-083: 推的 only when release --deploy wrote the reading, 核对 (no 的, pd 22:47) when someone measured it, nothing when
    // the source is unsaid; each with how long ago, so nobody has to guess whether it was just now or six hours back
    const when = b.live.at ? `${ago(b.live.at)}前` : "";
    // t-162：句子取 core 一处（页面用的是同一个），括号是命令行的版式、留在这里。
    const by = b.live.deployed_by ? ` (${DEPLOY_SOURCE.pushed(b.live.deployed_by, when)})`
      : b.live.checked_by ? ` (${DEPLOY_SOURCE.checked(b.live.checked_by, when)})` : "";
    const live = `LIVE       production ${b.live.deployed_sha ? `${b.live.deployed_sha.slice(0, 7)}${by}` : "sha unknown"}`;
    const recent = b.live.recent ?? b.live.verified_on_production;
    const earlier = b.live.earlier?.length ? ` (+${b.live.earlier.length} earlier)` : "";
    // t-126: whichever of the four states we are in, say it. Printing only 「形状不对」 left the one that matters most
    // silent: an address recorded and never once delivered to looked exactly like one that works.
    if (b.alert?.line) out.push(`           ${b.alert.line}`);
    // t-129: a packed batch that cannot go out says why, in core's words — the same sentence the page shows.
    for (const x of b.batches ?? []) if (x.line) out.push(`           ${x.name} ${x.sha.slice(0, 7)}：${x.line}`);
    // t-091: the same sentence the board shows, from the same counts (t-078); nothing when nothing waits
    const c = b.release?.counts;
    const waiting = !c ? "" : c.pending_deploy > 0 ? `${c.pending_deploy} 件验过了，等一次上线${c.unknown ? `；另有 ${c.unknown} 件不知道上没上` : ""}。`
      : c.unknown > 0 ? `不知道有多少件在等上线：${b.release.basis ?? ""}` : "";
    if (waiting) out.push(`           ${waiting}`);
    out.push(recent.length || earlier ? `${live} · verified there${b.live.since_sha ? ` since ${b.live.since_sha.slice(0, 7)}` : ""}: ${recent.map((t) => t.shows ? `${t.id} ${t.shows}` : t.id).join(", ") || "—"}${earlier}` : live);
  }

  if (b.needs_human.length) {
    out.push("", "NEEDS HUMAN");
    // t-107: the card says who is asking by the name people read, not the summary core built from the id
    // t-181：带默认的卡把「此刻真是什么状态」那一句也印出来。字来自 core（board 的 says_default），这里不写第二份。
    for (const n of b.needs_human) out.push(`  ${who(n.from)}: ${n.body}${n.options?.length ? `  [${n.options.join(" | ")}${n.default ? `; default ${n.default}` : ""}]` : ""}${n.says_default ? `  ${n.says_default.line}` : ""}  (${n.id})`);
  }

  if (b.undelivered?.length) {
    out.push("", "UNDELIVERED (sent 5+ minutes ago, never pulled)");
    for (const u of b.undelivered) out.push(`  ${who(u.to).padEnd(10)} ${u.count} 条还没送到，最早 ${ago(u.oldest_sent)} 前${u.listening ? "" : "  没读日志"}`);
  }

  // t-147: overdue is now one thing only — a card whose options nobody has answered past its time. Not acking is
  // not a debt any more, so it does not appear here; what is unread or read-and-untouched is the block below.
  if (b.overdue?.length) {
    out.push("", "UNANSWERED (past ack_by, options still open)");
    for (const o of b.overdue) out.push(`  ${who(o.to)} has not answered "${o.body}" from ${who(o.from)}  (${ago(o.ack_by)} past ack_by, ${o.instruction})`);
  }

  // t-139 + t-147: what nobody has acted on, split by whether the one who owes it is even there. The sentences are
  // core's (pd's words); printing them is all this does — a second wording here is how the page once promised an
  // address nobody had delivered to.
  const owed = b.overdue_by_presence;
  if (owed && Object.values(owed).some((g) => g.count)) {
    out.push("", "NOBODY HAS ACTED ON");
    for (const k of ["missing", "deaf", "listening"] as const) {
      const g = owed[k];
      if (g.count) out.push(`  ${g.roles.map(who).join(", ").padEnd(10)} ${g.line}`);
    }
  }

  const open = b.instructions.filter((i) => i.status !== "acked" && i.status !== "withdrawn");
  if (open.length) {
    out.push("", "OPEN INSTRUCTIONS");
    for (const i of open) {
      const you = i.to === me ? "  ⇐ YOU" : "";
      const ask = i.options?.length ? `  [${i.options.join(" | ")}${i.default ? `; default ${i.default}` : ""}]` : "";
      const defaulted = i.chosen?.by === "default" ? `  ⇒ ${i.chosen.option} by default at ack_by (human may still decide)` : "";
      // t-147: the column is how far it got, worked out from the recipient's own pulls and events, not from a
      // receipt. This board is read by agents, so the state keeps its id (REACH_WORDS holds pd's Chinese for the
      // page); `acted_by_event` is the event that proves the third, so a reader can go check rather than believe.
      const proof = i.acted_by_event ? `, acted in ${i.acted_by_event}` : "";
      // ?? i.status: the CLI talks to whatever server is deployed, and one from before t-147 sends no `reach`.
      out.push(`  ${(i.reach ?? i.status).padEnd(9)} ${who(i.from)} → ${who(i.to)}: ${i.body}${ask}${defaulted}  (sent ${ago(i.sent)} ago${i.delivered ? `, delivered ${ago(i.delivered)} ago` : ", not yet pulled"}${proof})${you}  ${i.id}`);
    }
  }

  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) {
    out.push("", "DECIDED");
    for (const i of decided.slice(-5)) out.push(`  ${who(i.from)} → ${who(i.to)}: ${i.body}  ⇒ ${i.chosen!.option}  (${who(i.chosen!.by)}, ${ago(i.chosen!.at)} ago)  ${i.id}`);
  }

  out.push("", "TASKS");
  const ambiguous = ambiguousLabels(b); // t-100: the same judgment the board uses
  for (const status of ["blocked", "working", "done", "failed", "open", "verified", "withdrawn", "obsolete"]) {
    for (const t of b.tasks[status] ?? []) {
      const results = (t.surfaces ?? t.verified_on?.map((surface) => ({ surface, pass: true })) ?? []).map((r) => `${r.pass ? "✓" : "✗"} ${r.surface}`).join(" ");
      const overturned = (t.overturned ?? []).map((o) => `${o.surface} 验过，后被 ${o.by} 推翻`).join("；");
      const extra = status === "blocked" ? ` ⏸ ${t.blocked_on}` : status === "withdrawn" ? `  ✗ ${t.withdrawn?.reason ?? ""}` : status === "obsolete" ? `  已被 ${t.obsolete?.decision ?? "?"} 取代` : results ? `  ${results}${overturned ? `（${overturned}）` : ""}` : "";
      out.push(`  ${status.padEnd(9)} ${t.id.padEnd(14)} ${taskHeading(t, ambiguous)}${t.owner ? `  @${who(t.owner)}` : ""}${extra}`);
    }
  }

  // t-149 判据 3：闸的实话在挖层，不在首屏，也不是一张卡。它只在完整板上有；瘦身板里没有它。
  for (const g of b.gate_honesty ?? []) out.push("", `GATE ${g.gate}`, `  ${g.line}`);

  const openSeams = b.seams.filter((s) => s.open ?? (!s.resolved && !s.stacked));
  if (openSeams.length) {
    out.push("", `SEAMS (open: nobody owns these; they block verify) · ${SEAM_UNDECIDED}`);
    for (const s of openSeams) out.push(`  ${s.tasks.join(" + ")} both touch ${(s.overlap ?? []).join(", ")}`);
  }
  // t-114 (pm 01:20/01:21): the same sentence the board says, in the same place — right after 等人裁决. A light seam
  // is a heads-up for whoever merges second: it enters no count and no alert line, here or there.
  const lightSeams = b.seams.filter((s) => s.light);
  if (lightSeams.length) {
    out.push("", SEAM_SAME_FILE);
    for (const s of lightSeams) out.push(`  ${lightSeamLine(s.tasks[0], s.tasks[1], seamFiles(s.overlap).join("、"))}`);
  }
  const absorbed = b.seams.filter((s) => s.absorbed && !s.light);
  const stacked = b.seams.filter((s) => !s.resolved && s.stacked && !s.absorbed);
  const sameOwner = b.seams.filter((s) => !s.resolved && !s.stacked && s.same_owner);
  if (stacked.length || sameOwner.length || absorbed.length) {
    out.push("", "STACKED (informational, blocks nothing)");
    // The slim board (t-070) carries these seams without their overlap: say nothing about it rather than "at :" (t-075).
    for (const s of absorbed) out.push(`  ${s.absorbed!.later} absorbed ${s.absorbed!.earlier}: ${s.absorbed!.basis}${s.absorbed!.by ? `  (recorded by ${s.absorbed!.by}'s CLI)` : ""}`);
    for (const s of stacked) out.push(`  ${s.stacked!.on} stacks on ${s.stacked!.done} (done first)${at(s.overlap)}: merge ${s.stacked!.done} first`);
    for (const s of sameOwner) out.push(`  ${s.tasks.join(" + ")} same owner${at(s.overlap)}: sequential work, land them in order`);
  }

  const valid = b.readings.filter((r) => r.valid);
  const stale = b.readings.filter((r) => !r.valid);
  out.push("", `READINGS (${valid.length} valid, ${stale.length} stale)`);
  for (const r of valid) {
    const when = r.recorded_after_s ? `测于 ${ago(r.measured_at)} 前，记于 ${ago(r.at)} 前${r.late ? "，记录晚了 ⚠" : ""}` : `${ago(r.at)} ago`;
    // t-154: 结构化的事实先说那一句话（core 声明的，或退化来的），值仍然印给 agent 看——人那一侧只有这一句。
    if (r.said) out.push(`  ${r.said.line}${r.said.said_elsewhere ? "（牌桌别处已说过）" : ""}`);
    out.push(`  ${r.surface}:${r.key} = ${JSON.stringify(r.value)}  (${who(r.by)}, ${when})${r.assumptions?.length ? `  assumes: ${r.assumptions.join("; ")}` : ""}`);
  }
  for (const r of stale.slice(-5)) out.push(`  ✗ ${r.surface}:${r.key} = ${JSON.stringify(r.value)}  ${r.why}`);

  out.push("", "PRESENCE");
  for (const p of b.presence) {
    const name = who(p.actor);
    const st = p.status ?? (p.present === false ? "missing" : "listening");
    // t-140 · pd 05:42: say what the server can see — when this role last read the log — not whether it is listening,
    // which we do not observe. A node's own watch dying is its own business and its own terminal (t-102).
    const label = st === "listening" ? `在读  ${ago(p.last_seen!)} 前`
      : st === "deaf" ? `${p.last_pull ? `${ago(p.last_pull)} 没读日志` : "从未读过日志"}（${ago(p.last_event!)} 前还说过话）`
      : `缺人  ${p.last_seen ? `${ago(p.last_seen)}` : "从未出现"}`;
    out.push(`  ${name.padEnd(10)} ${label}${p.push && p.push !== "none" ? `  可推 ${p.push}` : ""}`);
  }
  const gaps = (b.coverage ?? []).filter((c) => c.status !== "held");
  if (gaps.length) {
    out.push("", "COVERAGE (responsibilities nobody holds right now)");
    for (const c of gaps) out.push(`  ${c.responsibility.padEnd(4)} ${nameRoles(c.line, who, b.roles ?? [])}`);
  }
  if (b.allocation?.warnings?.length) {
    out.push("", `TEAM  ${nameRoles(b.allocation.summary, who, b.roles ?? [])}`);
    for (const w of b.allocation.warnings) out.push(`  ${w.pattern}  ${nameRoles(w.hint, who, b.roles ?? [])}`);
  }

  return out.join("\n");
}

/** `ateam task show <id>`: everything the log knows about one task. */
/** `omitted` is required (t-077, qa 22:19): every caller says what its board left out; a full task or full board passes []. */
export function task(t: BoardTask, seams: Board["seams"], omitted: string[], who: (id: string) => string = (x) => x): string {
  const out: string[] = [];
  // A server older than this CLI (pre t-003) sends tasks without these fields; show that rather than crash.
  const touches = t.touches ?? [];
  const verifications = t.verifications ?? [];
  out.push(`${t.id}  ${t.title}`);
  out.push(`status     ${t.status ?? "?"}${t.blocked_on ? `  ⏸ ${t.blocked_on}` : ""}${t.withdrawn ? `  ✗ withdrawn by ${t.withdrawn.by} ${hhmm(t.withdrawn.at)}: ${t.withdrawn.reason}` : ""}${t.obsolete ? `  已被 ${t.obsolete.decision} 取代（${t.obsolete.by} ${hhmm(t.obsolete.at)}${t.obsolete.reason ? `：${t.obsolete.reason}` : ""}）` : ""}`);
  out.push(`owner      ${t.owner ? who(t.owner) : "—"}`);
  // The default board (t-070) leaves fields out and says which in board.omitted (t-077): an absent field is "not sent",
  // never "empty". A server older than this CLI sends neither the fields nor the list.
  // Paths follow the board's real shape (t-077 round 2): tasks.<status>[].<field>, seams[].overlap, seams[<n> of <m>].
  const left = (field: string) => omitted.some((p) => p === `tasks.${t.status}[].${field}` || p === `tasks[].${field}`);
  const seamsCut = omitted.some((p) => /^seams\[\d+ of \d+\]$/.test(p));
  if (left("criteria")) out.push(`criteria   (not in the default board; ateam task show ${t.id} has them)`);
  else if (!t.criteria) out.push("criteria   (not reported by this server; read them with ateam log)");
  else {
    out.push(`criteria   (by ${t.criteria_by ? who(t.criteria_by) : "—"})`);
    if (!t.criteria.length) out.push("  (none)");
    t.criteria.forEach((c, i) => {
      const added = t.criteria_added?.find((a) => a.index === i);
      out.push(`  ${i + 1}. ${c}${added ? `  (added by ${who(added.by)} ${hhmm(added.at)})` : ""}`);
    });
  }
  out.push(`touches    ${left("touches") ? `(not in the default board; ateam task show ${t.id} has them)` : touches.length ? touches.join(", ") : "—"}`);
  if (t.shows) out.push(`shows      ${t.shows}`);
  if (left("evidence")) out.push(`evidence   ${t.evidence_sha ? `sha ${t.evidence_sha.slice(0, 7)}; ` : ""}(not in the default board; ateam task show ${t.id} has it)`);
  else out.push(`evidence   ${t.evidence ?? "—"}`);
  const notes = t.notes ?? [];
  for (const n of notes.filter(isEvidenceUpdate)) out.push(`  + ${n.body.replace(EVIDENCE_PREFIX, "").trim()}  (${who(n.actor)} ${hhmm(n.at)})`);
  for (const o of t.overturned ?? []) out.push(`overturned ${o.surface} 验过（${o.passed_by}），后被 ${o.by} 推翻 ${hhmm(o.at)}${o.evidence ? `：${o.evidence}` : ""}`);
  out.push("verifications");
  if (left("verifications")) out.push(`  ${(t.surfaces ?? []).map((r) => `${r.pass ? "✓" : "✗"} ${r.surface}`).join("  ") || "(none)"}`);
  else if (!verifications.length) out.push("  (none)");
  for (const v of verifications) out.push(`  ${v.pass ? "✓ pass" : "✗ fail"}  ${v.surface}  by ${who(v.by)} ${hhmm(v.at)}${v.evidence ? `: ${v.evidence}` : ""}`);
  if (t.history?.length) {
    out.push("history");
    for (const h of t.history) {
      const line = h.op === "done" ? `done${h.evidence ? `: ${h.evidence}` : ""}`
        : h.op === "verify" ? `${h.pass ? "✓ pass" : "✗ fail"} ${h.surface}${h.evidence ? `: ${h.evidence}` : ""}`
        : `reopened: ${h.reason}`;
      out.push(`  r${h.round} ${hhmm(h.at)} ${who(h.by)}  ${line}`);
    }
  }
  const mine = seams.filter((s) => s.tasks.includes(t.id) && !s.light);
  const lightMine = seams.filter((s) => s.tasks.includes(t.id) && s.light);
  out.push("seams");
  // The default board keeps only the seams still in play (t-070): an empty list there is not "no seams" (t-075 round 2).
  if (!mine.length && !lightMine.length) out.push(seamsCut ? `  (not in the default board; ateam task show ${t.id} has them)` : "  (none)");
  for (const s of mine) {
    const other = s.tasks.find((x) => x !== t.id);
    const state = s.absorbed ? `absorbed: ${s.absorbed.basis}` : s.resolved ? `resolved by ${s.resolved}` : s.stacked ? `stacked (${s.stacked.on} on ${s.stacked.done}, blocks nothing)` : s.same_owner ? "same owner (blocks nothing)" : "OPEN";
    out.push(`  ${state}  with ${other}${s.overlap?.length ? `: ${s.overlap.join(", ")}` : ""}`);
  }
  if (seamsCut && mine.length) out.push(`  (the default board lists only seams still in play; ateam task show ${t.id} has all of them)`);
  if (lightMine.length) {
    out.push(SEAM_SAME_FILE);
    for (const s of lightMine) out.push(`  ${lightSeamLine(s.tasks[0], s.tasks[1], seamFiles(s.overlap).join("、"))}`);
  }
  out.push("notes");
  if (left("notes")) out.push(`  (not in the default board; ateam task show ${t.id} has them)`);
  else if (!notes.length) out.push("  (none)");
  for (const n of notes) out.push(`  ${hhmm(n.at)} ${who(n.actor).padEnd(9)} ${n.decision ? "DECISION " : ""}${n.body}`);
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
  const counts = r.counts ?? { pending_deploy: 0, deployed_unverified: 0, unknown: (r.candidates ?? []).length };
  out.push(`  未上线 ${counts.pending_deploy} 件 · 已上线未在生产验 ${counts.deployed_unverified} 件 · 无法判定 ${counts.unknown} 件${r.basis ? `  （${r.basis}）` : ""}`);
  if (!r.candidates) { out.push("  （默认板省略了清单：用 ateam release 或 board --full）"); return out.join("\n"); }
  if (!r.candidates.length) { out.push("  没有待上线的任务：仓库验过的都已在生产验过。"); return out.join("\n"); }
  const row = (c: BoardRelease) => {
    const who = Object.entries(c.verified_by).map(([surface, by]) => `${surface}：${by}`).join("，");
    return `  ${c.task.padEnd(9)} ${(c.evidence_sha ? c.evidence_sha.slice(0, 7) : "（证据无 sha）").padEnd(10)} ${who.padEnd(28)} ${c.title}`;
  };
  const group = (label: string, xs: BoardRelease[] | undefined) => {
    if (!xs?.length) return;
    out.push("", `${label}（${xs.length}）`, `  任务      证据 sha   验收（表面：谁）              标题`);
    for (const c of xs) out.push(row(c));
  };
  group("未上线：代码不在生产里", r.pending_deploy);
  group("已上线未验：代码在生产上跑着，没人在 production 表面验过", r.deployed_unverified);
  if (r.unknown?.length) {
    out.push("", `无法判定（${r.unknown.length}）`, `  任务      证据 sha   原因`);
    for (const c of r.unknown) out.push(`  ${c.task.padEnd(9)} ${(c.evidence_sha ? c.evidence_sha.slice(0, 7) : "（证据无 sha）").padEnd(10)} ${c.reason}`);
  }
  out.push("", `  共 ${r.candidates.length} 项，各组内按 done 先后排序。`);
  return out.join("\n");
}
