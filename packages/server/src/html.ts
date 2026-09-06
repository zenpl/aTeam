import type { Board, BoardSaid, State } from "@ateam/core";
import { UI } from "./i18n.js";

/**
 * 牌桌 v2 (docs/board.md, pd). The human sits here three minutes a day to do two things: clear what waits on
 * them, and glance at the world. Three layers: 一眼 (cards, focus, counts, the live line), 读 (working/blocked
 * lists, who is here), 挖 (everything else, folded). One red (需要你), one primary button per thing to do,
 * amber only for blocked/overdue, green only for verified on production. No script; forms only.
 */
export const REFRESH_SECONDS = 30;
/** Any list expanded by default shows at most this many rows; the rest folds into 「还有 N 件」. */
export const SHOWN = 5;
export const SAID_SHOWN = 5;
/** A first sentence up to this long is the card's title; the rest goes under 细节. */
export const TITLE_MAX = 30;
/** How long 「你刚定了」 stays on the page after the human answered. */
const JUST_MS = 60 * 60_000;

export interface RenderOptions { sha?: string; refresh?: number; canDecide?: boolean; human?: string }

export type Kind = "ask" | "do" | "tell";
/** What kind of card an instruction to the human is. Options → 问你; asked to act → 请你做; else 告诉你. */
export function kindOf(i: { body: string; options?: string[] }): Kind {
  if (i.options?.length) return "ask";
  const b = i.body.trim();
  return /^(请|把|去|帮|麻烦|需要你|你来|由你)|请(你|把|在|去|看|读|点|运行|执行|合并|部署|推|开|打开|确认|回复|检查|改)/.test(b) ? "do" : "tell";
}

/** The board says the kind (t-036: ask | do | info); an older board leaves it to kindOf. */
export function cardKind(i: { body: string; options?: string[]; kind?: string }): Kind {
  if (i.kind === "ask" || i.kind === "do") return i.kind;
  if (i.kind === "info") return "tell";
  return kindOf(i);
}

/** The board's title/detail (t-036); an empty title means the first sentence was too long, so the whole text is the title. */
export function cardTitle(i: { body: string; title?: string; detail?: string }): { title: string; detail: string } {
  if (i.title !== undefined && i.detail !== undefined) return i.title ? { title: i.title, detail: i.detail } : { title: i.detail || i.body, detail: "" };
  return splitTitle(i.body);
}

const ENDERS = /[。！？\n]/;
const COLONS = /[：:]/;
/**
 * Title = the first sentence when it is short (docs/board.md: ≤30 chars); the rest is detail.
 * A sentence ends at 。！？ or a line break; failing that, a colon splits an action from its details.
 */
export function splitTitle(body: string): { title: string; detail: string } {
  const text = body.trim();
  const tryAt = (re: RegExp, keepMark: boolean) => {
    const m = re.exec(text);
    if (!m) return null;
    const head = text.slice(0, m.index).trim(), rest = text.slice(m.index + 1).trim();
    if (!head || !rest || [...head].length > TITLE_MAX) return null;
    return { title: head + (keepMark && /[！？]/.test(m[0]) ? m[0] : ""), detail: rest };
  };
  return tryAt(ENDERS, true) ?? tryAt(COLONS, false) ?? { title: text, detail: "" };
}

/** A blocked reason on the first screen: ids, paths and long shas become 「…」, then clipped (board.md: 60 chars). */
export function whyLine(reason: string, max = 60): string {
  const masked = reason.replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9a-f]{8,40}\b|[\w.-]+(?:\/[\w.-]+)+/g, "…");
  return clip(masked, max);
}

export type Said = Pick<BoardSaid, "id" | "body" | "at"> & Partial<Pick<BoardSaid, "status" | "label" | "links">>;

export function saidOf(b: Board): Said[] {
  return ((b.said as Said[] | undefined) ?? []).slice().sort((x, y) => y.at.localeCompare(x.at));
}

