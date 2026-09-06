import type { Board, BoardSaid, State } from "@ateam/core";
import { UI } from "./i18n.js";

/**
 * The human's page. Above the fold only what the human reads: NEEDS YOU (questions for them, with buttons)
 * and STATUS in plain words. Everything the team needs (agent instructions, readings, seams, ids, paths)
 * sits under a <details> toggle. No script; the only forms are the answer buttons.
 * Every UI string comes from i18n.ts; content written by the team is rendered as written.
 * It re-fetches itself with a meta refresh, never faster than every 30 s.
 */
export const REFRESH_SECONDS = 30;

const STATUS_ORDER = ["blocked", "working", "done", "failed", "open", "verified", "withdrawn"] as const;

export interface RenderOptions { sha?: string; refresh?: number; canDecide?: boolean; human?: string }

export function renderBoard(b: Board, s: State, opts: RenderOptions = {}): string {
  const refresh = Math.max(REFRESH_SECONDS, opts.refresh ?? REFRESH_SECONDS);
  const human = opts.human ?? "human";
  const now = Date.parse(b.now);
  const ago = (iso: string) => UI.ago(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)));
  const t = (iso: string) => `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(iso))}</time>`;
  const canDecide = opts.canDecide !== false;
  const disabled = canDecide ? "" : " disabled";
  const hint = canDecide ? "" : ` <span class="meta">${UI.toAnswer} <code>/?token=…</code>${UI.toAnswerTail}</span>`;
  const why = (r: Board["readings"][number]) => !r.why ? "" : r.why.startsWith("superseded by") ? `${UI.supersededBy} <code>${esc(r.why.slice(14))}</code>` : r.why.startsWith("invalidated by") ? `${UI.invalidatedBy} <code>${esc(r.why.slice(15))}</code>` : UI.expired;

  // ---------- above the fold ----------
  const fold: string[] = [];

  const asks = b.needs_human.filter((n) => !n.chosen);
  fold.push(`<section id="needs-you" class="card"><h2>${UI.needsYou}${asks.length ? ` <span class="count">${asks.length}</span>` : ""}</h2>`);
  if (!asks.length) fold.push(`<p class="empty">${UI.nothingForYou}</p>`);
  for (const i of asks) {
    fold.push(`<div class="ask"><p class="q">${esc(i.body)}</p><p class="meta">${esc(UI.askedBy(i.from, ago(i.since)))}${i.options?.length && i.default ? ` · ${UI.ifNothing}<b>${esc(i.default)}</b>` : ""}</p>`);
    if (i.options?.length) {
      const buttons = i.options.map((o) => `<button type="submit" name="option" value="${esc(o)}"${o === i.default ? ' class="default"' : ""}${disabled}>${esc(o)}${o === i.default ? ` <small>${UI.defaultTag}</small>` : ""}</button>`).join(" ");
      fold.push(`<form class="decide" method="post" action="/decide"><input type="hidden" name="id" value="${esc(i.id)}">${buttons}${hint}</form>`);
    } else {
      fold.push(`<form class="decide" method="post" action="/ack"><input type="hidden" name="id" value="${esc(i.id)}"><button type="submit"${disabled}>${UI.gotIt}</button>${hint}</form>`);
    }
    fold.push(`</div>`);
  }
  // 说一句：the human's one line to the team, and what became of the earlier ones (board.said, t-030).
  fold.push(`<form class="say" method="post" action="/say"><input type="text" name="text" maxlength="500" placeholder="${esc(UI.sayPlaceholder)}" autocomplete="off"${disabled}><button type="submit"${disabled}>${UI.say}</button>${hint}</form>`);
  const said = saidOf(b);
  if (said.length) {
    const recent = said.slice(0, SAID_SHOWN), rest = said.slice(SAID_SHOWN);
    const line = (x: Said) => `<li><span class="said-body">${esc(x.body)}</span> <span class="meta">${t(x.at)} · ${esc(saidStatus(x))}</span></li>`;
    fold.push(`<div class="said"><h3>${UI.said}</h3><ul class="plain">${recent.map(line).join("")}</ul>${rest.length ? `<details class="fold"><summary>${esc(UI.moreSaid(rest.length))}</summary><ul class="plain">${rest.map(line).join("")}</ul></details>` : ""}</div>`);
  }
  fold.push(`</section>`);

  const flight = inFlightOf(b);
  const sha = b.live.deployed_sha ? String(b.live.deployed_sha).slice(0, 7) : null;
  const shaReading = b.readings.find((r) => r.valid && r.surface === "production" && r.key === "deployed.sha");
  fold.push(`<section id="status" class="card"><h2>${UI.status}</h2>`);
  fold.push(`<dl>`);
  fold.push(`<dt>${UI.focus}</dt><dd>${b.focus ? `${esc(str(b.focus.body))} <span class="meta">（${esc(UI.setBy(b.focus.set_by, ago(b.focus.at)))}）</span>` : `<span class="empty">${UI.noFocus}</span>`}</dd>`);
  // What this version brought: tasks verified on production since the current sha was recorded; older ones fold.
  const liveList = b.live.recent.length || b.live.earlier.length
    ? `${b.live.since_sha ? `<div class="meta">${esc(UI.sinceLast(String(b.live.since_sha).slice(0, 7)))}</div>` : ""}${b.live.recent.length ? `<ul class="plain">${b.live.recent.map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul>` : ""}${folded(b.live.earlier.map((x) => x.title))}`
    : `<div class="meta">${UI.noneOnProduction}</div>`;
  fold.push(`<dt>${UI.live}</dt><dd>${sha ? `${UI.build} <code>${esc(sha)}</code>${shaReading ? ` <span class="meta">（${esc(UI.checked(ago(shaReading.at)))}）</span>` : ""}` : `<span class="empty">${UI.noDeployReading}</span>`}${liveList}</dd>`);
  fold.push(`<dt>${UI.inFlight}</dt><dd>${flight.some((g) => g.total) ? flight.filter((g) => g.total).map((g) => `<div class="group"><span class="label">${esc(g.label)}${g.total > g.shown.length ? ` <span class="count">${g.total}</span>` : ""}</span><ul class="plain">${g.shown.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${folded(g.rest)}</div>`).join("") : `<span class="empty">${UI.nothingInFlight}</span>`}</dd>`);
  fold.push(`<dt>${UI.who}</dt><dd>${b.presence.length ? `<ul class="presence">${b.presence.map((p) => `<li class="${p.idle_s > 600 ? "away" : "here"}"><b>${esc(p.actor)}</b> <span class="meta">${t(p.last_seen)}</span></li>`).join("")}</ul>` : `<span class="empty">${UI.nobody}</span>`}</dd>`);
  fold.push(`</dl></section>`);

  // ---------- details: the team's state ----------
  const d: string[] = [];

  d.push(`<section id="overdue"><h2>${UI.overdue} <span class="count">${b.overdue.length}</span></h2>`);
  if (b.overdue.length) {
    d.push(`<ul>`);
    for (const i of b.overdue) d.push(`<li><span class="tag overdue">${UI.instrStatus.overdue}</span> ${esc(UI.overdueLine(i.to, i.body, i.from))} <span class="meta">（${esc(UI.due(ago(i.ack_by)))} · <code>${esc(i.instruction)}</code>）</span></li>`);
    d.push(`</ul>`);
  } else d.push(`<p class="empty">${UI.none}</p>`);
  d.push(`</section>`);

  const open = b.instructions.filter((i) => i.status !== "acked" && i.to !== human && !i.chosen);
  d.push(`<section id="instructions"><h2>${UI.agentInstructions} <span class="count">${open.length}</span></h2>`);
  if (open.length) {
    d.push(`<table><thead><tr><th>${UI.th.status}</th><th>${UI.th.fromTo}</th><th>${UI.th.body}</th><th>${UI.th.sent}</th><th>${UI.th.delivered}</th></tr></thead><tbody>`);
    for (const i of open) {
      d.push(`<tr class="${esc(i.status)}"><td><span class="tag ${esc(i.status)}">${esc(UI.instrStatus[i.status] ?? i.status)}</span></td><td>${esc(i.from)} → ${esc(i.to)}</td><td>${esc(i.body)}<div class="meta"><code>${esc(i.id)}</code></div></td><td>${t(i.sent)}</td><td>${i.delivered ? t(i.delivered) : `<span class="meta">${UI.notPulled}</span>`}</td></tr>`);
    }
    d.push(`</tbody></table>`);
  } else d.push(`<p class="empty">${UI.none}</p>`);
  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) {
    d.push(`<h3>${UI.decided}</h3><ul>`);
    for (const i of decided.slice(-5)) d.push(`<li>${esc(i.from)} → ${esc(i.to)}：${esc(i.body)} <b>${esc(i.chosen!.by === "default" ? UI.decidedByDefault(i.chosen!.option) : UI.chosen(i.chosen!.by, i.chosen!.option))}</b><span class="meta">，${t(i.chosen!.at)} · <code>${esc(i.id)}</code></span></li>`);
    d.push(`</ul>`);
  }
  d.push(`</section>`);

  const total = Object.values(b.tasks).reduce((n, xs) => n + xs.length, 0);
  d.push(`<section id="tasks"><h2>${UI.tasks} <span class="count">${total}</span></h2>`);
  if (!total) d.push(`<p class="empty">${UI.none}</p>`);
  for (const status of STATUS_ORDER) {
    const list = b.tasks[status] ?? [];
    if (!list.length) continue;
    d.push(`<h3>${esc(UI.taskStatus[status] ?? status)} <span class="count">${list.length}</span></h3><ul class="tasks">`);
    for (const task of list) {
      const st = s.tasks.get(task.id);
      const bits: string[] = [];
      if (task.owner) bits.push(`@${esc(task.owner)}`);
      if (task.blocked_on) bits.push(`⏸ ${esc(task.blocked_on)}`);
      if (task.verified_on?.length) bits.push(`✓ ${esc(task.verified_on.map(surface).join("、"))}`);
      d.push(`<li><details><summary><code>${esc(task.id)}</code> ${esc(task.title)}${bits.length ? ` <span class="meta">${bits.join(" · ")}</span>` : ""}</summary>`);
      if (st) {
        d.push(`<div class="meta">${esc(UI.criteriaBy(st.criteria_by, ago(st.created_at)))}</div>`);
        d.push(`<ol class="criteria">${st.criteria.map((c, i) => {
          const added = (st.criteria_added ?? []).find((a) => a.index === i);
          return `<li>${esc(c)}${added ? ` <span class="meta">+ ${esc(added.by)} · ${esc(ago(added.at))}</span>` : ""}</li>`;
        }).join("")}</ol>`);
        if (st.touches.length) d.push(`<div class="meta">${UI.touches}：${st.touches.map((x) => `<code>${esc(x)}</code>`).join(", ")}</div>`);
        if (st.evidence) d.push(`<div class="meta">${UI.evidence}：${esc(st.evidence)}</div>`);
        for (const n of st.notes.filter((n) => /^\s*evidence:/i.test(n.body))) d.push(`<div class="meta">+ ${esc(n.body.replace(/^\s*evidence:\s*/i, ""))} <span class="meta">（${esc(n.actor)}，${t(n.at)}）</span></div>`);
        for (const v of st.verifications) d.push(`<div class="meta">${v.pass ? `✓ ${UI.verifiedOn}` : `✗ ${UI.failedOn}`} <b>${esc(surface(v.surface))}</b>，${UI.by} ${esc(v.by)}，${t(v.at)}${v.evidence ? `：${esc(v.evidence)}` : ""}</div>`);
        if (st.withdrawn) d.push(`<div class="meta">${esc(UI.withdrawnBy(st.withdrawn.by, ago(st.withdrawn.at)))}：${esc(st.withdrawn.reason)}</div>`);
        if (st.notes.length) {
          d.push(`<ul class="notes">`);
          for (const n of st.notes) d.push(`<li><b>${esc(n.actor)}</b> ${t(n.at)}${n.decision ? ` <span class="tag acked">${UI.decisionTag}</span>` : ""}：${esc(n.body)}</li>`);
          d.push(`</ul>`);
        }
      }
      d.push(`</details></li>`);
    }
    d.push(`</ul>`);
  }
  d.push(`</section>`);

  const openSeams = b.seams.filter((x) => x.open);
  const otherSeams = b.seams.filter((x) => !x.open);
  d.push(`<section id="seams"><h2>${UI.seams} <span class="count">${esc(UI.openCount(openSeams.length))}</span></h2>`);
  if (b.seams.length) {
    d.push(`<ul>`);
    for (const x of openSeams) d.push(`<li><span class="tag open_seam">${UI.seamOpen}</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> ${UI.bothTouch} ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`);
    for (const x of otherSeams) d.push(`<li class="resolved"><span class="tag acked">${x.resolved ? esc(UI.seamResolvedBy(x.resolved)) : UI.seamStacked}</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> ${UI.bothTouch} ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`);
    d.push(`</ul>`);
  } else d.push(`<p class="empty">${UI.none}</p>`);
  d.push(`</section>`);

  const valid = b.readings.filter((r) => r.valid);
  const stale = b.readings.filter((r) => !r.valid);
  d.push(`<section id="readings"><h2>${UI.readings} <span class="count">${esc(UI.readingCount(valid.length, stale.length))}</span></h2>`);
  if (b.readings.length) {
    d.push(`<table><thead><tr><th></th><th>${UI.rth.key}</th><th>${UI.rth.value}</th><th>${UI.rth.by}</th><th>${UI.rth.when}</th><th>${UI.rth.notes}</th></tr></thead><tbody>`);
    for (const r of [...valid, ...stale]) {
      d.push(`<tr class="${r.valid ? "valid" : "stale"}"><td>${r.valid ? `<span class="tag valid">${UI.valid}</span>` : `<span class="tag stale">${UI.stale}</span>`}</td><td><code>${esc(r.surface)}:${esc(r.key)}</code></td><td>${esc(str(r.value))}</td><td>${esc(r.by)}</td><td>${t(r.at)}</td><td class="meta">${[why(r), r.assumptions?.length ? `${UI.assumes}：${esc(r.assumptions.join("；"))}` : ""].filter(Boolean).join(" · ")}</td></tr>`);
    }
    d.push(`</tbody></table>`);
  } else d.push(`<p class="empty">${UI.none}</p>`);
  d.push(`</section>`);

  const body = `${fold.join("\n")}
<details class="more"><summary>${UI.more}</summary>
${d.join("\n")}
</details>`;
  return page(body, { now: b.now, refresh, sha: opts.sha });
}

