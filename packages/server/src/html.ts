import type { Board, State } from "@ateam/core";

/**
 * The board as one static HTML page for the human. No script; the only forms are the decision buttons
 * on instructions that carry options. It re-fetches itself with a meta refresh, never faster than every 30 s.
 */
export const REFRESH_SECONDS = 30;

const STATUS_ORDER = ["blocked", "working", "done", "failed", "open", "verified"] as const;

export function renderBoard(b: Board, s: State, opts: { sha?: string; refresh?: number; canDecide?: boolean } = {}): string {
  const refresh = Math.max(REFRESH_SECONDS, opts.refresh ?? REFRESH_SECONDS);
  const now = Date.parse(b.now);
  const ago = (iso: string) => {
    const sec = Math.round((now - Date.parse(iso)) / 1000);
    return sec < 90 ? `${sec}s` : sec < 5400 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;
  };
  const t = (iso: string) => `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(iso))} ago</time>`;
  const out: string[] = [];

  out.push(`<section id="focus"><h2>Focus</h2>`);
  out.push(b.focus
    ? `<p class="focus">${esc(str(b.focus.body))}</p><p class="meta">set by ${esc(b.focus.set_by)}, ${t(b.focus.at)}</p>`
    : `<p class="empty">no focus set</p>`);
  out.push(`</section>`);

  const asks = new Map(b.instructions.filter((i) => i.options?.length).map((i) => [i.id, i]));
  const decisionForm = (i: Board["instructions"][number]) => {
    const buttons = i.options!.map((o) => `<button type="submit" name="option" value="${esc(o)}"${o === i.default ? ' class="default"' : ""}${opts.canDecide === false ? " disabled" : ""}>${esc(o)}${o === i.default ? " <small>default</small>" : ""}</button>`).join(" ");
    const hint = opts.canDecide === false ? ` <span class="meta">to click, open <code>/?token=…</code> once</span>` : "";
    return `<form class="decide" method="post" action="/decide"><input type="hidden" name="id" value="${esc(i.id)}">${buttons}${hint}</form>`;
  };
  out.push(`<section id="needs-human"><h2>Needs human <span class="count">${b.needs_human.length}</span></h2>`);
  if (b.needs_human.length) {
    out.push(`<ul>`);
    for (const n of b.needs_human) {
      const ask = n.kind === "instruction" ? asks.get(n.id) : undefined;
      const summary = ask ? esc(n.summary.replace(/\s+\[[^\]]*\]$/, "")) : esc(n.summary);
      out.push(`<li><span class="tag ${esc(n.kind)}">${esc(n.kind)}</span> ${summary} <span class="meta">${t(n.since)} · <code>${esc(n.id)}</code></span>${ask ? decisionForm(ask) : ""}</li>`);
    }
    out.push(`</ul>`);
  } else out.push(`<p class="empty">nothing</p>`);
  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) {
    out.push(`<h3>Decided</h3><ul>`);
    for (const i of decided.slice(-5)) out.push(`<li>${esc(i.from)} → ${esc(i.to)}: ${esc(i.body)} <b>⇒ ${esc(i.chosen!.option)}</b> <span class="meta">${esc(i.chosen!.by)}, ${t(i.chosen!.at)} · <code>${esc(i.id)}</code></span></li>`);
    out.push(`</ul>`);
  }
  out.push(`</section>`);

  const open = b.instructions.filter((i) => i.status !== "acked");
  out.push(`<section id="instructions"><h2>Open instructions <span class="count">${open.length}</span></h2>`);
  if (open.length) {
    out.push(`<table><thead><tr><th>status</th><th>from → to</th><th>body</th><th>sent</th><th>delivered</th></tr></thead><tbody>`);
    for (const i of open) {
      const ask = i.options?.length ? `<div class="meta">options: ${i.options.map((o) => esc(o)).join(" | ")}${i.default ? ` (default ${esc(i.default)})` : ""}</div>` : "";
      out.push(`<tr class="${esc(i.status)}"><td><span class="tag ${esc(i.status)}">${esc(i.status)}</span></td><td>${esc(i.from)} → ${esc(i.to)}</td><td>${esc(i.body)}${ask}<div class="meta"><code>${esc(i.id)}</code></div></td><td>${t(i.sent)}</td><td>${i.delivered ? t(i.delivered) : "<span class=\"meta\">not yet pulled</span>"}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  } else out.push(`<p class="empty">none</p>`);
  out.push(`</section>`);

  const total = Object.values(b.tasks).reduce((n, xs) => n + xs.length, 0);
  out.push(`<section id="tasks"><h2>Tasks <span class="count">${total}</span></h2>`);
  if (!total) out.push(`<p class="empty">none</p>`);
  for (const status of STATUS_ORDER) {
    const list = b.tasks[status] ?? [];
    if (!list.length) continue;
    out.push(`<h3>${esc(status)} <span class="count">${list.length}</span></h3><ul class="tasks">`);
    for (const task of list) {
      const st = s.tasks.get(task.id);
      const bits: string[] = [];
      if (task.owner) bits.push(`@${esc(task.owner)}`);
      if (task.blocked_on) bits.push(`⏸ ${esc(task.blocked_on)}`);
      if (task.verified_on?.length) bits.push(`✓ ${esc(task.verified_on.join(", "))}`);
      out.push(`<li><details${status === "verified" ? "" : " open"}><summary><code>${esc(task.id)}</code> ${esc(task.title)}${bits.length ? ` <span class="meta">${bits.join(" · ")}</span>` : ""}</summary>`);
      if (st) {
        out.push(`<div class="meta">criteria by ${esc(st.criteria_by)}, created ${t(st.created_at)}</div>`);
        out.push(`<ol class="criteria">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>`);
        if (st.touches.length) out.push(`<div class="meta">touches: ${st.touches.map((x) => `<code>${esc(x)}</code>`).join(", ")}</div>`);
        if (st.evidence) out.push(`<div class="meta">evidence: ${esc(st.evidence)}</div>`);
        for (const n of st.notes.filter((n) => /^\s*evidence:/i.test(n.body))) out.push(`<div class="meta">+ ${esc(n.body.replace(/^\s*evidence:\s*/i, ""))} <span class="meta">(${esc(n.actor)}, ${t(n.at)})</span></div>`);
        for (const v of st.verifications) out.push(`<div class="meta">${v.pass ? "✓ verified" : "✗ failed"} on <b>${esc(v.surface)}</b> by ${esc(v.by)} ${t(v.at)}${v.evidence ? `: ${esc(v.evidence)}` : ""}</div>`);
        if (st.notes.length) {
          out.push(`<ul class="notes">`);
          for (const n of st.notes) out.push(`<li><b>${esc(n.actor)}</b> ${t(n.at)}${n.decision ? ' <span class="tag acked">decision</span>' : ""}: ${esc(n.body)}</li>`);
          out.push(`</ul>`);
        }
      }
      out.push(`</details></li>`);
    }
    out.push(`</ul>`);
  }
  out.push(`</section>`);

  const openSeams = b.seams.filter((x) => !x.resolved);
  const closedSeams = b.seams.filter((x) => x.resolved);
  out.push(`<section id="seams"><h2>Seams <span class="count">${openSeams.length} open</span></h2>`);
  if (b.seams.length) {
    out.push(`<ul>`);
    for (const x of openSeams) out.push(`<li><span class="tag open_seam">open</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> both touch ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`);
    for (const x of closedSeams) out.push(`<li class="resolved"><span class="tag acked">resolved by ${esc(x.resolved!)}</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> on ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`);
    out.push(`</ul>`);
  } else out.push(`<p class="empty">none</p>`);
  out.push(`</section>`);

  const valid = b.readings.filter((r) => r.valid);
  const stale = b.readings.filter((r) => !r.valid);
  out.push(`<section id="readings"><h2>Readings <span class="count">${valid.length} valid, ${stale.length} stale</span></h2>`);
  if (b.readings.length) {
    out.push(`<table><thead><tr><th></th><th>surface:key</th><th>value</th><th>by</th><th>when</th><th>notes</th></tr></thead><tbody>`);
    for (const r of [...valid, ...stale]) {
      out.push(`<tr class="${r.valid ? "valid" : "stale"}"><td>${r.valid ? "<span class=\"tag valid\">valid</span>" : "<span class=\"tag stale\">stale</span>"}</td><td><code>${esc(r.surface)}:${esc(r.key)}</code></td><td>${esc(str(r.value))}</td><td>${esc(r.by)}</td><td>${t(r.at)}</td><td class="meta">${[r.why ? esc(r.why) : "", r.assumptions?.length ? `assumes: ${esc(r.assumptions.join("; "))}` : ""].filter(Boolean).join(" · ")}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  } else out.push(`<p class="empty">none</p>`);
  out.push(`</section>`);

  out.push(`<section id="presence"><h2>Presence</h2>`);
  if (b.presence.length) {
    out.push(`<ul class="presence">`);
    for (const p of b.presence) out.push(`<li class="${p.idle_s > 600 ? "away" : "here"}"><b>${esc(p.actor)}</b> ${t(p.last_seen)}</li>`);
    out.push(`</ul>`);
  } else out.push(`<p class="empty">nobody yet</p>`);
  out.push(`</section>`);

  return page(out.join("\n"), { now: b.now, refresh, sha: opts.sha });
}

function page(body: string, m: { now: string; refresh: number; sha?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${m.refresh}">
<title>aTeam board</title>
<style>
:root { color-scheme: light dark; --fg: #1a1a1a; --bg: #fafaf7; --muted: #6b6b6b; --line: #e3e3de; --card: #ffffff; --accent: #2f6fed; --warn: #b45309; --bad: #b91c1c; --good: #15803d; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --bg: #141414; --muted: #9a9a9a; --line: #2c2c2c; --card: #1d1d1d; --accent: #7aa2ff; --warn: #f59e0b; --bad: #f87171; --good: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem; font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); max-width: 72rem; margin-inline: auto; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
header h1 { margin: 0; font-size: 1.25rem; letter-spacing: .02em; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }
h2 { margin: 0 0 .5rem; font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
h3 { margin: 1rem 0 .25rem; font-size: .9rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.count { font-weight: normal; color: var(--muted); text-transform: none; letter-spacing: 0; }
.focus { font-size: 1.35rem; margin: .25rem 0; }
.meta, .empty { color: var(--muted); font-size: .85rem; }
.empty { font-style: italic; }
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
ul.presence { display: flex; flex-wrap: wrap; gap: .5rem 1.5rem; }
ul.presence li.away { color: var(--muted); }
#needs-human li { padding: .2rem 0; }
.tag { display: inline-block; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; padding: .1em .45em; border-radius: 999px; border: 1px solid currentColor; }
.tag.instruction, .tag.pending, .tag.delivered { color: var(--accent); }
.tag.overdue, .tag.open_seam, .tag.stale { color: var(--bad); }
.tag.valid, .tag.acked { color: var(--good); }
form.decide { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin: .35rem 0 .2rem 1.6rem; }
form.decide button { font: inherit; padding: .3rem .8rem; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
form.decide button.default { border-color: var(--accent); color: var(--accent); }
form.decide button:disabled { cursor: not-allowed; opacity: .55; }
form.decide small { font-size: .7em; text-transform: uppercase; letter-spacing: .05em; }
footer { color: var(--muted); font-size: .8rem; display: flex; gap: 1rem; flex-wrap: wrap; }
</style>
</head>
<body>
<header><h1>aTeam board</h1><span class="meta">refreshes every ${m.refresh}s · rendered <time datetime="${esc(m.now)}">${esc(m.now.replace("T", " ").slice(0, 19))}Z</time></span></header>
${body}
<footer><span>server sha <code>${esc(m.sha ?? "unknown")}</code></span><span>same data as <code>GET /board</code></span></footer>
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