export function saidStatus(x: Said): string {
  if (x.label) return x.label;
  const base = UI.saidStatus[x.status ?? "received"] ?? x.status ?? "";
  const titles = (x.links?.tasks ?? []).map((t) => t.title).filter(Boolean);
  return titles.length && (x.status === "task" || x.status === "live") ? `${base}：${titles.join("、")}` : base;
}

export function surface(s: string): string {
  return UI.surface[s] ?? s;
}

export function renderBoard(b: Board, s: State, opts: RenderOptions = {}): string {
  const refresh = Math.max(REFRESH_SECONDS, opts.refresh ?? REFRESH_SECONDS);
  const human = opts.human ?? "human";
  const now = Date.parse(b.now);
  const secAgo = (iso: string) => Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const ago = (iso: string) => UI.ago(secAgo(iso));
  const t = (iso: string) => `<time datetime="${esc(iso)}" title="${esc(iso)}">${esc(ago(iso))}</time>`;
  const canDecide = opts.canDecide !== false;
  // Buttons are always clickable. Without the cookie, a form posts to the token page, which does the action after the token.
  const form = (action: string, cls: string, fields: string, inner: string) =>
    canDecide
      ? `<form class="${cls}" method="post" action="${action}">${fields}${inner}</form>`
      : `<form class="${cls}" method="post" action="/token"><input type="hidden" name="then" value="${esc(action)}">${fields}${inner}</form>`;

  const out: string[] = [];

  // ---------- 需要你 ----------
  const asks = b.needs_human.filter((n) => !n.chosen);
  if (asks.length) {
    out.push(`<section class="needs" id="needs-you"><h2>${UI.needsYou} <span class="count">${asks.length}</span></h2>`);
    for (const i of asks) {
      const kind = cardKind(i);
      const { title, detail } = cardTitle(i);
      out.push(`<article class="ask" data-kind="${kind}"><div class="ask-top"><span class="kind">${esc(UI.kind[kind])}</span><span class="meta">${esc(UI.askedBy(i.from, ago(i.since)))}</span></div>`);
      out.push(`<p class="q">${esc(title)}</p>`);
      if (detail) out.push(`<details class="detail"><summary>${UI.detail}</summary><p>${esc(detail)}</p></details>`);
      const id = `<input type="hidden" name="id" value="${esc(i.id)}">`;
      if (kind === "ask") {
        const buttons = i.options!.map((o) => `<button class="btn${o === i.default ? " primary" : ""}" type="submit" name="option" value="${esc(o)}">${esc(o)}${o === i.default ? ` <small>${UI.defaultTag}</small>` : ""}</button>`).join("");
        out.push(form("/decide", "actions", id, `${buttons}${i.default ? `<span class="hint">${esc(UI.ifNothing(i.default))}</span>` : ""}`));
      } else if (kind === "do") {
        // 做好了 = ack; 先不做 = ack with a note (POST /ack, t-036). Both go through the token page when anonymous.
        out.push(form("/ack", "actions", id, `<button class="btn primary" type="submit">${UI.didIt}</button><button class="btn" type="submit" name="note" value="${esc(UI.notNowWhy)}">${UI.notNow}</button>`));
      } else {
        out.push(form("/ack", "actions", id, `<button class="btn primary" type="submit">${UI.gotIt}</button>`));
      }
      out.push(`</article>`);
    }
    out.push(`</section>`);
  } else {
    out.push(`<section class="needs empty" id="needs-you"><h2>${UI.needsYou}</h2><p class="quiet">${UI.nothingForYou}</p></section>`);
  }

  // 你刚定了：the human's latest answer within the hour, so they can see they clicked the right thing.
  const just = b.instructions
    .filter((i) => i.to === human && (i.chosen?.by === human || (i.status === "acked" && !i.options?.length)))
    .map((i) => ({ i, at: i.chosen?.at ?? i.acked! }))
    .filter((x) => now - Date.parse(x.at) < JUST_MS)
    .sort((x, y) => y.at.localeCompare(x.at))[0];
  if (just) {
    const { title } = cardTitle(just.i);
    const deferred = !!(just.i as { deferred?: unknown }).deferred || s.notes.some((n) => n.actor === human && n.refs?.includes(just.i.id) && n.body.startsWith("先不做"));
    const clicked = deferred ? UI.notNow : cardKind(just.i) === "do" ? UI.didIt : UI.gotIt;
    const what = just.i.chosen ? `${esc(title)} → <b>${esc(just.i.chosen.option)}</b>` : `${esc(title)} → <b>${clicked}</b>`;
    out.push(`<p class="recent">${just.i.chosen ? UI.youJust : UI.youJustDid}${what} <span class="meta">${t(just.at)}</span></p>`);
  }

  // ---------- 说一句 ----------
  out.push(`<section class="say" id="say">`);
  out.push(form("/say", "", "", `<input type="text" name="text" maxlength="500" placeholder="${esc(UI.sayPlaceholder)}" aria-label="${esc(UI.sayPlaceholder)}" autocomplete="off"><button class="btn" type="submit">${UI.say}</button>`));
  const said = saidOf(b);
  if (said.length) {
    const line = (x: Said) => `<li><span class="said-body">${esc(x.body)}</span> <span class="meta">${t(x.at)} · ${esc(saidStatus(x))}</span></li>`;
    out.push(`<div class="said"><div class="grp-h">${UI.said}</div><ul class="plain">${said.slice(0, SAID_SHOWN).map(line).join("")}</ul>${fold(said.slice(SAID_SHOWN).map(line), UI.moreSaid)}</div>`);
  } else out.push(`<p class="meta">${UI.sayHint}</p>`);
  out.push(`</section>`);

  // ---------- 现在 ----------
  out.push(`<section class="now" id="now"><h2>${UI.now}</h2>`);
  out.push(`<div class="focus"><span class="label">${UI.focus}</span>${b.focus ? `<p class="focus-text">${esc(str(b.focus.body))}</p><span class="meta">${esc(UI.setBy(b.focus.set_by, ago(b.focus.at)))}</span>` : `<p class="focus-text quiet">${UI.noFocus}</p>`}</div>`);

  const sha = b.live.deployed_sha ? String(b.live.deployed_sha).slice(0, 7) : null;
  const shaReading = b.readings.find((r) => r.valid && r.surface === "production" && r.key === "deployed.sha");
  const onProd = b.live.verified_on_production.length;
  out.push(`<div class="row"><span class="label">${UI.live}</span><div class="val">`);
  if (sha) {
    out.push(`<div class="line"><code class="sha">${esc(sha)}</code>${onProd ? ` <span class="ok">${esc(UI.verifiedCount(onProd))}</span>` : ` <span class="meta">${UI.noneOnProduction}</span>`}${shaReading ? ` <span class="meta">· ${esc(UI.checkedBy(shaReading.by, ago(shaReading.at)))}</span>` : ""}</div>`);
    if (b.live.recent.length || b.live.earlier.length) {
      out.push(`<details class="more-list"><summary>${UI.thisVersion}${b.live.since_sha ? ` <span class="meta">${esc(UI.sinceLast(String(b.live.since_sha).slice(0, 7)))}</span>` : ""}</summary><ul class="plain">${b.live.recent.map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul>${b.live.earlier.length ? `<details class="more-list"><summary>${esc(UI.earlier(b.live.earlier.length))}</summary><ul class="plain">${b.live.earlier.map((x) => `<li>${esc(x.title)}</li>`).join("")}</ul></details>` : ""}</details>`);
    }
  } else out.push(`<span class="quiet">${UI.noDeployReading}</span>`);
  out.push(`</div></div>`);

  const flight = inFlightOf(b);
  out.push(`<div class="row"><span class="label">${UI.inFlight}</span><div class="val">`);
  if (flight.some((g) => g.total)) {
    out.push(`<div class="chips">${flight.filter((g) => g.total).map((g) => `<span class="chip${g.key === "blocked" ? " warn" : ""}"><b>${g.total}</b> ${esc(g.label)}</span>`).join("")}</div>`);
    const row = (x: FlightItem) => `<li${x.blocked ? ' class="warn"' : ""}><span class="dot"></span><span class="ttl">${esc(x.title)}</span>${x.owner ? `<span class="who">${esc(x.owner)}</span>` : "<span></span>"}${x.why ? `<span class="why">${esc(x.why)}</span>` : ""}</li>`;
    for (const g of flight.filter((g) => g.total)) {
      if (g.key === "working" || g.key === "blocked") {
        out.push(`<div class="grp"><div class="grp-h">${esc(g.label)}</div><ul class="tasks">${g.items.slice(0, SHOWN).map(row).join("")}</ul>${fold(g.items.slice(SHOWN).map(row), UI.moreItems, "tasks")}</div>`);
      } else {
        out.push(`<details class="grp"><summary class="grp-h">${esc(g.label)} <span class="meta">${esc(UI.items(g.total))}</span></summary><ul class="tasks">${g.items.map(row).join("")}</ul></details>`);
      }
    }
  } else out.push(`<span class="quiet">${UI.nothingInFlight}</span>`);
  out.push(`</div></div>`);

  out.push(`<div class="row"><span class="label">${UI.who}</span><div class="val chips">${b.presence.length ? b.presence.map((p) => `<span class="who-chip${p.idle_s > 600 ? " away" : ""}"><i></i>${esc(p.actor)}<span class="meta">${t(p.last_seen)}</span></span>`).join("") : `<span class="quiet">${UI.nobody}</span>`}</div></div>`);
  out.push(`</section>`);

  // ---------- 其余 ----------
  out.push(renderRest(b, s, human, t, ago));

  return page(out.join("\n"), { now: b.now, refresh, sha: opts.sha });
}