/** One thing the human said on the board (board.said, t-030): the line, when, and what became of it. */
export type Said = Pick<BoardSaid, "id" | "body" | "at"> & Partial<Pick<BoardSaid, "status" | "label" | "links">>;
export const SAID_SHOWN = 5;

/** Newest first, as the board sends it. Tolerates a board without `said` (a server older than t-030). */
export function saidOf(b: Board): Said[] {
  return ((b.said as Said[] | undefined) ?? []).slice().sort((x, y) => y.at.localeCompare(x.at));
}

/** The board decides the status sentence (`label`); the page only falls back to wording a bare status key. */
export function saidStatus(x: Said): string {
  if (x.label) return x.label;
  const base = UI.saidStatus[x.status ?? "received"] ?? x.status ?? "";
  const titles = (x.links?.tasks ?? []).map((t) => t.title).filter(Boolean);
  return titles.length && (x.status === "task" || x.status === "live") ? `${base}：${titles.join("、")}` : base;
}

/** How many items a group shows before folding the rest; the board folds in_flight at the same count. */
export const SHOWN = 5;

/** In flight, as titles: what the board shows per group, and the rest to fold. */
export function inFlightOf(b: Board): { label: string; total: number; shown: string[]; rest: string[] }[] {
  const title = (t: { title: string; owner?: string }) => `${t.title}${t.owner ? `（${t.owner}）` : ""}`;
  const g = (k: string) => {
    const grp = b.in_flight[k];
    if (!grp) return { total: 0, shown: [], rest: [] };
    const shownIds = new Set(grp.shown.map((t) => t.id));
    return { total: grp.total, shown: grp.shown.map(title), rest: grp.all.filter((t) => !shownIds.has(t.id)).map(title) };
  };
  const elsewhere = (b.tasks.verified ?? []).filter((t) => !t.verified_on?.includes("production")).map((t) => `${t.title}${UI.onSurface(t.verified_on?.map(surface).join("、") || "?")}`);
  const verifiedElsewhere = { total: elsewhere.length, shown: elsewhere.slice(-SHOWN).reverse(), rest: elsewhere.slice(0, Math.max(0, elsewhere.length - SHOWN)).reverse() };
  return [
    { label: UI.groups.working, ...g("working") },
    { label: UI.groups.blocked, ...g("blocked") },
    { label: UI.groups.done, ...g("done") },
    { label: UI.groups.verifiedElsewhere, ...verifiedElsewhere },
    { label: UI.groups.failed, ...g("failed") },
    { label: UI.groups.open, ...g("open") },
  ];
}

