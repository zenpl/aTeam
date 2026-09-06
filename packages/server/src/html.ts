import type { Board, State } from "@ateam/core";

/**
 * The human's page. Above the fold only what the human reads: NEEDS YOU (questions for them, with buttons)
 * and STATUS in plain words. Everything the team needs (agent instructions, readings, seams, ids, paths)
 * sits under a <details> toggle. No script; the only forms are the answer buttons.
 * It re-fetches itself with a meta refresh, never faster than every 30 s.
 */
export const REFRESH_SECONDS = 30;

const STATUS_ORDER = ["blocked", "working", "done", "failed", "open", "verified", "withdrawn"] as const;

export interface RenderOptions { sha?: string; refresh?: number; canDecide?: boolean; human?: string }

export function renderBoard(b: Board, s: State, opts: RenderOptions = {}): string {
  const refresh = Math.max(REFRESH_SECONDS, opts.refresh ?? REFRESH_SECONDS);
  const human = opts.human ?? "human";
  const now = Date.parse(b.now);
  const ago = (iso: string) => {
    const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    return sec < 60 ? "just now" : sec < 5400 ? `${Math.round(sec / 60)} min ago` : sec < 172800 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} days ago`;
  };
  const t = (iso: string) => `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(iso))}</time>`;
  const canDecide = opts.canDecide !== false;
  const disabled = canDecide ? "" : " disabled";
  const hint = canDecide ? "" : ` <span class="meta">to answer, open <code>/?token=…</code> once</span>`;

  // ---------- above the fold ----------
  const fold: string[] = [];

  const asks = b.instructions.filter((i) => i.to === human && i.status !== "acked");
  fold.push(`<section id="needs-you" class="card"><h2>Needs you${asks.length ? ` <span class="count">${asks.length}</span>` : ""}</h2>`);
  if (!asks.length) fold.push(`<p class="empty">Nothing waiting on you.</p>`);
  for (const i of asks) {
    fold.push(`<div class="ask"><p class="q">${esc(i.body)}</p><p class="meta">${esc(i.from)} asked ${t(i.sent)}${i.options?.length && i.default ? ` · if you do nothing: <b>${esc(i.default)}</b>` : ""}</p>`);
    if (i.options?.length) {
      const buttons = i.options.map((o) => `<button type="submit" name="option" value="${esc(o)}"${o === i.default ? ' class="default"' : ""}${disabled}>${esc(o)}${o === i.default ? " <small>default</small>" : ""}</button>`).join(" ");
      fold.push(`<form class="decide" method="post" action="/decide"><input type="hidden" name="id" value="${esc(i.id)}">${buttons}${hint}</form>`);
    } else {
      fold.push(`<form class="decide" method="post" action="/ack"><input type="hidden" name="id" value="${esc(i.id)}"><button type="submit"${disabled}>Got it</button>${hint}</form>`);
    }
    fold.push(`</div>`);
  }
  fold.push(`</section>`);

  const live = liveOf(b, s);
  const flight = inFlightOf(b);
  fold.push(`<section id="status" class="card"><h2>Status</h2>`);
  fold.push(`<dl>`);
  fold.push(`<dt>Focus</dt><dd>${b.focus ? `${esc(str(b.focus.body))} <span class="meta">(${esc(b.focus.set_by)}, ${t(b.focus.at)})</span>` : `<span class="empty">no focus set</span>`}</dd>`);
  fold.push(`<dt>Live on production</dt><dd>${live.sha ? `build <code>${esc(live.sha)}</code>${live.at ? ` <span class="meta">(checked ${t(live.at)})</span>` : ""}` : `<span class="empty">nobody has checked what is deployed</span>`}${live.tasks.length ? `<ul class="plain">${live.tasks.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="meta">no task verified on production yet</div>`}</dd>`);
  fold.push(`<dt>In flight</dt><dd>${flight.some((g) => g.items.length) ? flight.filter((g) => g.items.length).map((g) => `<div class="group"><span class="label">${esc(g.label)}</span><ul class="plain">${g.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("") : `<span class="empty">nothing in flight</span>`}</dd>`);
  fold.push(`<dt>Who is here</dt><dd>${b.presence.length ? `<ul class="presence">${b.presence.map((p) => `<li class="${p.idle_s > 600 ? "away" : "here"}"><b>${esc(p.actor)}</b> <span class="meta">${t(p.last_seen)}</span></li>`).join("")}</ul>` : `<span class="empty">nobody yet</span>`}</dd>`);
  fold.push(`</dl></section>`);

  // ---------- details: the team's state ----------
  const d: string[] = [];
  const tt = (iso: string) => `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(iso))}</time>`;

  const overdue = overdueOf(b, human);
  d.push(`<section id="overdue"><h2>Overdue <span class="count">${overdue.length}</span></h2>`);
  if (overdue.length) {
    d.push(`<ul>`);
    for (const i of overdue) d.push(`<li><span class="tag overdue">overdue</span> <b>${esc(i.to)}</b> has not acked "${esc(i.body)}" from ${esc(i.from)} <span class="meta">(due ${tt(i.ack_by)} · <code>${esc(i.id)}</code>)</span></li>`);
    d.push(`</ul>`);
  } else d.push(`<p class="empty">none</p>`);
  d.push(`</section>`);

  const open = b.instructions.filter((i) => i.status !== "acked" && i.to !== human);
  d.push(`<section id="instructions"><h2>Open instructions between sessions <span class="count">${open.length}</span></h2>`);
  if (open.length) {
    d.push(`<table><thead><tr><th>status</th><th>from → to</th><th>body</th><th>sent</th><th>delivered</th></tr></thead><tbody>`);
    for (const i of open) {
      d.push(`<tr class="${esc(i.status)}"><td><span class="tag ${esc(i.status)}">${esc(i.status)}</span></td><td>${esc(i.from)} → ${esc(i.to)}</td><td>${esc(i.body)}<div class="meta"><code>${esc(i.id)}</code></div></td><td>${tt(i.sent)}</td><td>${i.delivered ? tt(i.delivered) : "<span class=\"meta\">not yet pulled</span>"}</td></tr>`);
    }
    d.push(`</tbody></table>`);
  } else d.push(`<p class="empty">none</p>`);
  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) {
    d.push(`<h3>Decided</h3><ul>`);
    for (const i of decided.slice(-5)) d.push(`<li>${esc(i.from)} → ${esc(i.to)}: ${esc(i.body)} <b>⇒ ${esc(i.chosen!.option)}</b> <span class="meta">${esc(i.chosen!.by)}, ${tt(i.chosen!.at)} · <code>${esc(i.id)}</code></span></li>`);
    d.push(`</ul>`);
  }
  d.push(`</section>`);

  const total = Object.values(b.tasks).reduce((n, xs) => n + xs.length, 0);
  d.push(`<section id="tasks"><h2>Tasks <span class="count">${total}</span></h2>`);
  if (!total) d.push(`<p class="empty">none</p>`);
  for (const status of STATUS_ORDER) {
    const list = b.tasks[status] ?? [];
    if (!list.length) continue;
    d.push(`<h3>${esc(status)} <span class="count">${list.length}</span></h3><ul class="tasks">`);
    for (const task of list) {
      const st = s.tasks.get(task.id);
      const bits: string[] = [];
      if (task.owner) bits.push(`@${esc(task.owner)}`);
      if (task.blocked_on) bits.push(`⏸ ${esc(task.blocked_on)}`);
      if (task.verified_on?.length) bits.push(`✓ ${esc(task.verified_on.join(", "))}`);
      d.push(`<li><details><summary><code>${esc(task.id)}</code> ${esc(task.title)}${bits.length ? ` <span class="meta">${bits.join(" · ")}</span>` : ""}</summary>`);
      if (st) {
        d.push(`<div class="meta">criteria by ${esc(st.criteria_by)}, created ${tt(st.created_at)}</div>`);
        d.push(`<ol class="criteria">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>`);
        if (st.touches.length) d.push(`<div class="meta">touches: ${st.touches.map((x) => `<code>${esc(x)}</code>`).join(", ")}</div>`);
        if (st.evidence) d.push(`<div class="meta">evidence: ${esc(st.evidence)}</div>`);
        for (const n of st.notes.filter((n) => /^\s*evidence:/i.test(n.body))) d.push(`<div class="meta">+ ${esc(n.body.replace(/^\s*evidence:\s*/i, ""))} <span class="meta">(${esc(n.actor)}, ${tt(n.at)})</span></div>`);
        for (const v of st.verifications) d.push(`<div class="meta">${v.pass ? "✓ verified" : "✗ failed"} on <b>${esc(v.surface)}</b> by ${esc(v.by)} ${tt(v.at)}${v.evidence ? `: ${esc(v.evidence)}` : ""}</div>`);
        if (st.withdrawn) d.push(`<div class="meta">withdrawn by ${esc(st.withdrawn.by)} ${tt(st.withdrawn.at)}: ${esc(st.withdrawn.reason)}</div>`);
        if (st.notes.length) {
          d.push(`<ul class="notes">`);
          for (const n of st.notes) d.push(`<li><b>${esc(n.actor)}</b> ${tt(n.at)}${n.decision ? ' <span class="tag acked">decision</span>' : ""}: ${esc(n.body)}</li>`);
          d.push(`</ul>`);
        }
      }
      d.push(`</details></li>`);
    }
    d.push(`</ul>`);
  }
  d.push(`</section>`);

  const openSeams = b.seams.filter((x) => !x.resolved && !x.stacked);
  const otherSeams = b.seams.filter((x) => x.resolved || x.stacked);
  d.push(`<section id="seams"><h2>Seams <span class="count">${openSeams.length} open</span></h2>`);
  if (b.seams.length) {
    d.push(`<ul>`);
    for (const x of openSeams) d.push(`<li><span class="tag open_seam">open</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> both touch ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`);
    for (const x of otherSeams) d.push(`<li class="resolved"><span class="tag acked">${x.resolved ? `resolved by ${esc(x.resolved)}` : "stacked"}</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> on ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`);
    d.push(`</ul>`);
  } else d.push(`<p class="empty">none</p>`);
  d.push(`</section>`);

  const valid = b.readings.filter((r) => r.valid);
  const stale = b.readings.filter((r) => !r.valid);
  d.push(`<section id="readings"><h2>Readings <span class="count">${valid.length} valid, ${stale.length} stale</span></h2>`);
  if (b.readings.length) {
    d.push(`<table><thead><tr><th></th><th>surface:key</th><th>value</th><th>by</th><th>when</th><th>notes</th></tr></thead><tbody>`);
    for (const r of [...valid, ...stale]) {
      d.push(`<tr class="${r.valid ? "valid" : "stale"}"><td>${r.valid ? "<span class=\"tag valid\">valid</span>" : "<span class=\"tag stale\">stale</span>"}</td><td><code>${esc(r.surface)}:${esc(r.key)}</code></td><td>${esc(str(r.value))}</td><td>${esc(r.by)}</td><td>${tt(r.at)}</td><td class="meta">${[r.why ? esc(r.why) : "", r.assumptions?.length ? `assumes: ${esc(r.assumptions.join("; "))}` : ""].filter(Boolean).join(" · ")}</td></tr>`);
    }
    d.push(`</tbody></table>`);
  } else d.push(`<p class="empty">none</p>`);
  d.push(`</section>`);

  const body = `${fold.join("\n")}
<details class="more"><summary>Everything else: the team's own state (instructions between sessions, tasks with ids, seams, readings)</summary>
${d.join("\n")}
</details>`;
  return page(body, { now: b.now, refresh, sha: opts.sha });
}