interface FlightItem { title: string; owner?: string; blocked?: boolean; why?: string }

/** The in-flight groups: a count each, and rows. working/blocked are read; the others are dug. */
export function inFlightOf(b: Board): { key: string; label: string; total: number; items: FlightItem[] }[] {
  const g = (k: string): FlightItem[] => (b.in_flight[k]?.all ?? []).map((x) => {
    const task = (b.tasks[k] ?? []).find((tk) => tk.id === x.id);
    return { title: x.title, owner: x.owner, blocked: k === "blocked", why: k === "blocked" && task?.blocked_on ? whyLine(task.blocked_on) : undefined };
  });
  const elsewhere = (b.tasks.verified ?? []).filter((tk) => !tk.verified_on?.includes("production")).map((tk) => ({ title: tk.title, owner: tk.owner }));
  const groups = [
    { key: "working", label: UI.groups.working, items: sortRecent(b, "working", g("working")) },
    { key: "blocked", label: UI.groups.blocked, items: sortRecent(b, "blocked", g("blocked")) },
    { key: "done", label: UI.groups.done, items: g("done") },
    { key: "open", label: UI.groups.open, items: g("open") },
    { key: "failed", label: UI.groups.failed, items: g("failed") },
    { key: "verifiedElsewhere", label: UI.groups.verifiedElsewhere, items: elsewhere },
  ];
  return groups.map((x) => ({ ...x, total: x.items.length }));
}

