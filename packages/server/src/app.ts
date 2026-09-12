import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { type Board, type State, CONTACT_ASK, CONTACT_FILL, CONTACT_FILL_WAS, CONTACT_OPTIONS, CONTACT_SKIP, isContactAsk, ALERT_WEBHOOK_KEY, ALERT_ASK_KEY, PROJECT_SURFACE, BOARD_SHAPE, slimBoard, alertContact, append, appendFrom, Reduction, pull, reduce, board, manual, runFollowUps, runDueDefaults, welcome, inviteManual, projectRoles, roleResponsibilities, responsibilityAppendix, manualFor, isMissing, presenceStatus, missingRoleOf, missingCard, owedTo, owedNow, postReply, deployHistory, MemoryStore, Rejected, PUSH_LEVELS, NODE_SURFACE, capabilityKey, type EventStore, type NewEvent, DEFAULT_DECIDER, SAID_PREFIX, SAID_MAX_CHARS, joinNotAsHuman, OWNER_URL_LOCKED, OWNER_URL_NEEDS_SECRET, DEFER_PREFIX, SERVICE_ACTOR, PRESENCE_WINDOW_MS, ulid, isCliRefusal, cliRefusalOp, CLI_REFUSAL_BATCH_MAX, type Refused } from "@ateam/core";
import { renderBoard, renderTask, renderRelease, unauthorizedPage, tokenPage, pasteShape, notFoundPage, contactEnabled } from "./html.js";
import { MemoryRegistry, type Registry, type KeyRecord } from "./projects.js";
import { allocationFact } from "./allocation.js";
import { runAlerts } from "./alerts.js";

/** After the human acks a missing-role card, no new card for that role for this long (pm decision 14:15). */
export const REMIND_COOLDOWN_MS = 15 * 60_000;

/**
 * t-103 (qa 01:12): the page asks for "the whole board address, or just the part after k=", because what a person has
 * in hand is an address, not a key — making them cut it themselves was our mistake. So take either: a pasted URL
 * (k= or token=), or the bare key, with whatever whitespace a copy-paste dragged along.
 */