/** What is live: the latest valid production:deployed.sha reading, and the titles of tasks verified on production. */
export function liveOf(b: Board, s: State): { sha: string | null; at?: string; tasks: string[] } {
  const r = b.readings.find((x) => x.valid && x.surface === "production" && x.key === "deployed.sha");
  const tasks = [...s.tasks.values()]
    .filter((t) => t.status !== "withdrawn" && t.verifications.some((v) => v.pass && v.surface === "production"))
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((t) => t.title);
  return { sha: r ? str(r.value).slice(0, 7) : null, at: r?.at, tasks };
}

/** In flight, as titles. */
export function inFlightOf(b: Board): { label: string; items: string[] }[] {
  // Titles and owners only: a blocked_on reason can carry ids and paths, which stay below the fold.
  const title = (t: { title: string; owner?: string }) => `${t.title}${t.owner ? ` (${t.owner})` : ""}`;
  const working = [...(b.tasks.working ?? [])].map(title);
  const blocked = [...(b.tasks.blocked ?? [])].map(title);
  const awaiting = [...(b.tasks.done ?? [])].map((t) => t.title);
  const verifiedElsewhere = [...(b.tasks.verified ?? [])].filter((t) => !t.verified_on?.includes("production")).map((t) => `${t.title} (on ${t.verified_on?.join(", ") || "?"})`);
  const notStarted = [...(b.tasks.open ?? []), ...(b.tasks.failed ?? [])].map((t) => t.title);
  return [
    { label: "Being worked on", items: working },
    { label: "Blocked", items: blocked },
    { label: "Done, waiting for a check", items: awaiting },
    { label: "Checked, not yet on production", items: verifiedElsewhere },
    { label: "Not started", items: notStarted },
  ];
}

