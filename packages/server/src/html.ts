import { missingRoleOf, type Board, type BoardSaid, type State, type TaskState, boardTask, ambiguousLabels, taskHeading, CONTACT_ASK, CONTACT_FILL, CONTACT_SKIP, ALERT_WEBHOOK_KEY, PROJECT_SURFACE, MIGRATION_ASK_TITLE, MIGRATION_OK, MIGRATION_PATCH, SERVICE_ACTOR } from "@ateam/core";
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

/** `base` is the project prefix (t-041): "" for the default project, "/p/<id>" for the others; every form posts under it. */
export interface RenderOptions { sha?: string; refresh?: number; canDecide?: boolean; human?: string; base?: string; /** `?ask=alert`: show the contact card again (t-069) */ ask?: string | null }

/** The migration check card (t-095): the service's own 「搬过来了，对吗？」, whose numbers it counted itself (t-092). */
export function isMigrationCard(i: { body: string }): boolean {
  return i.body.startsWith(MIGRATION_ASK_TITLE);
}

/** Who is still patching a migration the human said was incomplete; null when nobody is (t-095). */
export function patchingRole(b: Board): string | null {
  const i = b.instructions.find((x) => x.from === SERVICE_ACTOR && x.body === MIGRATION_PATCH && x.status !== "acked");
  return i ? i.to : null;
}

/** The contact card (t-069): the instruction whose body is the S0 second question. */
export function isContactCard(i: { body: string }): boolean {
  return i.body === CONTACT_ASK;
}

/**
 * The call-out feature is off unless a project fact turns it on (pm 22:39, after the human's 「外呼地址先不做」):
 * a valid project:alert.ask, or an address already recorded as project:alert.webhook. Off means no card, no grey
 * line, no reopen path; turning it on later is one fact, not a release.
 */
export const CONTACT_ASK_KEY = "alert.ask";
export function contactEnabled(b: Board): boolean {
  return b.readings.some((r) => r.valid && r.surface === PROJECT_SURFACE && (r.key === CONTACT_ASK_KEY || r.key === ALERT_WEBHOOK_KEY) && r.value !== false && r.value !== null && r.value !== "");
}

/**
 * t-099: 「来自 <出处>」 for something carried in from another system. The value is a machine string of any shape — a path,
 * a ticket number, a message id, a URL — so it is set as code and linked only when it is a link one can follow.
 * Empty for anything created here, which must render exactly as it did before (pm's criterion 4).
 */
export function sourceLine(from: string | undefined | null): string {
  if (!from) return "";
  const value = /^https?:\/\/\S+$/i.test(from) ? `<a href="${esc(from)}"><code>${esc(from)}</code></a>` : `<code>${esc(from)}</code>`;
  return `<div class="meta from">${UI.carriedFrom} ${value}</div>`;
}

/** Machine words (a fact name, a command, a sha) inside a human sentence are set as code, so the eye can skip them. */
export function machineWords(text: string): string {
  return esc(text).replace(/\b(?:[a-z][a-z0-9]*:[a-z][a-z0-9.]*|ateam [a-z-]+|git|[0-9a-f]{7,40})\b/g, (m) => `<code>${m}</code>`);
}

/**
 * t-091: 「有 N 件已验的等一次部署」 from the counts t-078 derives, never recomputed here. Empty when nothing waits;
 * when the containment fact is missing or stale the board says why instead of inventing a number (t-078's shape).
 */
export function waitingLine(b: Board): string {
  const c = b.release?.counts;
  if (!c) return "";
  if (c.pending_deploy > 0) return c.unknown ? `${UI.waitingDeploy(c.pending_deploy).replace(/。$/, "；")}${UI.waitingAlsoUnknown(c.unknown)}` : UI.waitingDeploy(c.pending_deploy);
  if (c.unknown > 0) return UI.waitingUnknown(b.release.basis || "");
  return "";
}

/** The grey line under 线上 (pd 22:45): the truth about where a call-out would go. */
export function contactLine(address: string | null): string {
  if (!address) return UI.contactNone;
  return /^https?:\/\//i.test(address) ? UI.contactTo(address) : UI.contactEmail;
}

/** The address the call-outs use, when the fact is valid. */
export function contactOf(b: Board): string | null {
  const r = b.readings.find((r) => r.valid && r.surface === PROJECT_SURFACE && r.key === ALERT_WEBHOOK_KEY);
  return r && typeof r.value === "string" && r.value ? r.value : null;
}

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

/** The board's title/detail (t-036); an empty title means the first sentence was too long, so the title is clipped and the whole text is the detail. */
export function cardTitle(i: { body: string; title?: string; detail?: string }): { title: string; detail: string } {
  if (i.title !== undefined && i.detail !== undefined) {
    if (!i.title) return tooLong(i.detail || i.body);
    // The board drops the mark that ended the first sentence; a question keeps its 「？」 (pd review of t-034).
    const mark = i.body.trim().startsWith(i.title) ? i.body.trim().slice(i.title.length, i.title.length + 1) : "";
    return { title: /[！？!?]/.test(mark) ? i.title + mark : i.title, detail: i.detail };
  }
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
  return tryAt(ENDERS, true) ?? tryAt(COLONS, false) ?? tooLong(text);
}