/** The rest of a list behind a one-line toggle: 「还有 N 项」. Empty when there is nothing to fold. */
function folded(items: string[]): string {
  if (!items.length) return "";
  return `<details class="fold"><summary>${esc(UI.moreItems(items.length))}</summary><ul class="plain">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>`;
}

export function unauthorizedPage(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${UI.title}</title></head><body style="font:16px system-ui;padding:2rem"><h1>${UI.title}</h1><p>${UI.unauthorized} <code>/?token=&lt;ATEAM_TOKEN&gt;</code>${UI.unauthorizedTail}</p></body></html>`;
}

function page(body: string, m: { now: string; refresh: number; sha?: string }): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${m.refresh}">
<title>${UI.header}</title>
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafaf7; --muted: #6b6b6b; --line: #e3e3de; --card: #ffffff; --accent: #2f6fed; --warn: #b45309; --bad: #b91c1c; --good: #15803d; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #141414; --muted: #9a9a9a; --line: #2c2c2c; --card: #1d1d1d; --accent: #7aa2ff; --warn: #f59e0b; --bad: #f87171; --good: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 16px/1.6 system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); max-width: 60rem; margin-inline: auto; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
header h1 { margin: 0; font-size: 1.25rem; letter-spacing: .02em; }
section, details.more { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
section.card { padding: 1.25rem 1.5rem; }
h2 { margin: 0 0 .6rem; font-size: 1rem; letter-spacing: .1em; color: var(--muted); }
h3 { margin: 1rem 0 .25rem; font-size: .9rem; letter-spacing: .05em; color: var(--muted); }
.count { font-weight: normal; color: var(--muted); letter-spacing: 0; }
#needs-you .count { color: var(--bad); font-weight: 600; }
.ask { padding: .75rem 0; border-top: 1px solid var(--line); }
.ask:first-of-type { border-top: 0; }
.ask .q { margin: 0; font-size: 1.2rem; }
.meta, .empty { color: var(--muted); font-size: .85rem; }
.ask .meta { margin: .15rem 0 .5rem; }
.empty { font-style: italic; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .6rem 1.25rem; margin: 0; }
dt { color: var(--muted); font-size: .9rem; letter-spacing: .05em; padding-top: .15rem; }
dd { margin: 0; }
ul.plain { margin: .15rem 0 0; padding-left: 1.1rem; }
.group { margin-bottom: .4rem; }
.group .label { font-size: .85rem; color: var(--muted); }
code { font: .85em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: color-mix(in srgb, var(--fg) 7%, transparent); padding: .05em .3em; border-radius: 4px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; vertical-align: top; padding: .35rem .5rem; border-top: 1px solid var(--line); }
th { color: var(--muted); font-weight: normal; font-size: .8rem; border-top: 0; }
tr.stale td { color: var(--muted); }
ul { margin: 0; padding-left: 1.2rem; }
ul.tasks, ul.presence { list-style: none; padding: 0; }
ul.tasks li { padding: .25rem 0; border-top: 1px solid var(--line); }
ul.tasks summary { cursor: pointer; }
ol.criteria { margin: .25rem 0 .5rem; padding-left: 1.5rem; }
ul.notes { margin: .35rem 0 .25rem; padding-left: 1rem; font-size: .9rem; border-left: 2px solid var(--line); list-style: none; }
ul.notes li { padding: .15rem 0; }
ul.presence { display: flex; flex-wrap: wrap; gap: .3rem 1.25rem; margin: 0; }
ul.presence li.away { color: var(--muted); }
.tag { display: inline-block; font-size: .75rem; letter-spacing: .05em; padding: .1em .45em; border-radius: 999px; border: 1px solid currentColor; }
.tag.instruction, .tag.pending, .tag.delivered { color: var(--accent); }
.tag.overdue, .tag.open_seam, .tag.stale { color: var(--bad); }
.tag.valid, .tag.acked { color: var(--good); }
form.decide { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .25rem 0 0; }
form.decide button { font: inherit; padding: .45rem 1rem; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
form.decide button.default { border-color: var(--accent); color: var(--accent); }
form.decide button:disabled { cursor: not-allowed; opacity: .55; }
form.decide small { font-size: .75em; letter-spacing: .05em; }
form.say { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: 1rem 0 0; padding-top: .75rem; border-top: 1px solid var(--line); }
form.say input { flex: 1 1 18rem; font: inherit; padding: .5rem .75rem; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
form.say button { font: inherit; padding: .5rem 1.1rem; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
form.say input:disabled, form.say button:disabled { cursor: not-allowed; opacity: .55; }
.said h3 { margin: .75rem 0 .25rem; }
.said .said-body { font-size: 1rem; }
details.fold { margin: .1rem 0 .2rem 1.1rem; }
details.fold > summary { cursor: pointer; color: var(--muted); font-size: .85rem; }
details.more > summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
details.more[open] > summary { margin-bottom: .75rem; }
details.more section { border: 0; border-top: 1px solid var(--line); border-radius: 0; margin: 0; padding: 1rem 0; }
footer { color: var(--muted); font-size: .8rem; display: flex; gap: 1rem; flex-wrap: wrap; }
</style>
</head>
<body>
<header><h1>${UI.header}</h1><span class="meta">${UI.refreshes(m.refresh)} · <time datetime="${esc(m.now)}">${esc(m.now.replace("T", " ").slice(0, 16))}Z</time></span></header>
${body}
<footer><span>${UI.buildLabel} <code>${esc((m.sha ?? "unknown").slice(0, 7))}</code></span><span>${UI.sameAs} <code>GET /board</code> ${UI.sameAsTail}</span></footer>
</body>
</html>
`;
}

/** Surface names the human knows: repo → 仓库, production → 生产. Unknown surfaces stay as written. */
export function surface(s: string): string {
  return UI.surface[s] ?? s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