/** Instructions to sessions that missed their ack deadline. */
export function overdueOf(b: Board, human: string) {
  return b.instructions.filter((i) => i.status === "overdue" && i.to !== human).map((i) => ({ id: i.id, from: i.from, to: i.to, body: i.body, ack_by: i.sent }));
}

function page(body: string, m: { now: string; refresh: number; sha?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${m.refresh}">
<title>aTeam</title>
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafaf7; --muted: #6b6b6b; --line: #e3e3de; --card: #ffffff; --accent: #2f6fed; --warn: #b45309; --bad: #b91c1c; --good: #15803d; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #141414; --muted: #9a9a9a; --line: #2c2c2c; --card: #1d1d1d; --accent: #7aa2ff; --warn: #f59e0b; --bad: #f87171; --good: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); max-width: 60rem; margin-inline: auto; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
header h1 { margin: 0; font-size: 1.25rem; letter-spacing: .02em; }
section, details.more { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
section.card { padding: 1.25rem 1.5rem; }
h2 { margin: 0 0 .6rem; font-size: .95rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
h3 { margin: 1rem 0 .25rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.count { font-weight: normal; color: var(--muted); text-transform: none; letter-spacing: 0; }
#needs-you .count { color: var(--bad); font-weight: 600; }
.ask { padding: .75rem 0; border-top: 1px solid var(--line); }
.ask:first-of-type { border-top: 0; }
.ask .q { margin: 0; font-size: 1.2rem; }
.meta, .empty { color: var(--muted); font-size: .85rem; }
.ask .meta { margin: .15rem 0 .5rem; }
.empty { font-style: italic; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .6rem 1.25rem; margin: 0; }
dt { color: var(--muted); font-size: .85rem; text-transform: uppercase; letter-spacing: .05em; padding-top: .15rem; }
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
.tag { display: inline-block; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; padding: .1em .45em; border-radius: 999px; border: 1px solid currentColor; }
.tag.instruction, .tag.pending, .tag.delivered { color: var(--accent); }
.tag.overdue, .tag.open_seam, .tag.stale { color: var(--bad); }
.tag.valid, .tag.acked { color: var(--good); }
form.decide { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .25rem 0 0; }
form.decide button { font: inherit; padding: .45rem 1rem; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
form.decide button.default { border-color: var(--accent); color: var(--accent); }
form.decide button:disabled { cursor: not-allowed; opacity: .55; }
form.decide small { font-size: .7em; text-transform: uppercase; letter-spacing: .05em; }
details.more > summary { cursor: pointer; color: var(--muted); font-size: .9rem; }
details.more[open] > summary { margin-bottom: .75rem; }
details.more section { border: 0; border-top: 1px solid var(--line); border-radius: 0; margin: 0; padding: 1rem 0; }
footer { color: var(--muted); font-size: .8rem; display: flex; gap: 1rem; flex-wrap: wrap; }
</style>
</head>
<body>
<header><h1>aTeam</h1><span class="meta">refreshes every ${m.refresh}s · <time datetime="${esc(m.now)}">${esc(m.now.replace("T", " ").slice(0, 16))}Z</time></span></header>
${body}
<footer><span>server build <code>${esc((m.sha ?? "unknown").slice(0, 7))}</code></span><span>same data as <code>GET /board</code></span></footer>
</body>
</html>
`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