/** The board's `shown` order (most recently touched first) for the groups the page expands. */
function sortRecent(b: Board, k: string, items: FlightItem[]): FlightItem[] {
  const order = new Map((b.in_flight[k]?.all ?? []).slice().sort((x, y) => y.updated_at.localeCompare(x.updated_at) || y.id.localeCompare(x.id)).map((x, i) => [x.title, i]));
  return items.slice().sort((x, y) => (order.get(x.title) ?? 0) - (order.get(y.title) ?? 0));
}

function clip(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : chars.slice(0, n).join("") + "…";
}

/** The rest of a list behind a one-line toggle. Empty when there is nothing to fold. */
function fold(rows: string[], label: (n: number) => string, listClass = "plain"): string {
  if (!rows.length) return "";
  return `<details class="more-list"><summary>${esc(label(rows.length))}</summary><ul class="${listClass}">${rows.join("")}</ul></details>`;
}

function renderRest(b: Board, s: State, human: string, t: (iso: string) => string, ago: (iso: string) => string): string {
  const d: string[] = [];
  const open = b.instructions.filter((i) => i.status !== "acked" && i.to !== human && !i.chosen);
  const openSeams = b.seams.filter((x) => x.open);
  const valid = b.readings.filter((r) => r.valid), stale = b.readings.filter((r) => !r.valid);
  const why = (r: Board["readings"][number]) => !r.why ? "" : r.why.startsWith("superseded by") ? `${UI.supersededBy} <code>${esc(r.why.slice(14))}</code>` : r.why.startsWith("invalidated by") ? `${UI.invalidatedBy} <code>${esc(r.why.slice(15))}</code>` : UI.expired;

  d.push(`<details class="rest" id="rest"><summary>${UI.rest} <span class="meta">${esc(UI.restSummary(open.length, b.overdue.length, openSeams.length, valid.length))}</span></summary>`);

  d.push(`<section id="overdue"><h3>${UI.overdue} <span class="meta">${b.overdue.length}</span></h3>`);
  d.push(b.overdue.length ? `<ul class="plain">${b.overdue.map((i) => `<li><span class="tag warn">${UI.instrStatus.overdue}</span> ${esc(UI.overdueLine(i.to, i.body, i.from))} <span class="meta">（${esc(UI.due(ago(i.ack_by)))} · <code>${esc(i.instruction)}</code>）</span></li>`).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  d.push(`</section>`);

  d.push(`<section id="instructions"><h3>${UI.agentInstructions} <span class="meta">${open.length}</span></h3>`);
  d.push(open.length ? `<ul class="plain">${open.map((i) => `<li><span class="tag">${esc(UI.instrStatus[i.status] ?? i.status)}</span> ${esc(i.from)} → ${esc(i.to)}：${esc(i.body)} <span class="meta">${t(i.sent)}${i.delivered ? "" : ` · ${UI.notPulled}`} · <code>${esc(i.id)}</code></span></li>`).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) d.push(`<h4>${UI.decided}</h4><ul class="plain">${decided.slice(-5).map((i) => `<li>${esc(i.from)} → ${esc(i.to)}：${esc(i.body)} <b>${esc(i.chosen!.by === "default" ? UI.decidedByDefault(i.chosen!.option) : UI.chosen(i.chosen!.by, i.chosen!.option))}</b><span class="meta">，${t(i.chosen!.at)} · <code>${esc(i.id)}</code></span></li>`).join("")}</ul>`);
  d.push(`</section>`);

  const total = Object.values(b.tasks).reduce((n, xs) => n + xs.length, 0);
  d.push(`<section id="tasks"><h3>${UI.tasks} <span class="meta">${total}</span></h3>`);
  for (const status of ["blocked", "working", "done", "failed", "open", "verified", "withdrawn"]) {
    const list = b.tasks[status] ?? [];
    if (!list.length) continue;
    d.push(`<h4>${esc(UI.taskStatus[status] ?? status)} <span class="meta">${list.length}</span></h4><ul class="tasks detail-tasks">`);
    for (const task of list) {
      const st = s.tasks.get(task.id);
      const bits: string[] = [];
      if (task.owner) bits.push(`@${esc(task.owner)}`);
      if (task.blocked_on) bits.push(`⏸ ${esc(task.blocked_on)}`);
      if (task.verified_on?.length) bits.push(`✓ ${esc(task.verified_on.map(surface).join("、"))}`);
      d.push(`<li><details><summary><code>${esc(task.id)}</code> ${esc(task.title)}${bits.length ? ` <span class="meta">${bits.join(" · ")}</span>` : ""}</summary>`);
      if (st) {
        d.push(`<div class="meta">${esc(UI.criteriaBy(st.criteria_by, ago(st.created_at)))}</div>`);
        d.push(`<ol class="criteria">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>`);
        if (st.touches.length) d.push(`<div class="meta">${UI.touches}：${st.touches.map((x) => `<code>${esc(x)}</code>`).join(", ")}</div>`);
        if (st.evidence) d.push(`<div class="meta">${UI.evidence}：${esc(st.evidence)}</div>`);
        for (const n of st.notes.filter((n) => /^\s*evidence:/i.test(n.body))) d.push(`<div class="meta">+ ${esc(n.body.replace(/^\s*evidence:\s*/i, ""))} <span class="meta">（${esc(n.actor)}，${t(n.at)}）</span></div>`);
        for (const v of st.verifications) d.push(`<div class="meta">${v.pass ? `✓ ${UI.verifiedOn}` : `✗ ${UI.failedOn}`} <b>${esc(surface(v.surface))}</b>，${UI.by} ${esc(v.by)}，${t(v.at)}${v.evidence ? `：${esc(v.evidence)}` : ""}</div>`);
        if (st.withdrawn) d.push(`<div class="meta">${esc(UI.withdrawnBy(st.withdrawn.by, ago(st.withdrawn.at)))}：${esc(st.withdrawn.reason)}</div>`);
        if (st.notes.length) d.push(`<ul class="notes">${st.notes.map((n) => `<li><b>${esc(n.actor)}</b> ${t(n.at)}${n.decision ? ` <span class="tag">${UI.decisionTag}</span>` : ""}：${esc(n.body)}</li>`).join("")}</ul>`);
      }
      d.push(`</details></li>`);
    }
    d.push(`</ul>`);
  }
  if (!total) d.push(`<p class="quiet">${UI.none}</p>`);
  d.push(`</section>`);

  d.push(`<section id="seams"><h3>${UI.seams} <span class="meta">${esc(UI.openCount(openSeams.length))}</span></h3>`);
  d.push(b.seams.length ? `<ul class="plain">${[...openSeams, ...b.seams.filter((x) => !x.open)].map((x) => `<li><span class="tag${x.open ? " warn" : ""}">${x.open ? UI.seamOpen : x.resolved ? esc(UI.seamResolvedBy(x.resolved)) : UI.seamStacked}</span> <code>${esc(x.tasks[0])}</code> + <code>${esc(x.tasks[1])}</code> ${UI.bothTouch} ${x.overlap.map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  d.push(`</section>`);

  d.push(`<section id="readings"><h3>${UI.readings} <span class="meta">${esc(UI.readingCount(valid.length, stale.length))}</span></h3>`);
  d.push(b.readings.length ? `<ul class="plain">${[...valid, ...stale].map((r) => `<li><span class="tag${r.valid ? "" : " stale"}">${r.valid ? UI.valid : UI.stale}</span> <code>${esc(r.surface)}:${esc(r.key)}</code> = ${esc(str(r.value))} <span class="meta">${esc(r.by)}，${t(r.at)}${[why(r), r.assumptions?.length ? `${UI.assumes}：${esc(r.assumptions.join("；"))}` : ""].filter(Boolean).map((x) => ` · ${x}`).join("")}</span></li>`).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  d.push(`</section>`);

  d.push(`</details>`);
  return d.join("\n");
}

export function unauthorizedPage(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${UI.title}</title></head><body style="font:15px/1.7 system-ui;padding:2rem"><h1>${UI.title}</h1><p>${UI.unauthorized} <code>/?token=&lt;ATEAM_TOKEN&gt;</code>${UI.unauthorizedTail}</p></body></html>`;
}

/** The token page: the only thing on it is a token box; the hidden fields carry the action the human clicked. */
export function tokenPage(fields: Record<string, string>, wrong = false): string {
  const hidden = Object.entries(fields).filter(([k]) => k !== "token").map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${UI.tokenTitle} · ${UI.title}</title>
<style>${CSS}</style></head>
<body><main class="token-page"><header><h1>${UI.header}</h1></header>
<section class="now"><h2>${UI.tokenTitle}</h2><p>${UI.tokenLead}</p>${wrong ? `<p class="why">${UI.tokenWrong}</p>` : ""}
<form method="post" action="/token" class="line">${hidden}<input type="password" name="token" aria-label="${UI.tokenLabel}" autofocus autocomplete="off" required><button class="btn primary" type="submit">${UI.tokenSubmit}</button></form>
</section></main></body></html>
`;
}

const CSS = `
:root { color-scheme: light dark;
  --paper:#F6F7F4; --card:#FFFFFF; --ink:#1B1F1D; --muted:#5F6663; --line:#DCE0DB; --soft:#ECEFEA;
  --accent:#0F6E63; --accent-ink:#FFFFFF; --alert:#B42318; --warn:#B7791F; --good:#2F7D4F;
  --serif:"Noto Serif SC","Songti SC","SimSun","Source Han Serif SC",serif;
  --sans:"Noto Sans SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,-apple-system,sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
@media (prefers-color-scheme: dark) { :root {
  --paper:#141715; --card:#1C201E; --ink:#E8EAE6; --muted:#9AA29D; --line:#2B302D; --soft:#232826;
  --accent:#4FB3A5; --accent-ink:#0E1512; --alert:#F08A7E; --warn:#E2B15C; --good:#7CC493; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--paper); color:var(--ink); font:15px/1.7 var(--sans); }
main { max-width:52rem; margin:0 auto; padding:1.5rem 1.25rem 4rem; display:flex; flex-direction:column; gap:1.25rem; }
header { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; flex-wrap:wrap; }
header h1 { margin:0; font:600 1.05rem/1.4 var(--sans); letter-spacing:.04em; }
.meta { color:var(--muted); font-size:.82rem; }
.quiet { margin:0; color:var(--muted); }
h2 { margin:0 0 .75rem; font:600 .95rem/1.4 var(--sans); letter-spacing:.06em; color:var(--ink); display:flex; align-items:center; gap:.5rem; }
h2::after { content:""; flex:1; height:1px; background:var(--line); }
h3 { margin:1rem 0 .4rem; font:600 .9rem/1.4 var(--sans); letter-spacing:.04em; }
h4 { margin:.75rem 0 .25rem; font:500 .85rem/1.4 var(--sans); color:var(--muted); }
.count { font-variant-numeric:tabular-nums; color:#fff; background:var(--alert); border-radius:999px; padding:0 .55em; font-size:.8rem; line-height:1.6; }
.needs { display:flex; flex-direction:column; gap:.75rem; }
.needs.empty { flex-direction:row; align-items:baseline; gap:.75rem; }
.needs.empty h2 { margin:0; color:var(--muted); } .needs.empty h2::after { display:none; }
.ask { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--alert); border-radius:8px; padding:1rem 1.25rem 1.1rem; }
.ask-top { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; }
.kind { font-size:.78rem; letter-spacing:.08em; color:var(--alert); font-weight:600; }
.q { margin:.35rem 0 .85rem; font:500 1.2rem/1.65 var(--serif); text-wrap:balance; max-width:38em; }
.actions { display:flex; flex-wrap:wrap; gap:.5rem; align-items:center; }
.btn { font:500 .95rem/1 var(--sans); padding:.6rem 1.1rem; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
.btn small { font-size:.75em; letter-spacing:.05em; }
.btn:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.detail { margin:-.4rem 0 .8rem; } .detail summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
.detail p { margin:.25rem 0 0; color:var(--muted); font-size:.9rem; max-width:40em; white-space:pre-wrap; }
.hint { margin-left:.5rem; color:var(--muted); font-size:.85rem; }
.recent { margin:-.25rem 0 0; padding-left:1.25rem; color:var(--muted); font-size:.85rem; } .recent b { color:var(--ink); }
.say form { display:flex; gap:.5rem; }
.say input { flex:1; min-width:0; font:inherit; padding:.6rem .9rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); }
.say .meta, .say .said { margin:.35rem 0 0 .25rem; }
.said .grp-h { margin-top:.5rem; }
.said .said-body { color:var(--ink); }
.now { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:1.1rem 1.25rem 1.25rem; display:flex; flex-direction:column; gap:1rem; }
.focus { display:grid; grid-template-columns:4.5em 1fr; gap:.15rem .75rem; align-items:baseline; padding-bottom:1rem; border-bottom:1px solid var(--line); }
.focus .meta { grid-column:2; }
.focus-text { margin:0; font:500 1.05rem/1.7 var(--serif); }
.label { color:var(--muted); font-size:.82rem; letter-spacing:.06em; padding-top:.2rem; }
.row { display:grid; grid-template-columns:4.5em 1fr; gap:.75rem; align-items:start; }
.val { min-width:0; }
.line { display:flex; flex-wrap:wrap; gap:.5rem; align-items:baseline; }
.sha, code { font:.85rem var(--mono); background:var(--soft); padding:.1em .4em; border-radius:4px; }
.ok { color:var(--good); font-weight:500; }
.more-list summary, .grp summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
.more-list { margin-top:.25rem; }
ul.plain { margin:.25rem 0 0; padding-left:1.1rem; color:var(--muted); font-size:.9rem; }
ul.plain li { padding:.1rem 0; }
.chips { display:flex; flex-wrap:wrap; gap:.4rem .6rem; }
.chip { font-size:.85rem; padding:.15em .65em; border-radius:999px; background:var(--soft); color:var(--ink); font-variant-numeric:tabular-nums; }
.chip b { font-weight:600; }
.chip.warn { background:color-mix(in srgb, var(--warn) 16%, transparent); color:var(--warn); }
.grp { margin-top:.6rem; }
.grp-h { font-size:.85rem; color:var(--muted); letter-spacing:.04em; }
ul.tasks { list-style:none; margin:.25rem 0 0; padding:0; display:flex; flex-direction:column; gap:.2rem; }
ul.tasks li { display:grid; grid-template-columns:auto 1fr auto; gap:.2rem .6rem; align-items:baseline; }
ul.detail-tasks li { display:block; padding:.2rem 0; border-top:1px solid var(--line); }
.dot { width:.5rem; height:.5rem; border-radius:50%; background:var(--accent); display:inline-block; position:relative; top:-.05rem; }
li.warn .dot { background:var(--warn); }
.ttl { min-width:0; overflow-wrap:anywhere; }
.who { font-size:.8rem; color:var(--muted); background:var(--soft); padding:0 .5em; border-radius:999px; }
.why { grid-column:2 / -1; color:var(--warn); font-size:.85rem; }
.who-chip { display:inline-flex; align-items:center; gap:.4rem; font-size:.9rem; }
.who-chip i { width:.55rem; height:.55rem; border-radius:50%; background:var(--good); }
.who-chip.away { color:var(--muted); } .who-chip.away i { background:var(--line); }
.who-chip .meta { font-size:.78rem; }
.rest { border-top:1px solid var(--line); padding-top:.75rem; }
.rest > summary { cursor:pointer; color:var(--muted); font-size:.9rem; }
.rest section { padding:.25rem 0; }
.tag { display:inline-block; font-size:.75rem; padding:.05em .45em; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
.tag.warn { color:var(--warn); border-color:currentColor; }
.tag.stale { text-decoration:line-through; }
ol.criteria { margin:.25rem 0 .5rem; padding-left:1.5rem; font-size:.9rem; }
ul.notes { margin:.35rem 0 .25rem; padding-left:1rem; font-size:.9rem; border-left:2px solid var(--line); list-style:none; }
footer { color:var(--muted); font-size:.8rem; display:flex; gap:1rem; flex-wrap:wrap; }
.token-page input[type=password] { flex:1; min-width:12rem; font:inherit; padding:.6rem .9rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); }
@media (prefers-reduced-motion: reduce) { * { transition:none !important; } }
@media (max-width:540px) { .row, .focus { grid-template-columns:1fr; } .focus .meta { grid-column:1; } }
`;

function page(body: string, m: { now: string; refresh: number; sha?: string }): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${m.refresh}">
<title>${UI.header}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header><h1>${UI.header}</h1><span class="meta">${UI.refreshes(m.refresh)} · <time datetime="${esc(m.now)}">${esc(m.now.replace("T", " ").slice(0, 16))}Z</time></span></header>
${body}
<footer><span>${UI.buildLabel} <code class="sha">${esc((m.sha ?? "unknown").slice(0, 7))}</code></span><span>${UI.sameAs} <code>GET /board</code> ${UI.sameAsTail}</span></footer>
</main>
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