export function keyFromPaste(pasted: string | null): string | null {
  if (pasted === null) return null;
  const t = pasted.trim();
  if (!t) return "";
  // A whole address: take k= (or token=) out of its query, wherever in the order it sits, and drop any #fragment.
  const q = t.indexOf("?") >= 0 ? t.slice(t.indexOf("?") + 1) : t.includes("=") ? t : "";
  if (q) {
    const params = new URLSearchParams(q.replace(/#.*$/, ""));
    const found = params.get("k") ?? params.get("token");
    if (found?.trim()) return clean(found);
  }
  return clean(t);
}
/**
 * A key is base64url with a short prefix — only letters, digits, `_` and `-`. So anything trailing that cannot be part
 * of one (a slash, a space, the full stop of the sentence it was copied out of) was never part of it.
 */
function clean(k: string): string { return k.trim().replace(/[^A-Za-z0-9_-]+$/, ""); }

const COOKIE = "ateam_token";
/** How long a board cookie lasts. Recorded in the entry-form fact (t-103) so a lost address can be reissued from the log. */
export const COOKIE_MAX_AGE_S = 2592000;
/** Reading key: how a person gets into this board right now. */
export const ENTRY_FORM_KEY = "entry.form";
/**
 * t-103, pd 00:28 + 00:29 定稿。人可见的其余三处文字在 frontend 的 t-110；这一句是服务端拒绝时说的那句，
 * 照抄，不各写一份。
 */
export const OWNER_ONLY = (human: string) =>
  `你拿的是项目共享钥匙，它不能代 ${human} 说话——${human} 这个身份只有他自己那把钥匙能用。要人拍板就发一张卡等他点；牌桌地址丢了，持管理钥匙的节点可以再发一个。`;

export interface ServerOptions {
  /** Legacy single-project form: the store and shared key of the default project. */
  store?: EventStore;
  token?: string;
  /** Multi-project form (t-041): who knows the projects and keys, and where each project's log lives. */
  registry?: Registry;
  storeFor?: (project: string) => EventStore;
  /** The project the unprefixed address means. Default "ateam". */
  defaultProject?: string;
  human: string;
  maxWaitMs?: number;
  /** Git commit the running image was built from; "unknown" when the build did not say. */
  sha?: string;
  /** GET / without the token. Default true (decision 06:23). Writing (POST /decide) always needs the token. */
  boardPublic?: boolean;
  /** Where the service is reachable from outside (for links in call-outs); else the origin of the last request seen. */
  publicUrl?: string;
  /** How often the call-out check runs; 0 disables the timer (tests call runAlerts directly). Default 60s. */
  alertIntervalMs?: number;
  /** t-063: the clock the whole server reads (tests inject one); default the real one. Events are stamped from it too. */
  clock?: () => Date;
  /** t-063: shift every *reading* of the current time by this much; never stamps an event. Only with testHooks. */
  clockOffsetMs?: number;
  /** t-063: expose POST /_test/clock and POST /_test/run. Off by default; production never sets it. */
  testHooks?: boolean;
  /**
   * t-234 判据 9：**把主人的地址发出去要的那段口令**，只放在服务环境里（`ATEAM_OWNER_SECRET`）。
   * 不设就是这扇门关着——未配置就锁上。它必须不是任何节点手上有的东西：第一个打开主人地址的人永久是主人。
   */
  ownerSecret?: string;
  /** The fetch the call-outs use; default the global one (tests inject a fake). */
  fetchImpl?: typeof fetch;
}

/** Many projects, each one log and its own keys; the unprefixed address is the default project. Identity is the X-Actor header. */
export function createApp(opts: ServerOptions) {
  const { token, human } = opts;
  const ownerSecret = opts.ownerSecret?.trim() || "";
  const sha = opts.sha?.trim() || "unknown";
  const boardPublic = opts.boardPublic ?? true;
  const maxWait = opts.maxWaitMs ?? 30_000;
  const defaultProject = opts.defaultProject ?? "ateam";
  const registry = opts.registry ?? new MemoryRegistry();
  const memory = new Map<string, EventStore>();
  const storeFor = opts.storeFor ?? ((p: string) => {
    if (p === defaultProject && opts.store) return opts.store;
    let s = memory.get(p);
    if (!s) { s = new MemoryStore(); memory.set(p, s); }
    return s;
  });
  const ready = registry.ensure(defaultProject, defaultProject, token);
  // t-063: `real()` stamps records (events, cursors, deadlines); `now()` is what the server believes the time is when it
  // reads the world (overdue, presence, call-outs). They differ only by the test offset, which production cannot set.
  const testHooks = !!opts.testHooks;
  let offsetMs = testHooks ? (opts.clockOffsetMs ?? 0) : 0;
  const real = () => (opts.clock ? opts.clock() : new Date());
  /**
   * t-172：**偏移是加在一个瞬间上的，不是一次独立的读表。**
   *
   * `now()` 原本写成 `new Date(real().getTime() + offsetMs)`——每叫一次就重新读一次表。想同时要「真时刻」
   * 和「偏移后的时刻」的地方，于是拿到的是**两个瞬间**：两次 `Date.now()` 之间跨过一个毫秒边界，两者的差
   * 就不再等于 offsetMs。qa 08:28 在 20000 次里量到 80 次偏 +1ms（0.400%），换算下来全队每约 250 次全量跑
   * 撞一次假红。
   *
   * 修的是接口不是断言（判据 2）：把「加偏移」单拿出来成 `shift`，谁需要成对的两个读数就叫一次 `instant()`
   * ——一次读表，两个读数由同一个瞬间算出来，差值恒等于 offsetMs。把那句毫秒等值调松是把漂移藏起来，不是
   * 消掉它。
   */
  const shift = (at: Date) => new Date(at.getTime() + offsetMs);
  const now = () => shift(real());
  /** 同一次读表上的两个读数：`now - real` 恒等于 offsetMs，与调用之间有没有跨过毫秒边界无关。 */
  const instant = () => { const at = real(); return { real: at, now: shift(at) }; };
  const doFetch: typeof fetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  let lastOrigin = opts.publicUrl ?? "";
  const boardUrl = (p: string) => `${(opts.publicUrl ?? lastOrigin) || "http://localhost"}${p === defaultProject ? "/" : `/p/${encodeURIComponent(p)}/`}`;
  // t-050: the service calls out on its own clock; no node needs to be online for this
  const alertInterval = opts.alertIntervalMs ?? 60_000;
  const timer = alertInterval > 0 ? setInterval(async () => {
    try { await runPeriodic(); }
    catch (err) { console.error("alerts:", err); }
  }, alertInterval) : undefined;
  timer?.unref();

  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  /**
   * t-121 (P0), finished by t-128: every request rebuilt the world from scratch — read the whole log out of sqlite,
   * JSON.parse every row, reduce it, derive the board. All of that is synchronous, so it does not merely make one
   * request slow, it stops the instance serving anyone else while it runs.
   *
   * t-121 answered that with a cache keyed on the log's last event: a burst of callers shared one reduction, but the
   * next append threw it away and the next caller paid for the whole log again. t-128 replaces the cache with a
   * reduction that is never thrown away: it asks the store what has landed since it last looked and folds only that,
   * then settles it at the moment being asked about. There is one per project, it belongs to the read path, and
   * nothing invalidates it — it cannot be stale, because catching up is the first thing every answer does.
   *
   * It is settled in place, so it must not be handed to anyone who holds it across an await while another caller could
   * settle it at a different moment. The write path therefore keeps its own (in core's `appendFrom`); the two share the
   * algorithm, not the state. A store too old to answer `readSince` falls back to reducing the whole log, as before.
   */
  const reading = new Map<string, Reduction>();
  const stateFor = async (projectId: string, store: EventStore, at: Date = now()): Promise<State> => {
    let r = reading.get(projectId);
    if (!r) reading.set(projectId, (r = new Reduction(store, human)));
    return r.at(at);
  };

  // A role that has gone quiet with work in its hands: a card for the human, at most one per role per absence (pm 14:15).
  const remindFor = async (projectId: string, store: EventStore): Promise<unknown[]> => {
    const events = await serialize(async () => {
      const at = now();
      const state = await stateFor(projectId, store, at);
      const out: unknown[] = [];
      const b = board(state, human, at);
      for (const role of projectRoles(state)) {
        // t-202：只在「起一个新的」真能解决问题的那一态才起这张卡。上一版的条件是 !isMissing——它只排掉
        // listening，于是一个还在写、只是没来读日志的节点（deaf）照样被写成「起一个 X？」发到人手上。
        if (presenceStatus(state, role, at) !== "missing") continue;
        // t-147 (pd 05:40): 「到 ack_by 时仍停在①没读到，才升级成『起一个 X』」. Two changes from before: what counts
        // is owed by the new model (core `owedTo`) rather than `st.overdue`, which after t-147 is only an unanswered
        // card and would have left a quiet role holding three instructions with no card raised at all; and only what
        // its own deadline has passed counts, so a role that has been away four minutes is not escalated to a person.
        const nowIso = at.toISOString();
        const unread = owedTo(state, role).filter((st) => st.reach === "unread");
        const overdue = unread.filter((st) => st.instruction.ack_by < nowIso);
        const undelivered = b.undelivered.find((u) => u.to === role);
        if (!overdue.length && !undelivered) continue;
        const cards = [...state.instructions.values()].filter((st) => st.instruction.actor === SERVICE_ACTOR && missingRoleOf(st.instruction.body) === role);
        if (cards.some((st) => !st.acked_at)) continue;
        const lastAck = cards.map((st) => st.acked_at).filter((x): x is string => !!x).sort().pop();
        if (lastAck && at.getTime() - Date.parse(lastAck) < REMIND_COOLDOWN_MS) continue;
        const last = state.presence.get(role)?.last_pull;
        // never read the log: there is no moment to count from, so the card says that rather than inventing a duration
        const minutes = last ? Math.max(1, Math.round((at.getTime() - Date.parse(last)) / 60_000)) : null;
        // t-139 (pd 05:15): which of pd's three words applies is the *presence* state, not a guess from whether
        // anything is undelivered — those are different questions, and answering the first with the second is how a
        // node that was plainly still talking got called 缺人. A listening role never reaches here at all.
        // t-202 之后这里恒为 "missing"：上面那道闸只放 missing 过来。参数留着不是摆设——missingCard 的
        // deaf 那一支要不要退役是 pd 的决定（见 core 里那段说明），在它说话之前谁都不删那句话。
        const status = b.presence.find((p) => p.actor === role)?.status === "deaf" ? "deaf" : "missing";
        // The deadline decides *whether* to raise the card; the number in it is what the sentence claims — 「N 条没送到」
        // — so it counts everything unread, not just the part that has expired. They were the same number until the
        // gate above, and a card that says 1 while two are sitting undelivered is the kind of small lie qa catches.
        const body = missingCard(role, status, minutes, undelivered?.count ?? unread.length);
        const refs = [...new Set([...overdue.map((st) => st.instruction.id), ...[...state.instructions.values()].filter((st) => st.instruction.to === role && !st.delivered_at && !st.acked_at).map((st) => st.instruction.id)])];
        out.push(await append(store, { kind: "instruction", actor: SERVICE_ACTOR, to: human, intent: "do", body, ack_by: new Date(real().getTime() + 24 * 3600_000).toISOString(), refs }, { human, now: real() }));
      }
      // t-069 / pm 22:39: the contact card exists only when the project asked for it (fact project:alert.ask) and no
      // address is known yet; once, never repeated. 填写 / 先不要 on it work as before (t-071).
      if (contactWanted(state) && !alertContact(state).value && ![...state.instructions.values()].some((st) => isContactAsk(st.instruction.body))) {
        out.push(await append(store, { kind: "instruction", actor: SERVICE_ACTOR, to: human, body: CONTACT_ASK, intent: "ask", options: CONTACT_OPTIONS, ack_by: new Date(real().getTime() + 24 * 3600_000).toISOString() }, { human, now: real() }));
      }
      // t-181 (pd 09:18)：到期的默认，服务在自己的时钟上把它落成真事件。放在这里而不是某个请求路径上，是因为
      // 「到期」不是任何人做了什么——没有人来点，正是它该发生的那一刻；等下一个人碰巧发个请求才落下，就又变成
      // 「牌桌说的和日志里的不是一回事」。
      out.push(...await runDueDefaults(store, state, human, real()));
      // t-061: the allocation warnings as a fact, at most one entry per pattern per period
      const fact = allocationFact(state, human, at);
      if (fact) out.push(await append(store, fact, { human, now: real() }));
      return out;
    });
    for (const e of events) bus.emit("append", { project: projectId, e });
    return events;
  };

  /** t-063: everything the service does on its own clock, once, for every project: reminders, the allocation fact, call-outs. */
  const runPeriodic = async (): Promise<{ project: string; reminded: number; alerts: number }[]> => {
    const out: { project: string; reminded: number; alerts: number }[] = [];
    for (const p of await registry.list()) {
      const reminded = (await remindFor(p.id, storeFor(p.id))).length;
      const alerts = (await runAlerts(p.id, storeFor(p.id), { fetch: doFetch, human, boardUrl, now, real })).length;
      out.push({ project: p.id, reminded, alerts });
    }
    return out;
  };

  const server = createServer(async (req, res) => {
    // t-212：统一出口（catch 里）要用的两样，声明在 try 之外。
    let whoIsAsking = human;
    let refusalStore: EventStore | null = null;
    try {
      await ready;
      const url = new URL(req.url ?? "/", "http://x");
      const proto = String(req.headers["x-forwarded-proto"] ?? "").includes("https") ? "https" : "http";
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
      const origin = `${proto}://${host}`;
      lastOrigin = origin;
      // t-234：`k=` 与 `token=` 一样算「要进牌桌」。在此之前只认 `token=`，于是**主人自己那把钥匙的地址**
      // 用浏览器以外的任何东西打开（curl、一个 agent 替他核一次）都不会换到 cookie，只拿回一份 welcome。
      // 浏览器带着 accept: text/html 所以人自己感觉不到；而这条路正是判据 7 要说清的「主人怎么确立」。
      const wantsHtml = String(req.headers.accept ?? "").includes("text/html") || url.searchParams.has("token") || url.searchParams.has("k");

      if (url.pathname === "/health") return json(res, 200, { ok: true, sha });

      // t-063: test hooks, only when the environment says so; otherwise these paths are nothing (404 like any unknown path).
      if (url.pathname.startsWith("/_test/")) {
        if (!testHooks) return json(res, 404, { error: "not found" }); // production: these paths do not exist, whoever asks
        if (token && bearer(req) !== token) return json(res, 401, { error: "unauthorized", message: "测试入口要默认项目的管理钥匙" });
        if (url.pathname === "/_test/clock" && (req.method === "GET" || req.method === "POST")) {
          if (req.method === "POST") {
            const body = (await readJson(req)) as { offset?: unknown; offset_ms?: unknown };
            const ms = body.offset_ms !== undefined ? Number(body.offset_ms) : parseOffset(body.offset);
            if (!Number.isFinite(ms)) return json(res, 400, { error: "offset", message: "offset 写成 16m / 2h / 90s，或 offset_ms 毫秒数；0 关闭" });
            offsetMs = ms;
          }
          // t-172：两个读数来自同一次读表——这里原本是 real() 与 now() 各读一次表
          const at = instant();
          return json(res, 200, { offset_ms: offsetMs, real: at.real.toISOString(), now: at.now.toISOString() });
        }
        if (url.pathname === "/_test/run" && req.method === "POST") return json(res, 200, { now: now().toISOString(), ran: await runPeriodic() });
        return json(res, 404, { error: "not found" });
      }

      // Which project, and what path inside it. /p/<id>/... names one; anything else is the default project.
      const m = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const projectId = m ? decodeURIComponent(m[1]) : defaultProject;
      const path = m ? (m[2] || "/") : url.pathname;
      const base = m ? `/p/${encodeURIComponent(projectId)}` : "";

      // Global: the newcomer's manual, and the role manuals. Generic by construction, so they need no key.
      if (req.method === "GET" && (path === "/manual" || (path === "/" && !wantsHtml && !m))) return markdown(res, welcome(origin));
      if (req.method === "GET" && path.startsWith("/manual/")) {
        const role = decodeURIComponent(path.slice("/manual/".length));
        // t-081: any role this project declared has a manual, assembled from its responsibilities; only an undeclared name is 404
        const known = await registry.get(projectId);
        const packing = known ? roleResponsibilities(reduce(await storeFor(projectId).read(), undefined, human)) : null;
        const text = manualFor(role, packing?.[role]);
        if (text === null) return json(res, 404, { error: "not found", message: `这个项目没有 ${role} 这个角色；在事实 project:roles 里声明它（{"<角色>": ["R5"]}），就有说明书` });
        // t-059: the project's own packing at the end, when the project exists
        return markdown(res, packing ? text + responsibilityAppendix(role, packing[role] ?? []) : text);
      }

      // A new project: one board, one log, one key. The key is in this response and nowhere else.
      if (req.method === "POST" && path === "/projects" && !m) {
        const body = (await readJson(req)) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return json(res, 400, { error: "name", message: "给项目一个名字：{\"name\": \"...\"}" });
        const { project, admin_key, invite } = await registry.create(name);
        // t-103: the owner's key lives inside the board address. The sentence the first agent relays does not change —
        // "牌桌在这里：<board_url>" — but from now on that address is the owner's, and only they can speak as themselves.
        const { key: ownerKey } = await registry.ownerKey(project.id, human);
        return json(res, 201, {
          project: project.id, name: project.name,
          board_url: `${origin}/p/${encodeURIComponent(project.id)}/?k=${encodeURIComponent(ownerKey)}`,
          project_url: `${origin}/p/${encodeURIComponent(project.id)}`,
          admin_key, invite_url: `${origin}/invite/${invite.code}`, invite_expires_at: invite.expires_at,
        });
      }

      // Invite links (t-042): the page explains how to join; POST .../join exchanges the code for a node key.
      const inv = /^\/invite\/([^/]+)(\/join)?$/.exec(url.pathname);
      if (inv) {
        const invite = await registry.getInvite(decodeURIComponent(inv[1]));
        if (!invite) return json(res, 404, { error: "not found", message: "没有这个邀请链接" });
        const owner = (await registry.get(invite.project))!;
        if (invite.expires_at <= now().toISOString()) return json(res, 410, { error: "expired", message: "邀请链接已过期；向项目的管理者要一个新的（POST /p/<project>/invites）" });
        if (req.method === "GET" && !inv[2]) return markdown(res, inviteManual({ base: origin, code: invite.code, project: owner.id, name: owner.name, expires: invite.expires_at }));
        if (req.method === "POST" && inv[2]) {
          const body = (await readJson(req)) as { agent_id?: unknown; role?: unknown; capabilities?: unknown };
          const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
          if (!agentId) return json(res, 400, { error: "agent_id", message: "给一个能稳定代表你这个 session 的 agent_id" });
          const caps = capabilitiesOf(body.capabilities);
          if (caps instanceof Error) return json(res, 400, { error: "capabilities", message: caps.message });
          const pstore = storeFor(owner.id);
          const result = await serialize(async () => {
            const state = reduce(await pstore.read(), now(), human);
            const roles = projectRoles(state);
            const nodes = await registry.nodes(owner.id);
            const mine = nodes.find((n) => n.agent_id === agentId);
            let role = mine?.role ?? (typeof body.role === "string" ? body.role.trim() : "");
            // t-234 判据 4：**人的身份不是一个可以加入的角色。** 名单是任何一个节点都写得动的一条事实，
            // 所以「role 等于 human」这件事不能由名单说了算——否则判定「是不是他」的依据就可以被别人写。
            if (role === human) return { status: 409, body: { error: "role", rule: "owner-key", message: joinNotAsHuman(human), available: roles.filter((r) => r !== human) } };
            if (role && !roles.includes(role)) return { status: 409, body: { error: "role", message: `${role} 不是这个项目的角色`, available: roles } };
            const first = nodes.length === 0;
            if (!role) {
              // the first node is pm (Q15); after that, the first role nobody present holds
              // 自动分配也不许分到人身上（判据 4：不许只堵显式指定那一半）
              const assignable = roles.filter((r) => r !== human);
              role = first && assignable.includes("pm") ? "pm" : assignable.find((r) => isMissing(state, r, now())) ?? "";
              if (!role) return { status: 409, body: { error: "full", message: "角色都在场；要顶替谁就指定 role", available: roles } };
            }
            const { key, created } = await registry.nodeKey(owner.id, agentId, role);
            // joining is the first pull: the node is listening as of now (its own sync starts from its local cursor)
            await pstore.setCursor({ actor: role, last_event_id: null, at: real().toISOString() });
            const out: unknown[] = [];
            if (caps !== null) out.push(await append(pstore, { kind: "reading", actor: role, surface: NODE_SURFACE, key: capabilityKey(role), value: caps, method: "节点加入时自报" }, { human, now: real() }));
            if (first && created) {
              out.push(await append(pstore, { kind: "reading", actor: role, surface: "team", key: "focus", value: "等 human 说这个项目是什么" }, { human, now: real() }));
              out.push(await append(pstore, { kind: "instruction", actor: role, to: human, body: "这个项目是什么？说一句。", intent: "ask", ack_by: new Date(Date.now() + 24 * 3600_000).toISOString() }, { human, now: real() }));
              // t-122: the call-out card is NOT sent here. It used to be sent unconditionally, while both the other
              // generator (contactWanted) and the page (contactEnabled) are gated on the fact project:alert.ask —
              // so a new project put a card in needs_human that the human could never see and never answer, and
              // 「不想要就点不要了」 was written on the card they could not reach. Off by default is pm 22:39's
              // decision after the human said 外呼地址先不做; the moment the fact is set, the follow-up above sends it.
            }
            for (const e of out) bus.emit("append", { project: owner.id, e });
            return { status: created ? 201 : 200, body: { role, node_key: key, project: owner.id, project_url: `${origin}/p/${encodeURIComponent(owner.id)}`, board_url: `${origin}/p/${encodeURIComponent(owner.id)}/`, manual: manual(role) ? manual(role)! + responsibilityAppendix(role, roleResponsibilities(state)[role] ?? []) : "", first, created } };
          });
          return json(res, result.status, result.body);
        }
        return json(res, 404, { error: "not found" });
      }

      const project = await registry.get(projectId);
      if (!project) return json(res, 404, { error: "not found", message: `没有项目 ${projectId}` });
      const store = storeFor(projectId);
      const cookieName = projectId === defaultProject ? COOKIE : `${COOKIE}_${projectId}`;
      // t-212：这一请求是谁在发、往哪本账记，供统一出口用。牌桌那几个按钮是人点的，所以先按人算；
      // 走 API 那一路解析出 x-actor 之后会改写它。存储也要在这里留一份引用——统一出口在 catch 里，
      // 而 catch 看不见 try 里声明的那个 store。
      whoIsAsking = human;
      refusalStore = store;

      // Who is speaking: the presented key (Bearer or cookie) resolved against the registry. The legacy shared
      // token is the default project's admin key. A key of another project is refused outright.
      const presented = bearer(req) ?? cookie(req, cookieName);
      const record: KeyRecord | null = presented ? await registry.lookup(presented) : null;
      if (record && record.project !== projectId) return json(res, 403, { error: "forbidden", message: "这把钥匙属于另一个项目" });
      const isAdmin = !!record && record.role === null;
      const isOwner = !!record && record.role === human;
      /**
       * t-234（P0）：**谁可以以主人的身份说话——只有主人自己那把钥匙。**
       *
       * 在此之前这是一个「借用窗口」：主人还没到过时，管理钥匙可以代他说话（下面 `ownerArrived` 那段注释写着
       * 为什么）。**而那个窗口从来没有关过**：本项目五天里 `owner_key.state` 一直是 `none`，主人从没到过，
       * 于是这道闸一次都没开始工作。qa 17:05 拿环境里的 token 把 `x-actor` 换成 `human`，`GET /board` 回 200、
       * 带着只给管理者的 `invite_url`——**任何持这把钥匙的节点都能以人的名义点掉他的卡**，而他手上此刻正挂着
       * 一张带选项的（「放行整合分支快进」）。
       *
       * **这是第二十五面：「有一道闸」不等于「这道闸此刻是合上的」。** 所以改成未配置就锁上：不看主人到过
       * 没有，一律只认他自己那把钥匙。当初怕的「一步打开会把主人锁在自己的牌桌外」有一条现成的出路，而且
       * pd 00:28 定稿的那句拒绝话里就写着它——`GET /owner-url`（持管理钥匙即可）把主人的地址原样再发一次。
       *
       * **五处，而不是四处**（判据 4）：API 的 `x-actor`、牌桌四个按钮、页面上按钮给不给点、「他看过了」那条游标，
       * **以及 token 小页面上的 `then=`**——它拿到钥匙之后紧接着把那个动作真的执行了，而那四个动作 append 时
       * `actor` 写死是 `human`。
       *
       * **第五处是 qa 18:26 找到的，而这段注释原来写的是「一处定义，四处使用」。** 它漏掉的那一处用的是另一个
       * 谓词（`ownerArrived()`），所以**按谓词数门，数不出用别的谓词的那扇门**；而这句自称完整的话，让「盘一遍」
       * 这件事看起来已经做过了。要数的是**所有会以 `human` 落事件的地方**，不是所有用这个谓词的地方。
       */
      const mayActAsHuman = isOwner;
      const authed = () => isAdmin || !!record;
      if (presented && record) await registry.markUsed(presented, now());   // t-103: first use is what flips this project
      /**
       * t-103: three kinds of key — admin, node, owner — and `X-Actor` is no longer taken as a statement of identity.
       * The owner's identity is the one that cannot be borrowed: impersonating the human is impersonating the final say.
       *
       * The upgrade is delivered with the enforcement rather than after it, because turning this on in one step would
       * lock a project's owner out of their own board — the one failure with no way back (pd 23:53). So: until the
       * owner's key has been used once, the admin key may still speak for them, and the board says so in as many words
       * (「这张牌桌还没有主人的钥匙」/「已把牌桌地址给出去了，还没人打开过」). The first time the owner opens their
       * own address, the project is upgraded and that borrowing is closed for good. It closes by itself, and it cannot
       * strand anyone: nothing is enforced until the person it protects has demonstrably arrived.
       */
      const ownerArrived = async () => !!(await registry.ownerKeyRecord(projectId, human))?.used_at;
      /**
       * t-103, pd 23:53 的兜底：在钥匙形态改变的前后各留一条事实，写清此刻可用的进门方式。人进不来时，第一个 agent
       * 靠管理钥匙照事实里的形态把地址重发一遍就行——不必读代码，也不必找我们。
       */
      const recordEntryForm = async (state: "issued" | "in_use") => {
        await append(store, {
          kind: "reading", actor: SERVICE_ACTOR, surface: PROJECT_SURFACE, key: ENTRY_FORM_KEY,
          value: { state, board_url: `${origin}${base}/?k=<主人钥匙>`, reissue: `GET ${origin}${base}/owner-url（要管理钥匙）`, cookie_max_age_s: COOKIE_MAX_AGE_S },
          method: state === "issued" ? "主人钥匙首次发出时由服务记下" : "主人第一次打开牌桌时由服务记下",
        }, { human, now: now() });
      };
      /** t-103: the three states — nobody was ever given an address, it was given, it has been opened. Read-only: asking is not giving. */
      const ownerKeyState = async (): Promise<Board["owner_key"]> => {
        const r = await registry.ownerKeyRecord(projectId, human);
        if (!r) return { state: "none" };
        return r.used_at ? { state: "in_use", since: r.used_at } : { state: "issued", since: r.created_at };
      };

      const remind = () => remindFor(projectId, store);

      // t-103: the owner lost their address. A node holding the admin key asks for it again — the key is derived, so
      // this is the same address as before, not a new one, and nothing had to be stored in the clear to say it.
      if (path === "/owner-url" && (req.method === "GET" || req.method === "POST")) {
        if (!isAdmin) return json(res, 401, { error: "unauthorized", message: "重新给出牌桌地址需要管理钥匙" });
        // t-234 判据 9：管理钥匙只是门槛的第一半。**第二半必须是任何节点手上都没有的东西**——
        // 这一路会「没有就造一把」主人钥匙并交出去，而第一个打开那条地址的人就永久是主人。
        if (!ownerSecret) return json(res, 403, { error: "forbidden", rule: "owner-key", message: OWNER_URL_LOCKED });
        const given = String(req.headers["x-owner-secret"] ?? "").trim();
        if (given !== ownerSecret) return json(res, 403, { error: "forbidden", rule: "owner-key", message: OWNER_URL_NEEDS_SECRET });
        const { key, record, created } = await registry.ownerKey(projectId, human);
        if (created) await recordEntryForm("issued");   // 钥匙第一次发出的那一刻
        const url_ = `${origin}${base}/?k=${encodeURIComponent(key)}`;
        return json(res, created ? 201 : 200, {
          board_url: url_, state: record.used_at ? "in_use" : "issued", since: record.used_at ?? record.created_at,
          say: `牌桌在这里：${url_}`,
        });
      }

      if (req.method === "POST" && path === "/invites") {
        if (!isAdmin) return json(res, 401, { error: "unauthorized", message: "重新签发邀请链接需要管理钥匙" });
        const invite = await registry.createInvite(projectId);
        return json(res, 201, { invite_url: `${origin}/invite/${invite.code}`, expires_at: invite.expires_at });
      }

      if (req.method === "GET" && path === "/") {
        // t-103: `k=` is the owner's own key, `token=` the admin key; both open the board and both set the cookie.
        const given = url.searchParams.get("k") ?? url.searchParams.get("token");
        if (given !== null) {
          const r = await registry.lookup(given);
          if (!r || r.project !== projectId || (r.role !== null && r.role !== human)) return html(res, 401, unauthorizedPage());
          const first = r.role === human && !r.used_at;
          await registry.markUsed(given, now());
          if (first) await recordEntryForm("in_use");   // 升级完成的那一刻
          const secure = proto === "https";
          res.writeHead(303, { location: `${base}/`, "set-cookie": `${cookieName}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}` });
          return res.end();
        }
        if (!boardPublic && !isAdmin && !isOwner) return html(res, 401, unauthorizedPage());
        // t-190 判据 2：**人打开牌桌，就是「人再看到那一刻」。**一张被退回待答的卡，期限从这一刻起重算，
        // 而在此之前它不算晚——他没看到的时间不该算进他的期限里。agent 那头这件事早就有（`pull` 记游标），
        // 人这头一直没有：他只是看，从不拉。所以这里记一次，与 agent 的 pull 同一个意思、同一份 presence。
        // 只在他真的有权看这块牌桌时记；匿名的一眼不算他看过。
        //
        // **`last_event_id` 要原样带上**：这一行是 upsert，写 null 会把他读到哪儿抹掉，于是发给他的每一条都
        // 变回「还没读到」，t-050 那套「人很久没答」的外呼就会照着一个假前提去叫人。这里只动时间，不动位置。
        // t-234 判据 4 的第四处：**这一行是替他写「他看过了」。** qa 17:07 点名的正是这一半——一个假的「已答」
        // 很显眼，一个假的「已读」不显眼，它只是让一条本该还挂着的东西安静地消失（它自己 03:36 造过一次）。
        // 所以这里也只认主人自己那把钥匙：管理钥匙打开牌桌，不算他看过。
        if (mayActAsHuman) {
          const before = await stateFor(projectId, store);
          await store.setCursor({ actor: human, last_event_id: before.read_upto.get(human) ?? null, at: real().toISOString() });
        }
        await remind();
        const state = await stateFor(projectId, store);
        const b = board(state, human, now());
        if (isAdmin) b.invite_url = `${origin}/invite/${(await registry.currentInvite(projectId)).code}`;
        b.owner_key = await ownerKeyState();
        return html(res, 200, renderBoard(b, state, { sha, canDecide: mayActAsHuman, human, base, ask: url.searchParams.get("ask") }));
      }

      // t-133: the detail page behind the 线上 row. Same rules as the board and a task page: public unless private.
      if (req.method === "GET" && wantsHtml && (path === "/release" || path === "/release/")) {
        if (!boardPublic && !isAdmin) return html(res, 401, unauthorizedPage());
        const state = reduce(await store.read(), undefined, human);
        return html(res, 200, renderRelease(board(state, human), state, { sha, human, base }));
      }

      // t-065: one task in full, same rules as the board (public unless the board is private).
      if (req.method === "GET" && wantsHtml && path.startsWith("/task/")) {
        if (!boardPublic && !isAdmin) return html(res, 401, unauthorizedPage());
        const state = await stateFor(projectId, store);
        const out = renderTask(board(state, human), state, decodeURIComponent(path.slice("/task/".length)), { sha, human, base });
        return out ? html(res, 200, out) : html(res, 404, notFoundPage(base));
      }

      const back = () => { res.writeHead(303, { location: `${base}/` }); res.end(); };
      const emitAll = (events: unknown[]) => { for (const e of events) bus.emit("append", { project: projectId, e }); };

      // The board's buttons. Each is one form POST as the human; `act` does the writing so the token page can
      // run the same action right after the key is entered (docs/board.md: buttons are always clickable).
      const ACTIONS = new Set(["/ack", "/say", "/decide", "/fact"]);
      /**
       * t-212（qa 16:19 找到的洞）：**牌桌按钮那条路不走 validate**，所以它被挡住的那几次一条都没被数进
       * 拒绝账——而那正是最该数的一条路：全队只有它是**人**被挡住。
       * 记在这一处而不是每一个 `return { status: 409 }` 上，与 core 里记在唯一那条写入路径上是同一条道理：
       * 下一个人再加一条拒绝分支，不必记得来这里加一行。
       */
      const actAndCount = async (then: string, form: URLSearchParams): Promise<{ status: number; body: unknown }> => {
        const r = await act(then, form);
        if (r.status >= 400 && store.recordRefusal) {
          const b = (r.body ?? {}) as { rule?: unknown; error?: unknown };
          const rule = typeof b.rule === "string" ? b.rule : typeof b.error === "string" ? b.error : "unknown";
          await store.recordRefusal({ kind: "refused", who: human, rule, op: `${req.method} ${then}`, id: ulid(now().getTime()), at: now().toISOString() });
        }
        return r;
      };
      const act = async (then: string, form: URLSearchParams): Promise<{ status: number; body: unknown }> => {
        if (then === "/ack") {
          // 「知道了」/「做好了」/「起好了」: ack. 「先不做」: the same, with a note saying why it is not happening now (t-036);
          // when the instruction names a task, the note hangs on that task too. Several ids ack together (t-043).
          const ids = form.getAll("id").filter(Boolean), of = ids[0] ?? "", why = (form.get("note") ?? "").trim();
          const events = await serialize(async () => {
            const st = (await stateFor(projectId, store)).instructions.get(of);
            const out = [await append(store, { kind: "ack", actor: human, of }, { human, now: real() })];
            for (const more of ids.slice(1)) {
              const fresh = (await stateFor(projectId, store)).instructions.get(more);
              if (fresh && !fresh.acked_at) out.push(await append(store, { kind: "ack", actor: human, of: more }, { human, now: real() }));
            }
            if (why) {
              const task = /\bt-\d+\b/.exec(st?.instruction.body ?? "")?.[0];
              const known = task && (await stateFor(projectId, store)).tasks.has(task) ? task : undefined;
              out.push(await append(store, { kind: "note", actor: human, body: `${DEFER_PREFIX}${why}`, refs: [of], task: known }, { human, now: real() }));
            }
            return out;
          });
          emitAll(events);
          return { status: 201, body: { events } };
        }
        if (then === "/say") {
          // The human says one sentence: a note in their name, prefixed so the board can follow it (t-030).
          const text = (form.get("text") ?? "").trim();
          if (!text) return { status: 400, body: { error: "empty", message: "说点什么再点「说」" } };
          if (text.length > SAID_MAX_CHARS) return { status: 400, body: { error: "too long", message: `一句话最多 ${SAID_MAX_CHARS} 字（现在 ${text.length}）；不够就再说一句` } };
          const note = await serialize(() => append(store, { kind: "note", actor: human, body: `${SAID_PREFIX}${text}` }, { human, now: real() }));
          emitAll([note]);
          return { status: 201, body: note };
        }
        if (then === "/decide") {
          // One click: ack the instruction and record the decision, in one request.
          const of = form.get("id") ?? "", option = form.get("option") ?? "";
          const st = (await stateFor(projectId, store)).instructions.get(of);
          if (!st) return { status: 404, body: { error: "not found", message: `${of} is not an instruction` } };
          const i = st.instruction;
          // t-212（pm 16:23）：**这两条从「自己拼一个 409」改成 throw Rejected，走统一出口。** 在两处各补
          // 一次记账等于又一份靠人维护的名单，而这件事的全部教训就是名单会漏（今晚已漂四次）。
          if (!i.options?.includes(option)) throw new Rejected("decide", `"${option}" is not one of: ${(i.options ?? []).join(" | ")}`);
          if (st.chosen && st.chosen.by !== DEFAULT_DECIDER) throw new Rejected("decide", `${of} already decided: ${st.chosen.option} by ${st.chosen.by}`);
          // Inside the write lock, look again: a click that raced another one must not half-apply.
          // t-069: 填写 on the contact card carries the address; it becomes the fact the call-outs read
          const filling = isContactAsk(i.body) && (option === CONTACT_FILL || option === CONTACT_FILL_WAS);   // 老卡带的是旧那个词
          const contact = filling ? (form.get("value") ?? "").trim() : "";
          if (filling && !contact) return { status: 400, body: { error: "value", message: `填一个 https:// 开头的 webhook 地址；不想填就选「${i.options?.[1] ?? CONTACT_SKIP}」` } };
          const [note, ...followed] = await serialize(async () => {
            const fresh = (await stateFor(projectId, store)).instructions.get(of)!;
            if (!fresh.acked_at) emitAll([await append(store, { kind: "ack", actor: human, of }, { human, now: real() })]);
            const n = await append(store, { kind: "note", actor: human, body: `decision: ${i.body} -> ${option}${contact ? `：${contact}` : ""}`, decision: true, decides: { of, option }, refs: [of] }, { human, now: real() });
            const out = [n, ...(await runFollowUps(store, n, human, real()))]; // t-055: the human's 过/不过 becomes a verify, and a fail notice
            if (contact) out.push(await append(store, { kind: "reading", actor: human, surface: PROJECT_SURFACE, key: ALERT_WEBHOOK_KEY, value: contact, method: "牌桌上填写（起项目第二张卡）", refs: [n.id] }, { human, now: real() }));
            return out;
          });
          emitAll([note, ...followed]);
          return { status: 201, body: note };
        }
        if (then === "/fact") {
          // t-069: the address changed from the grey line under 线上: the fact alone, in the human's name.
          const key = form.get("key") ?? "", value = (form.get("value") ?? "").trim();
          // The feature is fact-gated (pm 22:39): with it off there is no entrance, so no route either.
          if (!contactEnabled(board(await stateFor(projectId, store), human, now()))) return { status: 404, body: { error: "not found", message: "这个项目没有开启外呼地址" } };
          if (key !== ALERT_WEBHOOK_KEY) return { status: 400, body: { error: "key", message: `牌桌上只能填 ${ALERT_WEBHOOK_KEY}` } };
          if (!/^https?:\/\/\S+$/.test(value)) return { status: 400, body: { error: "value", message: "填一个 https:// 开头的 webhook 地址" } };
          const reading = await serialize(() => append(store, { kind: "reading", actor: human, surface: PROJECT_SURFACE, key, value, method: "牌桌上改的（线上一行下的灰字）" }, { human, now: real() }));
          emitAll([reading]);
          return { status: 201, body: reading };
        }
        return { status: 404, body: { error: "not found" } };
      };

      /**
       * t-103 (qa 01:05): these four write as `human`, so the same rule governs them as governs POST /events — the page
       * is not a second door with older locks. t-234 closed the upgrade window that used to let the shared key press
       * them: only the owner's own key does, whether or not they have ever arrived.
       */
      if (req.method === "POST" && ACTIONS.has(path)) {
        const body = await readText(req);
        if (!mayActAsHuman) {
          // qa 01:08 ④: a button is always pressable (docs/board.md). Nobody signed in — a cookie that ran out, a page
          // left open — is not a dead end: it is the moment to ask for the address, then do the thing they pressed.
          if (!isAdmin && !isOwner) {
            const fields: Record<string, string> = { then: path };
            for (const [k, v] of new URLSearchParams(body)) if (k !== "token") fields[k] = v;
            return html(res, 401, tokenPage(fields, false, base));
          }
          return json(res, 403, { error: "forbidden", rule: "owner-key", message: OWNER_ONLY(human) });
        }
        const r = await actAndCount(path, new URLSearchParams(body));
        if (r.status < 300 && wantsHtml) return back();
        return json(res, r.status, r.body);
      }

      // The token page: a form posts here with `then` (the action) and its fields; without the key it asks for
      // one; with this project's admin key it sets the cookie, performs the action, and returns to the board.
      if (path === "/token" && (req.method === "GET" || req.method === "POST")) {
        const form = new URLSearchParams(req.method === "POST" ? await readText(req) : url.search);
        const fields: Record<string, string> = {};
        for (const [k, v] of form) if (k !== "token") fields[k] = v;
        const given = keyFromPaste(form.get("token"));
        if (given === null) return html(res, 200, tokenPage(fields, false, base));
        const r0 = await registry.lookup(given);
        // t-103: the owner's own key belongs here too — it is the key their address carries, and the one this page asks for.
        if (!r0 || r0.project !== projectId || (r0.role !== null && r0.role !== human)) return html(res, 401, tokenPage(fields, true, base, pasteShape(form.get("token") ?? "")));
        // t-234（qa 18:26 找到的**第五扇门**）：**这一页也在替人办事。** 它拿到钥匙之后紧接着就把 `then` 那个动作
        // 真的执行了，而那四个动作 append 时 `actor` 写死是 `human`。原来这里问的是「主人到过没有」——
        // 而 `owner_key = none` 时那个问法永远为假，于是同一把管理钥匙在 `POST /say` 上被拒、在这一页上被放进来，
        // 并以人的名义落下 ack 与决策。**这一处不进那份「一处定义四处使用」的名单，正因为它用的是另一个谓词**：
        // 按谓词数门，数不出用别的谓词的那扇门（qa 18:27 的话）。
        //
        // 所以改成与 API、与牌桌按钮同一条规则：**要替他办事，只认他自己那把钥匙**；不问他到过没有。
        // 换钥匙进门（`then` 为空）照旧——管理钥匙进得来看，只是按不动他的按钮。
        if (ACTIONS.has(fields.then ?? "") && r0.role !== human) return json(res, 403, { error: "forbidden", rule: "owner-key", message: OWNER_ONLY(human) });
        // t-103 原来那道闸留着（主人到过之后，共享钥匙不再是「人」的入口）——它管的是进门，上面那条管的是办事，
        // 两条各守一半：只留 t-103 那条，`owner_key = none` 时它永远为假；只留上面那条，主人到场后仍能拿共享钥匙换到 cookie。
        if (r0.role === null && (await ownerArrived())) return json(res, 403, { error: "forbidden", rule: "owner-key", message: OWNER_ONLY(human) });
        await registry.markUsed(given, now());
        const secure = proto === "https";
        const setCookie = `${cookieName}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`;
        const then = fields.then ?? "";
        const r = ACTIONS.has(then) ? await actAndCount(then, new URLSearchParams(fields)) : { status: 204, body: null };
        if (r.status >= 300) { res.writeHead(r.status, { "content-type": "application/json", "set-cookie": setCookie }); return res.end(JSON.stringify(r.body)); }
        res.writeHead(303, { location: `${base}/`, "set-cookie": setCookie });
        return res.end();
      }

      // The API: a key of this project, and an identity. A node key is bound to its role; an admin key may speak as anyone.
      if (!record) return json(res, 401, { error: "unauthorized" });
      const actor = String(req.headers["x-actor"] ?? "").trim();
      whoIsAsking = actor || human;
      if (!actor) return json(res, 400, { error: "X-Actor header is required" });
      if (record.role !== null && actor !== record.role) return json(res, 403, { error: "forbidden", message: `这把钥匙是 ${record.role} 的，不能以 ${actor} 说话` });
      // t-103: the service's own identity is never lent out, and the owner's is lent only until they first arrive.
      if (actor === SERVICE_ACTOR && record.role !== SERVICE_ACTOR)
        return json(res, 403, { error: "forbidden", message: `${SERVICE_ACTOR} 是服务自己的身份，任何钥匙都不能以它说话。要服务替你说一句，就让它自己触发（例如发一张卡）` });
      // t-234：不再问「主人到过没有」。**未配置就锁上**：不是他自己那把钥匙，就不能以他的身份说话——
      // 读也不行，`invite_url` 这类只给管理者的字段因此也不会顺着这条路出去（判据 3）。
      if (actor === human && !mayActAsHuman)
        return json(res, 403, { error: "forbidden", rule: "owner-key", message: OWNER_ONLY(human) });

      // t-137: the two ways of not listening are not one thing. A node can already tell that its own watch died
      // (t-102, from its heartbeat file); it cannot tell that the *server* has stopped seeing it pull, because a
      // heartbeat that is still beating says nothing about a cursor that has stopped moving. So every answer carries
      // how long it has been, in seconds, since this actor last pulled — a number, not a verdict, because the node is
      // the one that knows whether its watch is alive and the two want opposite remedies.
      const pulled = (await stateFor(projectId, store)).presence.get(actor)?.last_pull ?? null;
      res.setHeader("x-ateam-pull-idle", pulled ? String(Math.max(0, Math.round((now().getTime() - Date.parse(pulled)) / 1000))) : "never");

      if (req.method === "GET" && path === "/board") {
        await remind();
        // t-212：拒绝账从存储取，交给 board 数。**存储答不出来就不交，牌桌上那一格是 null 而不是 0**——
        // 「数不出来」与「一次都没被拒过」是两件事，今晚这个洞的形状就是把前者说成了后者。
        const b = board(await stateFor(projectId, store), human, now(), { refusals: await store.refusals?.() });
        if (isAdmin) b.invite_url = `${origin}/invite/${(await registry.currentInvite(projectId)).code}`;
        b.owner_key = await ownerKeyState();
        // t-070/t-080 (pm 22:45): the slim board goes to a client that says it knows it (X-Ateam-Client: <shape it speaks>);
        // a client without the header — an older CLI — gets the full board and never breaks. ?full=1 always means full.
        const knowsSlim = Number(req.headers["x-ateam-client"]) >= 2;
        return json(res, 200, url.searchParams.get("full") || !knowsSlim ? b : slimBoard(b));
      }

      if (req.method === "GET" && path === "/log") return json(res, 200, { events: await store.since(url.searchParams.get("after")) });

      // t-068: one task in full, for a page that inlines only this version's tasks and fetches the rest on demand
      const taskPath = /^\/task\/([^/]+)$/.exec(path);
      if (req.method === "GET" && taskPath) {
        const id = decodeURIComponent(taskPath[1]);
        const state = await stateFor(projectId, store);
        const b = board(state, human, now());
        const task = Object.values(b.tasks).flat().find((t) => t.id === id);
        if (!task) return json(res, 404, { error: "not found", message: `日志里没有任务 ${id}` });
        return json(res, 200, { shape: b.shape, task, seams: b.seams.filter((x) => x.tasks.includes(id)), refs: state.tasks.get(id)?.refs ?? [] });
      }

      if (req.method === "GET" && path === "/events") {
        const after = url.searchParams.get("after");
        const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, maxWait);
        let result = await pull(store, actor, after, real());
        if (!result.events.length && wait > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, wait);
            function onAppend(x: { project: string }) { if (x.project === projectId) done(); }
            function done() { clearTimeout(timer); bus.off("append", onAppend); resolve(); }
            bus.on("append", onAppend);
            req.on("close", done);
          });
          result = await pull(store, actor, after, real());
        }
        // t-147 criterion 6: what this role owes right now, on the way out. It comes off the reduction the server
        // already keeps moving (t-128), so it costs no full read of the log and no second request; and it is computed
        // after `pull` recorded the cursor, so everything in this batch already counts as read.
        const st = await stateFor(projectId, store);
        const owed = owedNow(st, actor);
        // t-211：**每一次 pull 都顺带说一句服务此刻跑的是哪一版、至今上过几次线。** 命令行各人各自 build，
        // 发车只换服务端，所以「我手上这份是不是上线的那一版」这个问题今晚没有任何一处答得出。两样都从
        // 已经算好的那份状态里取，不多读一次日志、不多发一次请求——与 owed 同一条路。
        const deploys = deployHistory(st).map((d) => d.sha);
        return json(res, 200, { shape: BOARD_SHAPE, ...result, owed, sha, deploys }); // t-080: sync checks the shape before reading fields
      }

      if (req.method === "POST" && path === "/events") {
        const body = (await readJson(req)) as NewEvent;
        const ne = { ...body, actor } as NewEvent;
        // t-088: an event that carries `from` is written once; a repeat returns the first one, and says so
        const [{ event: e, created }, ...followed] = await serialize(async () => {
          const x = await appendFrom(store, ne, { human, now: real() });
          return [x, ...(x.created ? await runFollowUps(store, x.event, human, real()) : []).map((event) => ({ event, created: true }))];
        });
        emitAll([e, ...followed.map((x) => x.event)]);
        // t-227：**回包顺带告诉它「此刻有谁点名找你、你欠着什么」。**
        //
        // 外部报告 F1 的第二条：mini 00:42 连发 5 条事件，而 be 00:37 发给它的「停掉生产探针」一直是 unread——
        // **一个正在活跃发帖的节点，对发给自己的 P0 指令一无所知**，因为 POST 的回包里什么都没有。本队五天里
        // pd 与 release 也各出现过一次「写了但从不拉取」。
        //
        // 两样都从服务已经在动的那份状态里取（同 GET 那一路的 owed），不多读一次日志；两样都受 POST_REPLY_BYTES
        // 限——**拉取是开工时的一两次，写事件是整天都在做的事**，这笔钱每次都要付。
        const pst = await stateFor(projectId, store);
        // t-227 判据 3（重做）：**一个上限，一份预算**——先扣掉事件本身，剩下的由 for_me 与 owed 分。
        const reply = { ...e, created };
        return json(res, created ? 201 : 200, { ...reply, ...postReply(pst, actor, reply) });
      }

      /**
       * t-218：**命令行自己抛的那几种拒绝从这里进同一本账。** 那些写入根本没发出去（`decide.ts` 那四条、
       * 用法错的那几条），所以 t-212 那两个出口一条都看不见——它们只活在各人终端里。各人的命令行把它们记在
       * 自己机器上，**在下一次通信里捎上来**。
       *
       * 三条边界：
       * · **who 一律是这把钥匙说话的那个人**，不认正文里的 who——补的是自己的账，不是替别人记账。
       * · **op 必须带 `cli ` 前缀**，否则这一路补上来的记录会混进服务端那一栏，两栏并排数就白排了。
       * · **记不下就不说记下了**：这个存储没有这本账时回一份空名单，命令行那边就不划掉、下次再捎。
       *   一个「其实没记下却回了成功」的答复，正是这件任务在修的那个病换个方向再来一次。
       */
      if (req.method === "POST" && path === "/refusals") {
        const body = (await readJson(req)) as { refusals?: unknown };
        const batch = (Array.isArray(body?.refusals) ? body.refusals : []).slice(0, CLI_REFUSAL_BATCH_MAX);
        const recorded: string[] = [];
        // **同一条捎两遍只算一次。** id 是命令行那边给的（它要凭 id 知道划掉哪几条），于是「捎成了没听见回答、
        // 下一条命令再捎一遍」会把账撑大——而 t-212 已经为一本会虚高的账付过一次账了。sqlite 那本自己会认 id
        // （INSERT OR IGNORE），**但那是某一个存储的性子，不是这条路的规矩**：在这里认一次，换哪个存储都一样。
        const known = new Set((await store.refusals?.() ?? []).map((r) => r.id));
        for (const raw of batch) {
          const r = (raw ?? {}) as Partial<Refused>;
          if (typeof r.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(r.id)) continue;
          if (typeof r.rule !== "string" || !r.rule.trim()) continue;
          if (!store.recordRefusal) break;
          if (known.has(r.id)) { recorded.push(r.id); continue; }   // 记过了就是记下了：让命令行划掉它
          const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : now().toISOString();
          const op = typeof r.op === "string" && isCliRefusal(r.op) ? r.op.slice(0, 60) : cliRefusalOp("?");
          await store.recordRefusal({ kind: "refused", who: actor, rule: r.rule.trim().slice(0, 60), op, id: r.id, at });
          recorded.push(r.id);
        }
        return json(res, 200, { recorded, counted: Boolean(store.recordRefusal) });
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof Rejected) {
        // t-212：**Rejected 的唯一出口，也是记账的唯一出口。** 任何一条走到这里的拒绝都被数进去，
        // 不管它是 validate 抛的还是某个处理器自己抛的——下一个人再加一条拒绝，不必记得来这里补一行。
        // t-212（qa 16:32）：从 appendFrom 抛出来的那一条已经在写入路径上记过了，这里跳过——否则走 API
        // 那一路记两次、处理器自己抛的记一次，账是不均匀的虚高。
        if (!err.recorded) await refusalStore?.recordRefusal?.({ kind: "refused", who: whoIsAsking, rule: err.rule, op: `${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`, id: ulid(real().getTime()), at: real().toISOString() });
        return json(res, 409, { error: "rejected", rule: err.rule, message: err.message });
      }
      if (err instanceof SyntaxError) return json(res, 400, { error: "bad json" });
      console.error(err);
      return json(res, 500, { error: "internal", message: (err as Error).message });
    }
  });
  server.on("close", () => { if (timer) clearInterval(timer); });
  return server;
}