/** No short first sentence: the first 30 characters and 「…」 are the title, the whole text is the detail (pd decision, 15:57). */
function tooLong(text: string): { title: string; detail: string } {
  return [...text].length <= TITLE_MAX ? { title: text, detail: "" } : { title: clip(text, TITLE_MAX), detail: text };
}

/** A blocked reason on the first screen: ids, paths and long shas become 「…」, then clipped (board.md: 60 chars). */
export function whyLine(reason: string, max = 60): string {
  const masked = reason
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b|\b[0-9a-f]{8,40}\b|[\w.-]+(?:\/[\w.-]+)+/g, "…")
    // a bracket left with nothing but 「…」 and separators goes away entirely (pd review of t-034)
    .replace(/[（(]\s*(?:…\s*[，,、;；]?\s*)+[)）]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
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
  const t = (iso: string) => `<time datetime="${esc(iso)}">${esc(ago(iso))}</time>`;
  const canDecide = opts.canDecide !== false;
  const base = opts.base ?? "";
  // Buttons are always clickable. Without the cookie, a form posts to the token page, which does the action after the key.
  const form = (action: string, cls: string, fields: string, inner: string) =>
    canDecide
      ? `<form class="${cls}" method="post" action="${esc(base + action)}">${fields}${inner}</form>`
      : `<form class="${cls}" method="post" action="${esc(base)}/token"><input type="hidden" name="then" value="${esc(action)}">${fields}${inner}</form>`;

  const out: string[] = [];

  // ---------- 需要你 ----------
  const contactOn = contactEnabled(b);
  const asks = b.needs_human.filter((n) => !n.chosen && (contactOn || !isContactCard(n)));
  const invite = inviteUrl(b);
  const roles = rolesOf(b);
  const contact = contactOf(b);
  // t-069: an input, 记下 (primary) and 先不要. On the card the buttons are the card's options (POST /decide);
  // reopened from the grey line under 线上 it posts the address alone (POST /fact) and 先不要 just goes back.
  const contactForm = (action: string, fields: string, current: string | null) => {
    const input = `<input type="text" name="value" placeholder="${esc(UI.contactPlaceholder)}" aria-label="${esc(UI.contactPlaceholder)}" autocomplete="off"${current ? ` value="${esc(current)}"` : ""}>`;
    const save = action === "/decide" ? `<button class="btn primary" type="submit" name="option" value="${esc(CONTACT_FILL)}">${UI.contactSave}</button>` : `<button class="btn primary" type="submit">${UI.contactSave}</button>`;
    const skip = action === "/decide" ? `<button class="btn" type="submit" name="option" value="${esc(CONTACT_SKIP)}">${UI.contactSkip}</button>` : `<a class="btn" href="${esc(base)}/">${UI.contactSkip}</a>`;
    return form(action, "actions contact", fields, `${input}${save}${skip}`);
  };
  const reopen = contactOn && opts.ask === "alert" && !asks.some(isContactCard);
  if (asks.length || reopen) {
    out.push(`<section class="needs" id="needs-you"><h2>${UI.needsYou} <span class="count">${asks.length + (reopen ? 1 : 0)}</span></h2>`);
    if (reopen) {
      out.push(`<article class="ask" data-kind="do"><div class="ask-top"><span class="kind">${esc(UI.kind.do)}</span></div>`);
      out.push(`<p class="q">${esc(UI.contactTitle)}</p><p class="body">${esc(UI.contactBody)}</p>`);
      out.push(contactForm("/fact", `<input type="hidden" name="key" value="${esc(ALERT_WEBHOOK_KEY)}">`, contact));
      out.push(`</article>`);
    }
    for (const i of asks) {
      const kind = cardKind(i);
      // A short question answered by 说一句 keeps its whole sentence as the title (UC-S0: 「这个项目是什么？说一句。」).
      const { title, detail } = kind === "ask" && !i.options?.length && [...i.body.trim()].length <= TITLE_MAX ? { title: i.body.trim(), detail: "" } : cardTitle(i);
      if (isContactCard(i)) {
        // t-069: 请你做, with an input. pd's title and body; the buttons are 记下 / 先不要.
        out.push(`<article class="ask" data-kind="do"><div class="ask-top"><span class="kind">${esc(UI.kind.do)}</span><span class="meta">${esc(UI.askedBy(i.from, ago(i.since)))}</span></div>`);
        out.push(`<p class="q">${esc(UI.contactTitle)}</p><p class="body">${esc(UI.contactBody)}</p>`);
      } else if (isMigrationCard(i)) {
        // t-095: the counts are the question; they are read, not folded away behind 「细节」.
        out.push(`<article class="ask" data-kind="${kind}"><div class="ask-top"><span class="kind">${esc(UI.kind[kind])}</span><span class="meta">${esc(UI.askedBy(i.from, ago(i.since)))}</span></div>`);
        out.push(`<p class="q">${esc(title)}</p><p class="body">${esc(detail)}</p>`);
      } else {
        out.push(`<article class="ask" data-kind="${kind}"><div class="ask-top"><span class="kind">${esc(UI.kind[kind])}</span><span class="meta">${esc(UI.askedBy(i.from, ago(i.since)))}</span></div>`);
        out.push(`<p class="q">${esc(title)}</p>`);
        if (detail) out.push(`<details class="detail"><summary>${UI.detail}</summary><p>${esc(detail)}</p></details>`);
      }
      const id = `<input type="hidden" name="id" value="${esc(i.id)}">`;
      if (isContactCard(i)) {
        out.push(contactForm("/decide", id, contact));
      } else if (kind === "ask" && !i.options?.length) {
        // A question with no options is answered in the 说一句 box (UC-S0: 「这个项目是什么？说一句。」).
        out.push(`<p class="hint answer">${UI.answerBelow}</p>`);
        if (invite) out.push(inviteLine(invite));
      } else if (kind === "ask") {
        // t-095: the migration card has no default; 「对」 is the primary button because it is the answer that lets the
        // importer finish, and the human is told nothing happens to the old channel until they answer.
        const primary = (o: string) => o === i.default || (isMigrationCard(i) && o === MIGRATION_OK);
        const buttons = i.options!.map((o) => `<button class="btn${primary(o) ? " primary" : ""}" type="submit" name="option" value="${esc(o)}">${esc(o)}${o === i.default ? ` <small>${UI.defaultTag}</small>` : ""}</button>`).join("");
        out.push(form("/decide", "actions", id, `${buttons}${i.default ? `<span class="hint">${esc(UI.ifNothing(i.default))}</span>` : ""}`));
      } else if (kind === "do" && missingRole(i)) {
        // UC-S7: the server's own 「<角色> 已经缺了 N 分钟…起一个 <角色>？」 card (t-043 decision B). 起好了 acks just this one;
        // the role's own instructions stay unacked for the node that comes up.
        out.push(form("/ack", "actions", id, `<button class="btn primary" type="submit">${UI.started}</button>${invite ? `<span class="hint">${UI.inviteLine}<code>${esc(invite)}</code></span>` : ""}`));
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
    const what = isMigrationCard(just.i) && just.i.chosen ? `<b>${esc(just.i.chosen.option === MIGRATION_OK ? UI.migrationOk : UI.migrationMissing(patchingRole(b)))}</b>`
      : isContactCard(just.i) && just.i.chosen
      ? (just.i.chosen.option === CONTACT_FILL && contact ? `<b>${esc(UI.contactSet(contact))}</b>` : `${esc(UI.contactTitle)} → <b>${esc(just.i.chosen.option)}</b>`)
      : just.i.chosen ? `${esc(title)} → <b>${esc(just.i.chosen.option)}</b>` : `${esc(title)} → <b>${clicked}</b>`;
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

  // t-095: the human said the migration was incomplete; the importer is patching it. One line, no button.
  const patching = patchingRole(b);
  if (patching) out.push(`<p class="meta patching">${esc(UI.migrationPatching(patching))}</p>`);

  const sha = b.live.deployed_sha ? String(b.live.deployed_sha).slice(0, 7) : null;
  const shaReading = b.readings.find((r) => r.valid && r.surface === "production" && r.key === "deployed.sha");
  const since = previousSha(b);
  // pd 22:47 (B): the count is this version's only; with nothing verified on this version there is no count at all.
  const onProd = b.live.recent.length;
  out.push(`<div class="row"><span class="label">${UI.live}</span><div class="val">`);
  if (sha) {
    // t-086: the board says where the sha came from, by the fields t-083 derives from the reading's method: who pushed it
    // (their own `release --deploy` wrote the fact), who only checked which version is live, both when both are known,
    // and neither when the fact says nothing about its source.
    const when = shaReading ? ago(shaReading.at) : "";
    const source = [
      b.live.deployed_by ? UI.pushedBy(b.live.deployed_by, when) : "",
      b.live.checked_by ? UI.checkedBy(b.live.checked_by, when) : "",
    ].filter(Boolean).map((x) => ` <span class="meta">· ${esc(x)}</span>`).join("");
    out.push(`<div class="line"><code class="sha">${esc(sha)}</code>${onProd ? ` <span class="ok">${esc(UI.verifiedCount(onProd))}</span>` : ""}${source}</div>`);
    const earlierFold = b.live.earlier.length ? `<details class="more-list"><summary>${esc(UI.earlier(b.live.earlier.length))}</summary><ul class="plain">${b.live.earlier.map((x) => `<li>${esc(x.shows ?? x.title)}</li>`).join("")}</ul></details>` : "";
    if (b.live.recent.length) {
      out.push(`<details class="more-list"><summary>${UI.thisVersion}${since ? ` <span class="meta">${esc(UI.sinceLast(since))}</span>` : ""}</summary><ul class="plain">${b.live.recent.map((x) => `<li>${esc(x.shows ?? x.title)}</li>`).join("")}</ul>${earlierFold}</details>`);
    } else {
      // Nothing verified on production since this sha was deployed: say so in words (t-060), never an empty heading.
      out.push(`<div class="line"><span class="quiet">${UI.thisVersionUnverified}</span></div>${earlierFold}`);
    }
  } else out.push(`<span class="quiet">${UI.noDeployReading}</span>`);
  // t-091: one standing line for what is verified and not yet deployed, from t-078's counts. Nothing when there is
  // nothing waiting; when the containment fact cannot answer, the reason instead of a made-up number.
  const waiting = waitingLine(b);
  if (waiting) out.push(`<p class="meta waiting">${machineWords(waiting)}</p>`);
  // pd 22:45: one grey line, always there and not clickable, saying what the call-outs can really do (t-050 posts to https only):
  // no address or skipped; an email that nothing sends to; an https address that gets the call.
  if (!asks.some(isContactCard) && !reopen) out.push(`<p class="meta contact-line">${esc(contactLine(contact))}</p>`);
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

  const whoLabel = (r: RoleRow) => {
    const state = r.status === "listening" ? (r.last_seen ? t(r.last_seen) : "")
      : r.status === "deaf" ? esc(r.minutes === null ? UI.deafNever : UI.deaf(r.minutes))
      : esc(r.minutes === null ? UI.missingNever : UI.missing(r.minutes));
    return r.undelivered ? `${state} · ${esc(UI.undelivered(r.undelivered))}` : state;
  };
  const whoChips = roles.length
    ? roles.map((r) => `<span class="who-chip${r.present ? "" : " away"}" data-role="${esc(r.role)}" data-status="${r.status}"><i></i>${esc(r.role)}<span class="meta">${whoLabel(r)}</span>${r.push === "production" ? `<span class="can-push">${UI.canPushProduction}</span>` : ""}</span>`).join("")
    : b.presence.map((p) => `<span class="who-chip${(p.idle_s ?? 0) > 600 || !p.present ? " away" : ""}"><i></i>${esc(p.actor)}<span class="meta">${p.last_seen ? t(p.last_seen) : ""}</span></span>`).join("");
  out.push(`<div class="row"><span class="label">${UI.who}</span><div class="val chips">${whoChips || `<span class="quiet">${UI.nobody}</span>`}</div></div>`);
  out.push(`</section>`);

  // ---------- 其余 ----------
  // The dig layer keeps its times short: the exact stamps are on the task page and in the API (t-065).
  out.push(renderRest(b, s, human, (iso) => esc(ago(iso)), ago, base));

  return page(out.join("\n") + (out.some((x) => x.includes('class="btn copy"')) ? "\n" + COPY_SCRIPT : ""), { now: b.now, refresh, sha: opts.sha });
}

/**
 * The version before this one: the latest production:deployed.sha reading whose value differs from the current
 * one (pd, t-034 review). Null when there is none, or when it would be the current sha again.
 */
export function previousSha(b: Board): string | null {
  // Shas compare by their 7-char prefix: the same build recorded long and short is one version (pd review of t-026).
  const short = (v: unknown) => String(v).slice(0, 7);
  const current = b.live.deployed_sha ? short(b.live.deployed_sha) : null;
  if (!current) return null;
  const prev = b.readings
    .filter((r) => r.surface === "production" && r.key === "deployed.sha" && typeof r.value === "string")
    .sort((x, y) => y.at.localeCompare(x.at))
    .find((r) => short(r.value) !== current);
  const fallback = b.live.since_sha ? short(b.live.since_sha) : null;
  const value = prev ? short(prev.value) : fallback;
  return value && value !== current ? value : null;
}

/** The invite link, once the board carries one (t-041): board.invite_url, or board.project.invite_url. */
export function inviteUrl(b: Board): string | null {
  const x = b as Board & { invite_url?: string; project?: { invite_url?: string } };
  return x.invite_url ?? x.project?.invite_url ?? null;
}

/** The role a service card is about: 「<角色> 已经缺了…」(t-042) or 「<角色> 可能失联…」(t-048), as core reads it; a field wins when present. */
export function missingRole(i: { body: string; role?: string; about?: { role?: string } }): string | null {
  return i.role ?? i.about?.role ?? missingRoleOf(i.body.trim()) ?? null;
}

interface RoleRow { role: string; status: "listening" | "deaf" | "missing"; present: boolean; last_seen: string | null; since: string | null; minutes: number | null; overdue: string[]; undelivered: number; /** what the node said it may push (t-058) */ push: string }

/**
 * 谁在 by role (t-042/t-047/t-048): one presence row per declared role. listening = here; deaf = spoke but is not
 * pulling, so nothing reaches it; missing = neither. `minutes` since the last pull (null when it never pulled);
 * `undelivered` counts instructions sent to the role that nobody has pulled.
 */
export function rolesOf(b: Board, now = Date.parse(b.now)): RoleRow[] {
  return b.presence.filter((p) => p.role !== undefined).map((p) => {
    const status = p.status ?? (p.present ? "listening" : "missing");
    const since = p.since ?? (p.present ? p.last_seen : null);
    const minutes = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)) : null;
    const overdue = status === "listening" ? [] : b.overdue.filter((o) => o.to === p.role).map((o) => o.instruction);
    const undelivered = (b.undelivered ?? []).find((u) => u.to === p.role)?.count ?? 0;
    return { role: p.role!, status, present: status === "listening", last_seen: p.last_seen, since: p.since, minutes, overdue, undelivered, push: p.push ?? "none" };
  });
}

function inviteLine(url: string): string {
  return `<p class="invite">${UI.inviteLine}<input class="invite-url" type="text" readonly value="${esc(url)}" aria-label="邀请链接"><button class="btn copy" type="button" data-copy="${esc(url)}">${UI.copy}</button></p>`;
}

/** The only script on the page: the copy button. Without it the link is still a selectable readonly box. */
const COPY_SCRIPT = `<script>document.addEventListener("click",function(e){var b=e.target.closest("button.copy");if(!b||!navigator.clipboard)return;navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function(){b.textContent="${UI.copied}";});});</script>`;

interface FlightItem { title: string; owner?: string; blocked?: boolean; why?: string }

/** The in-flight groups: a count each, and rows. working/blocked are read; the others are dug. */
export function inFlightOf(b: Board): { key: string; label: string; total: number; items: FlightItem[] }[] {
  const g = (k: string): FlightItem[] => (b.in_flight[k]?.all ?? []).map((x) => {
    const task = (b.tasks[k] ?? []).find((tk) => tk.id === x.id);
    return { title: x.title, owner: x.owner, blocked: k === "blocked", why: k === "blocked" && task?.blocked_on ? whyLine(task.blocked_on) : undefined };
  });
  const elsewhere = (b.tasks.verified ?? []).filter((tk) => !tk.verified_on?.includes("production")).map((tk) => ({ title: tk.shows ?? tk.title, owner: tk.owner })); // t-056: the owner's sentence when there is one
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

function renderRest(b: Board, s: State, human: string, t: (iso: string) => string, ago: (iso: string) => string, base = ""): string {
  const d: string[] = [];
  const open = b.instructions.filter((i) => i.status !== "acked" && i.status !== "withdrawn" && i.to !== human && !i.chosen);
  const openSeams = b.seams.filter((x) => x.open);
  const valid = b.readings.filter((r) => r.valid), stale = b.readings.filter((r) => !r.valid);
  const why = (r: Board["readings"][number]) => !r.why ? "" : r.why.startsWith("superseded by") ? `${UI.supersededBy} <code>${esc(r.why.slice(14))}</code>` : r.why.startsWith("invalidated by") ? `${UI.invalidatedBy} <code>${esc(r.why.slice(15))}</code>` : UI.expired;

  d.push(`<details class="rest" id="rest"><summary>${UI.rest} <span class="meta">${esc(UI.restSummary(open.length, b.overdue.length, openSeams.length, valid.length))}</span></summary>`);

  // The latest collaboration report (pd 14:50 ③): one line in the dig layer, never above the fold.
  const report = latestReport(s, b);
  d.push(`<p class="meta report">${UI.collabReport}${report ? (report.href ? `<a href="${esc(report.href)}">${esc(report.when)}</a>` : esc(report.when)) + ` <code>${esc(report.path)}${report.sha ? ` @ ${esc(report.sha)}` : ""}</code>` : UI.collabNone}</p>`);

  // 团队 (pd review 21:06 of t-059): one line — how many responsibilities are held, then the allocation summary;
  // 没人管的事 stays its own section, one sentence per gap, without the fact's internal words. Never above the fold.
  const cov = b.coverage ?? [];
  const gaps = cov.filter((c) => c.status !== "held");
  const teamLine = [cov.length ? UI.held(cov.length, cov.length - gaps.length) : "", b.allocation?.summary ?? ""].filter(Boolean).join(" · ");
  if (teamLine) d.push(`<p class="meta team">${UI.team}：${esc(teamLine)}</p>`);
  if (gaps.length) d.push(`<section id="coverage"><h3>${UI.coverage} <span class="meta">${gaps.length}</span></h3><ul class="plain">${gaps.map((c) => `<li>${esc(c.line.replace(/（能力事实[^）]*）/g, "").trim())}</li>`).join("")}</ul></section>`);

  d.push(`<section id="overdue"><h3>${UI.overdue} <span class="meta">${b.overdue.length}</span></h3>`);
  d.push(b.overdue.length ? `<ul class="plain">${b.overdue.map((i) => `<li><span class="tag warn">${UI.instrStatus.overdue}</span> ${esc(UI.overdueLine(i.to, i.body, i.from))} <span class="meta">（${esc(UI.due(ago(i.ack_by)))} · <code>${esc(i.instruction)}</code>）</span></li>`).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  d.push(`</section>`);

  d.push(`<section id="instructions"><h3>${UI.agentInstructions} <span class="meta">${open.length}</span></h3>`);
  d.push(open.length ? `<ul class="plain">${open.map((i) => `<li><span class="tag">${esc(UI.instrStatus[i.status] ?? i.status)}</span> ${esc(i.from)} → ${esc(i.to)}：${esc(i.body)} <span class="meta">${t(i.sent)}${i.delivered ? "" : ` · ${UI.notPulled}`} · <code>${esc(i.id)}</code></span></li>`).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  const decided = b.instructions.filter((i) => i.chosen);
  if (decided.length) d.push(`<h4>${UI.decided}</h4><ul class="plain">${decided.slice(-DECIDED_SHOWN).map((i) => `<li>${esc(i.from)} → ${esc(i.to)}：${esc(i.body)} <b>${esc(i.chosen!.by === "default" ? UI.decidedByDefault(i.chosen!.option) : UI.chosen(i.chosen!.by, i.chosen!.option))}</b><span class="meta">，${t(i.chosen!.at)} · <code>${esc(i.id)}</code></span></li>`).join("")}</ul>`);
  d.push(`</section>`);

  const total = Object.values(b.tasks).reduce((n, xs) => n + xs.length, 0);
  const inline = inlinedTasks(b);
  const ambiguous = ambiguousLabels(b); // t-100: the same judgment the CLI uses
  d.push(`<section id="tasks"><h3>${UI.tasks} <span class="meta">${total}</span></h3>`);
  for (const status of ["blocked", "working", "done", "failed", "open", "verified", "withdrawn", "obsolete"]) {
    const list = b.tasks[status] ?? [];
    if (!list.length) continue;
    d.push(`<h4>${esc(UI.taskStatus[status] ?? status)} <span class="meta">${list.length}</span></h4><ul class="tasks detail-tasks">`);
    for (const task of list) {
      const st = s.tasks.get(task.id);
      const bits: string[] = [];
      if (task.owner) bits.push(`@${esc(task.owner)}`);
      if (task.blocked_on) bits.push(`⏸ ${esc(task.blocked_on)}`);
      if (task.verified_on?.length) bits.push(`✓ ${esc(task.verified_on.map(surface).join("、"))}`);
      const href = `${base}/task/${encodeURIComponent(task.id)}`;
      if (st && inline.has(task.id)) {
        // This version's and still-moving tasks carry their criteria and evidence inline (t-065).
        d.push(`<li><details><summary>${esc(taskHeading(task, ambiguous))}${bits.length ? ` <span class="meta">${bits.join(" · ")}</span>` : ""}</summary>`);
        d.push(taskDetail(st, t, ago, href, MOVING.has(status), task.from));
        d.push(`</details></li>`);
      } else {
        // Earlier tasks: the title and one line; everything else lives on the task page.
        d.push(`<li class="brief"><a href="${esc(href)}">${esc(taskHeading(task, ambiguous))}</a>${bits.length ? ` <span class="meta">${bits.join(" · ")}</span>` : ""}</li>`);
      }
    }
    d.push(`</ul>`);
  }
  d.push(`</section>`);

  d.push(`<section id="seams"><h3>${UI.seams} <span class="meta">${esc(UI.openCount(openSeams.length))}</span></h3>`);
  const closedSeams = b.seams.length - openSeams.length;
  d.push(openSeams.length ? `<ul class="plain">${openSeams.map((x) => seamLine(x, base)).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  if (closedSeams) d.push(`<p class="meta">${esc(UI.seamsElsewhere(closedSeams))}</p>`);
  d.push(`</section>`);

  d.push(`<section id="readings"><h3>${UI.readings} <span class="meta">${esc(UI.readingCount(valid.length, stale.length))}</span></h3>`);
  const readingLine = (r: Board["readings"][number]) => `<li><span class="tag${r.valid ? "" : " stale"}">${r.valid ? UI.valid : UI.stale}</span> <code>${esc(r.surface)}:${esc(r.key)}</code> = ${esc(clip(str(r.value), VALUE_MAX))} <span class="meta">${esc(r.by)}，${t(r.at)}${[why(r), r.assumptions?.length ? `${UI.assumes}：${esc(r.assumptions.join("；"))}` : ""].filter(Boolean).map((x) => ` · ${x}`).join("")}</span></li>`;
  const staleShown = stale.slice().sort((x, y) => y.at.localeCompare(x.at)).slice(0, STALE_SHOWN);
  d.push(b.readings.length ? `<ul class="plain">${[...valid, ...staleShown].map(readingLine).join("")}</ul>` : `<p class="quiet">${UI.none}</p>`);
  if (stale.length > staleShown.length) d.push(`<p class="meta">${esc(UI.olderStale(stale.length - staleShown.length))}</p>`);
  d.push(`</section>`);

  d.push(`</details>`);
  return d.join("\n");
}

type Seam = Board["seams"][number];

function seamLine(x: Seam, base: string): string {
  const link = (id: string) => `<a href="${esc(`${base}/task/${encodeURIComponent(id)}`)}"><code>${esc(id)}</code></a>`;
  return `<li><span class="tag${x.open ? " warn" : ""}">${x.open ? UI.seamOpen : x.resolved ? esc(UI.seamResolvedBy(x.resolved)) : UI.seamStacked}</span> ${link(x.tasks[0])} + ${link(x.tasks[1])} ${UI.bothTouch} ${(x.overlap ?? []).map((o) => `<code>${esc(o)}</code>`).join(", ")}</li>`;
}

/**
 * Which tasks the dig layer inlines (t-065): the ones this version brought (t-026's recent) and the ones still
 * moving. Everything older is a title and a line; its criteria, evidence and notes are on GET /task/<id>.
 */
export function inlinedTasks(b: Board): Set<string> {
  const ids = new Set(b.live.recent.map((x) => x.id));
  for (const status of MOVING) for (const task of b.tasks[status] ?? []) ids.add(task.id);
  return ids;
}

/** The last verdict on each surface, in order of first appearance: what the board shows for a finished task. */
function latestPerSurface<V extends { surface: string }>(vs: V[]): V[] {
  const last = new Map<string, V>();
  for (const v of vs) last.set(v.surface, v);
  return [...last.values()];
}

/** On the board, a finished task's evidence and each verdict show this much; the task page has all of it (t-065). */
const EVIDENCE_MAX = 160;
const NOTE_MAX = 200;
/** Stale readings listed on the board: the latest few; older ones are a count (t-065). */
const STALE_SHOWN = 8;
/** Settled questions listed in the dig layer: the latest few. */
const DECIDED_SHOWN = 3;
/** A reading's value on the board is clipped; the API has the whole thing. */
const VALUE_MAX = 80;
const VERDICT_MAX = 80;
/** Statuses that are still moving: their notes are the working conversation and stay inline. */
const MOVING = new Set(["open", "working", "blocked", "done", "failed"]);

/** A task's criteria, evidence, verdicts and notes; the same block inline on the board and on the task page. */
function taskDetail(st: TaskState, t: (iso: string) => string, ago: (iso: string) => string, href: string | null, withNotes = true, from?: string): string {
  const d: string[] = [];
  d.push(`<div class="meta">${esc(UI.criteriaBy(st.criteria_by, ago(st.created_at)))}</div>`);
  d.push(`<ol class="criteria">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>`);
  if (st.shows) d.push(`<div>${esc(st.shows)}</div>`);
  const evidence = st.evidence && href ? clip(st.evidence, EVIDENCE_MAX) : st.evidence;
  if (evidence) d.push(st.shows ? `<details class="meta"><summary>${UI.evidence}</summary>${esc(evidence)}</details>` : `<div class="meta">${UI.evidence}：${esc(evidence)}</div>`);
  const evidenceNotes = st.notes.filter((n) => /^\s*evidence:/i.test(n.body));
  // On the board a note keeps its first lines; the task page has the whole text (t-065).
  const body = (text: string) => href ? clip(text, NOTE_MAX) : text;
  if (withNotes) for (const n of evidenceNotes) d.push(`<div class="meta">+ ${esc(body(n.body.replace(/^\s*evidence:\s*/i, "")))} <span class="meta">（${esc(n.actor)}，${t(n.at)}）</span></div>`);
  // On the board a finished task's verdicts keep their first line; the verifier's full evidence is on the task page.
  const verdicts = href && !withNotes ? latestPerSurface(st.verifications) : st.verifications;
  for (const v of verdicts) d.push(`<div class="meta">${v.pass ? `✓ ${UI.verifiedOn}` : `✗ ${UI.failedOn}`} <b>${esc(surface(v.surface))}</b>，${UI.by} ${esc(v.by)}，${t(v.at)}${v.evidence ? `：${esc(href ? clip(v.evidence, VERDICT_MAX) : v.evidence)}` : ""}</div>`);
  if (st.withdrawn) d.push(`<div class="meta">${esc(UI.withdrawnBy(st.withdrawn.by, ago(st.withdrawn.at)))}：${esc(st.withdrawn.reason)}</div>`);
  if (st.obsolete) d.push(`<div class="meta">${esc(UI.obsoleteBy(st.obsolete.decision, st.obsolete.by, ago(st.obsolete.at)))}${st.obsolete.reason ? `：${esc(st.obsolete.reason)}` : ""}</div>`);
  const other = withNotes ? st.notes.filter((n) => !/^\s*evidence:/i.test(n.body)) : st.notes;
  d.push(sourceLine(from)); // t-099: after the criteria and the evidence, never at the top (pd 23:42)
  if (st.touches.length && (withNotes || !href)) d.push(`<div class="meta">${UI.touches}：${st.touches.map((x) => `<code>${esc(x)}</code>`).join(", ")}</div>`);
  if (other.length && withNotes) d.push(`<ul class="notes">${other.map((n) => `<li><b>${esc(n.actor)}</b> ${t(n.at)}${n.decision ? ` <span class="tag">${UI.decisionTag}</span>` : ""}：${esc(body(n.body))}${sourceLine(n.from)}</li>`).join("")}</ul>`);
  // On the board, a finished task's notes are a count and a link: they are what made the page grow with the log (t-065).
  if (href) d.push(`<div class="meta">${other.length && !withNotes ? esc(UI.notesCount(other.length)) + " · " : ""}<a href="${esc(href)}">${UI.details}</a></div>`);
  return d.join("\n");
}

/**
 * GET /task/<id> (t-065): one task in full, in the board's clothes: criteria, evidence, verdicts, seams and notes.
 * Null when the log has no such task. The raw id stays in the URL and in the 「给 agent 看的」 fold.
 */
export function renderTask(b: Board, s: State, id: string, opts: RenderOptions = {}): string | null {
  const st = s.tasks.get(id);
  const task = boardTask(b, id);
  if (!st || !task) return null;
  const base = opts.base ?? "";
  const now = Date.parse(b.now);
  const ago = (iso: string) => UI.ago(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)));
  const t = (iso: string) => `<time datetime="${esc(iso)}">${esc(ago(iso))}</time>`;
  const out: string[] = [];
  const bits: string[] = [esc(UI.taskStatus[task.status] ?? task.status)];
  if (task.owner) bits.push(`@${esc(task.owner)}`);
  if (task.blocked_on) bits.push(`⏸ ${esc(task.blocked_on)}`);
  if (task.verified_on?.length) bits.push(`✓ ${esc(task.verified_on.map(surface).join("、"))}`);
  out.push(`<p class="meta"><a href="${esc(base)}/">${UI.backToBoard}</a></p>`);
  out.push(`<section class="now task-page"><h2>${esc(task.shows ?? taskHeading(task, ambiguousLabels(b)))}</h2>`);
  out.push(`<p class="meta">${bits.join(" · ")}</p>`);
  out.push(taskDetail(st, t, ago, null, true, task.from));
  const seams = b.seams.filter((x) => x.tasks.includes(id));
  if (seams.length) out.push(`<h3>${UI.taskSeams} <span class="meta">${seams.length}</span></h3><ul class="plain">${seams.map((x) => seamLine(x, base)).join("")}</ul>`);
  out.push(`<details class="meta"><summary>${UI.forAgents}</summary><code>${esc(task.id)}</code> · <code>ateam task show ${esc(task.id)}</code></details>`);
  out.push(`</section>`);
  return page(out.join("\n"), { now: b.now, refresh: 0, sha: opts.sha, title: `${esc(task.shows ?? task.title)} · ${UI.header}` });
}

/**
 * The latest collaboration report named in a note as docs/collab/<YYYY-MM-DD-HHMM>.md (optionally "@ <sha>").
 * It links only when the project recorded where its repository lives (a valid reading repo:url), so the board
 * carries no host of its own; otherwise the path is shown as text.
 */
export function latestReport(s: State, b: Board): { path: string; when: string; sha?: string; href?: string } | null {
  let best: { path: string; stamp: string; sha?: string } | null = null;
  for (const n of s.notes) {
    const m = /docs\/collab\/(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.md(?:\s*@\s*([0-9a-f]{7,40}))?/.exec(n.body);
    if (!m) continue;
    const stamp = `${m[1]}-${m[2]}${m[3]}`;
    if (!best || stamp > best.stamp) best = { path: `docs/collab/${stamp}.md`, stamp, sha: m[4]?.slice(0, 7) };
  }
  if (!best) return null;
  const when = `${best.stamp.slice(0, 10)} ${best.stamp.slice(11, 13)}:${best.stamp.slice(13, 15)}Z`;
  const repo = b.readings.find((r) => r.valid && r.surface === "repo" && r.key === "url" && typeof r.value === "string");
  const href = repo ? `${String(repo.value).replace(/\/$/, "")}/blob/${best.sha ?? "HEAD"}/${best.path}` : undefined;
  return { path: best.path, when, sha: best.sha, href };
}

export function notFoundPage(base = ""): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${UI.taskNotFound} · ${UI.title}</title></head><body style="font:15px/1.7 system-ui;padding:2rem"><h1>${UI.taskNotFound}</h1><p><a href="${esc(base)}/">${UI.backToBoard}</a></p></body></html>`;
}

export function unauthorizedPage(): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${UI.title}</title></head><body style="font:15px/1.7 system-ui;padding:2rem"><h1>${UI.title}</h1><p>${UI.unauthorized} <code>/?token=&lt;ATEAM_TOKEN&gt;</code>${UI.unauthorizedTail}</p></body></html>`;
}

/** The token page: the only thing on it is a token box; the hidden fields carry the action the human clicked. */
export function tokenPage(fields: Record<string, string>, wrong = false, base = ""): string {
  const hidden = Object.entries(fields).filter(([k]) => k !== "token").map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${UI.tokenTitle} · ${UI.title}</title>
<style>${CSS}</style></head>
<body><main class="token-page"><header><h1>${UI.header}</h1></header>
<section class="now"><h2>${UI.tokenTitle}</h2><p>${UI.tokenLead}</p>${wrong ? `<p class="why">${UI.tokenWrong}</p>` : ""}
<form method="post" action="${esc(base)}/token" class="line">${hidden}<input type="password" name="token" aria-label="${UI.tokenLabel}" autofocus autocomplete="off" required><button class="btn primary" type="submit">${UI.tokenSubmit}</button></form>
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
.ask .body { margin:-.4rem 0 .85rem; color:var(--muted); max-width:40em; }
.actions.contact input { flex:1 1 14rem; min-width:0; font:inherit; padding:.55rem .8rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); }
a.btn { text-decoration:none; display:inline-block; }
.waiting { margin:.35rem 0 0; }
.from { margin:.15rem 0 0; } .from a { color:var(--accent); }
.contact-line { margin:.35rem 0 0; } .contact-line a { color:var(--muted); text-decoration:underline dotted; }
.btn { font:500 .95rem/1 var(--sans); padding:.6rem 1.1rem; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--ink); cursor:pointer; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-ink); }
.btn small { font-size:.75em; letter-spacing:.05em; }
.btn:focus-visible, input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.detail { margin:-.4rem 0 .8rem; } .detail summary { cursor:pointer; color:var(--muted); font-size:.85rem; }
.detail p { margin:.25rem 0 0; color:var(--muted); font-size:.9rem; max-width:40em; white-space:pre-wrap; }
.hint { margin-left:.5rem; color:var(--muted); font-size:.85rem; }
.hint.answer { margin:0 0 .5rem; }
.invite { display:flex; flex-wrap:wrap; gap:.4rem .5rem; align-items:center; margin:.6rem 0 0; color:var(--muted); font-size:.85rem; }
.invite input { flex:1 1 14rem; min-width:0; font:.85rem var(--mono); padding:.35rem .6rem; border:1px solid var(--line); border-radius:6px; background:var(--soft); color:var(--ink); }
.btn.copy { padding:.35rem .8rem; font-size:.85rem; }
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
.who-chip .can-push { font-size:.72rem; border:1px solid currentColor; border-radius:999px; padding:0 .45em; }
.rest { border-top:1px solid var(--line); padding-top:.75rem; }
.rest > summary { cursor:pointer; color:var(--muted); font-size:.9rem; }
.rest .report { margin:.5rem 0 .25rem; } .rest .report a { color:var(--accent); }
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

function page(body: string, m: { now: string; refresh: number; sha?: string; title?: string }): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${m.refresh ? `<meta http-equiv="refresh" content="${m.refresh}">` : ""}
<title>${m.title ?? UI.header}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header><h1>${UI.header}</h1><span class="meta">${m.refresh ? `${UI.refreshes(m.refresh)} · ` : ""}<time datetime="${esc(m.now)}">${esc(m.now.replace("T", " ").slice(0, 16))}Z</time></span></header>
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