/**
 * What a joining node says it can do (t-058): an object whose `push` is one of PUSH_LEVELS (default none), plus anything
 * else it wants known; or the older plain list of words (push none). null when nothing was said; an Error when it is malformed.
 */
export function capabilitiesOf(raw: unknown): Record<string, unknown> | string[] | null | Error {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) {
    const words = raw.filter((c): c is string => typeof c === "string" && !!c.trim());
    return words.length ? words : null;
  }
  if (typeof raw !== "object") return new Error("capabilities 是一个对象，比如 {\"push\":\"own-branch\"}");
  const o = { ...(raw as Record<string, unknown>) };
  const push = o.push === undefined ? "none" : o.push;
  if (typeof push !== "string" || !(PUSH_LEVELS as readonly string[]).includes(push))
    return new Error(`capabilities.push 只能是 ${PUSH_LEVELS.join(" | ")}，不是 ${JSON.stringify(o.push)}`);
  return { ...o, push };
}

/** "16m", "2h", "90s", "500ms" or a plain number of milliseconds; NaN when it is none of those. */
export function parseOffset(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(raw);
  if (!m) return NaN;
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 } as Record<string, number>)[m[2] ?? "ms"];
}

/** t-069 / pm 22:39: does the project want the contact card? A valid project:alert.ask fact with any non-empty value. */
function contactWanted(s: ReturnType<typeof reduce>): boolean {
  const id = s.latestReading.get(`${PROJECT_SURFACE}:${ALERT_ASK_KEY}`);
  const r = id ? s.readings.get(id) : undefined;
  const v = r?.valid && !r.expired ? r.reading.value : undefined;
  return v !== undefined && v !== null && v !== false && v !== "" && v !== 0;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = String(req.headers.authorization ?? "");
  return h.startsWith("Bearer ") ? h.slice(7).trim() || undefined : undefined;
}

function markdown(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) reject(new SyntaxError("too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const data = await readText(req);
  return data ? JSON.parse(data) : {};
}