import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { append, pull, reduce, board, manual, welcome, inviteManual, projectRoles, isMissing, missingRoleOf, MemoryStore, Rejected, type EventStore, type NewEvent, DEFAULT_DECIDER, SAID_PREFIX, SAID_MAX_CHARS, DEFER_PREFIX, SERVICE_ACTOR, PRESENCE_WINDOW_MS } from "@ateam/core";
import { renderBoard, unauthorizedPage } from "./html.js";
import { MemoryRegistry, type Registry, type KeyRecord } from "./projects.js";
import { runAlerts } from "./alerts.js";

/** After the human acks a missing-role card, no new card for that role for this long (pm decision 14:15). */
export const REMIND_COOLDOWN_MS = 15 * 60_000;

const COOKIE = "ateam_token";

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
}

/** Many projects, each one log and its own keys; the unprefixed address is the default project. Identity is the X-Actor header. */
export function createApp(opts: ServerOptions) {
  const { token, human } = opts;
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
  let lastOrigin = opts.publicUrl ?? "";
  const boardUrl = (p: string) => `${(opts.publicUrl ?? lastOrigin) || "http://localhost"}${p === defaultProject ? "/" : `/p/${encodeURIComponent(p)}/`}`;
  // t-050: the service calls out on its own clock; no node needs to be online for this
  const alertInterval = opts.alertIntervalMs ?? 60_000;
  const timer = alertInterval > 0 ? setInterval(async () => {
    try { for (const p of await registry.list()) await runAlerts(p.id, storeFor(p.id), { fetch: (u, i) => fetch(u, i), human, boardUrl }); }
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

  const server = createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url ?? "/", "http://x");
      const proto = String(req.headers["x-forwarded-proto"] ?? "").includes("https") ? "https" : "http";
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
      const origin = `${proto}://${host}`;
      lastOrigin = origin;
      const wantsHtml = String(req.headers.accept ?? "").includes("text/html") || url.searchParams.has("token");

      if (url.pathname === "/health") return json(res, 200, { ok: true, sha });

      // Which project, and what path inside it. /p/<id>/... names one; anything else is the default project.
      const m = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      const projectId = m ? decodeURIComponent(m[1]) : defaultProject;
      const path = m ? (m[2] || "/") : url.pathname;
      const base = m ? `/p/${encodeURIComponent(projectId)}` : "";

      // Global: the newcomer's manual, and the role manuals. Generic by construction, so they need no key.
      if (req.method === "GET" && (path === "/manual" || (path === "/" && !wantsHtml && !m))) return markdown(res, welcome(origin));
      if (req.method === "GET" && path.startsWith("/manual/")) {
        const text = manual(decodeURIComponent(path.slice("/manual/".length)));
        if (text === null) return json(res, 404, { error: "not found", message: "no manual for that role" });
        return markdown(res, text);
      }

      // A new project: one board, one log, one key. The key is in this response and nowhere else.
      if (req.method === "POST" && path === "/projects" && !m) {
        const body = (await readJson(req)) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return json(res, 400, { error: "name", message: "给项目一个名字：{\"name\": \"...\"}" });
        const { project, admin_key, invite } = await registry.create(name);
        return json(res, 201, {
          project: project.id, name: project.name,
          board_url: `${origin}/p/${encodeURIComponent(project.id)}/`, project_url: `${origin}/p/${encodeURIComponent(project.id)}`,
          admin_key, invite_url: `${origin}/invite/${invite.code}`, invite_expires_at: invite.expires_at,
        });
      }

      // Invite links (t-042): the page explains how to join; POST .../join exchanges the code for a node key.
      const inv = /^\/invite\/([^/]+)(\/join)?$/.exec(url.pathname);
      if (inv) {
        const invite = await registry.getInvite(decodeURIComponent(inv[1]));
        if (!invite) return json(res, 404, { error: "not found", message: "没有这个邀请链接" });
        const owner = (await registry.get(invite.project))!;
        if (invite.expires_at <= new Date().toISOString()) return json(res, 410, { error: "expired", message: "邀请链接已过期；向项目的管理者要一个新的（POST /p/<project>/invites）" });
        if (req.method === "GET" && !inv[2]) return markdown(res, inviteManual({ base: origin, code: invite.code, project: owner.id, name: owner.name, expires: invite.expires_at }));
        if (req.method === "POST" && inv[2]) {
          const body = (await readJson(req)) as { agent_id?: unknown; role?: unknown; capabilities?: unknown };
          const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
          if (!agentId) return json(res, 400, { error: "agent_id", message: "给一个能稳定代表你这个 session 的 agent_id" });
          const pstore = storeFor(owner.id);
          const result = await serialize(async () => {
            const state = reduce(await pstore.read());
            const roles = projectRoles(state);
            const nodes = await registry.nodes(owner.id);
            const mine = nodes.find((n) => n.agent_id === agentId);
            let role = mine?.role ?? (typeof body.role === "string" ? body.role.trim() : "");
            if (role && !roles.includes(role)) return { status: 409, body: { error: "role", message: `${role} 不是这个项目的角色`, available: roles } };
            const first = nodes.length === 0;
            if (!role) {
              // the first node is pm (Q15); after that, the first role nobody present holds
              role = first && roles.includes("pm") ? "pm" : roles.find((r) => isMissing(state, r, new Date())) ?? "";
              if (!role) return { status: 409, body: { error: "full", message: "角色都在场；要顶替谁就指定 role", available: roles } };
            }
            const { key, created } = await registry.nodeKey(owner.id, agentId, role);
            // joining is the first pull: the node is listening as of now (its own sync starts from its local cursor)
            await pstore.setCursor({ actor: role, last_event_id: null, at: new Date().toISOString() });
            const caps = Array.isArray(body.capabilities) ? body.capabilities.filter((c): c is string => typeof c === "string" && !!c.trim()) : [];
            const out: unknown[] = [];
            if (caps.length) out.push(await append(pstore, { kind: "reading", actor: role, surface: "node", key: `${role}:能力`, value: caps, method: "节点加入时自报" }, { human }));
            if (first && created) {
              out.push(await append(pstore, { kind: "reading", actor: role, surface: "team", key: "focus", value: "等 human 说这个项目是什么" }, { human }));
              out.push(await append(pstore, { kind: "instruction", actor: role, to: human, body: "这个项目是什么？说一句。", intent: "ask", ack_by: new Date(Date.now() + 24 * 3600_000).toISOString() }, { human }));
            }
            for (const e of out) bus.emit("append", { project: owner.id, e });
            return { status: created ? 201 : 200, body: { role, node_key: key, project: owner.id, project_url: `${origin}/p/${encodeURIComponent(owner.id)}`, board_url: `${origin}/p/${encodeURIComponent(owner.id)}/`, manual: manual(role) ?? "", first, created } };
          });
          return json(res, result.status, result.body);
        }
        return json(res, 404, { error: "not found" });
      }

      const project = await registry.get(projectId);
      if (!project) return json(res, 404, { error: "not found", message: `没有项目 ${projectId}` });
      const store = storeFor(projectId);
      const cookieName = projectId === defaultProject ? COOKIE : `${COOKIE}_${projectId}`;

      // Who is speaking: the presented key (Bearer or cookie) resolved against the registry. The legacy shared
      // token is the default project's admin key. A key of another project is refused outright.
      const presented = bearer(req) ?? cookie(req, cookieName);
      const record: KeyRecord | null = presented ? await registry.lookup(presented) : null;
      if (record && record.project !== projectId) return json(res, 403, { error: "forbidden", message: "这把钥匙属于另一个项目" });
      const isAdmin = !!record && record.role === null;
      const authed = () => isAdmin || !!record;

      // A role that has gone quiet with work in its hands: a card for the human, at most one per role per absence (pm 14:15).
      const remind = async () => {
        const events = await serialize(async () => {
          const state = reduce(await store.read());
          const now = new Date();
          const out: unknown[] = [];
          const b = board(state, human, now);
          for (const role of projectRoles(state)) {
            if (!isMissing(state, role, now)) continue;
            const overdue = [...state.instructions.values()].filter((st) => st.instruction.to === role && !st.acked_at && st.overdue);
            const undelivered = b.undelivered.find((u) => u.to === role);
            if (!overdue.length && !undelivered) continue;
            const cards = [...state.instructions.values()].filter((st) => st.instruction.actor === SERVICE_ACTOR && missingRoleOf(st.instruction.body) === role);
            if (cards.some((st) => !st.acked_at)) continue;
            const lastAck = cards.map((st) => st.acked_at).filter((x): x is string => !!x).sort().pop();
            if (lastAck && now.getTime() - Date.parse(lastAck) < REMIND_COOLDOWN_MS) continue;
            const last = state.presence.get(role)?.last_pull;
            const minutes = last ? Math.round((now.getTime() - Date.parse(last)) / 60_000) : Math.round(PRESENCE_WINDOW_MS / 60_000);
            // one card per role: "not receiving" when instructions never arrived, else "missing with work in hand"
            // pd's three words: 在听 / 没在听 / 缺人. A role that stopped pulling with work undelivered is 没在听; one with nothing arriving at all is 缺人.
            const body = undelivered
              ? `${role} 没在听了 ${minutes} 分钟，${undelivered.count} 条指令没送到。起一个 ${role}？`
              : `${role} 已经缺了 ${minutes} 分钟，手里有 ${overdue.length} 条指令。起一个 ${role}？`;
            const refs = [...new Set([...overdue.map((st) => st.instruction.id), ...[...state.instructions.values()].filter((st) => st.instruction.to === role && !st.delivered_at && !st.acked_at).map((st) => st.instruction.id)])];
            out.push(await append(store, { kind: "instruction", actor: SERVICE_ACTOR, to: human, intent: "do", body, ack_by: new Date(now.getTime() + 24 * 3600_000).toISOString(), refs }, { human }));
          }
          return out;
        });
        for (const e of events) bus.emit("append", { project: projectId, e });
      };

      if (req.method === "POST" && path === "/invites") {
        if (!isAdmin) return json(res, 401, { error: "unauthorized", message: "重新签发邀请链接需要管理钥匙" });
        const invite = await registry.createInvite(projectId);
        return json(res, 201, { invite_url: `${origin}/invite/${invite.code}`, expires_at: invite.expires_at });
      }

      if (req.method === "GET" && path === "/") {
        const given = url.searchParams.get("token");
        if (given !== null) {
          const r = await registry.lookup(given);
          if (!r || r.project !== projectId || r.role !== null) return html(res, 401, unauthorizedPage());
          const secure = proto === "https";
          res.writeHead(303, { location: `${base}/`, "set-cookie": `${cookieName}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` });
          return res.end();
        }
        if (!boardPublic && !isAdmin) return html(res, 401, unauthorizedPage());
        await remind();
        const state = reduce(await store.read());
        const b = board(state, human);
        if (isAdmin) b.invite_url = `${origin}/invite/${(await registry.currentInvite(projectId)).code}`;
        return html(res, 200, renderBoard(b, state, { sha, canDecide: isAdmin, human, base }));
      }

      const back = () => { res.writeHead(303, { location: `${base}/` }); res.end(); };
      const emitAll = (events: unknown[]) => { for (const e of events) bus.emit("append", { project: projectId, e }); };

      // One click on the board: the human acks an instruction, and may say why it is not happening now.
      if (req.method === "POST" && path === "/ack") {
        if (!isAdmin) return html(res, 401, unauthorizedPage());
        const form = new URLSearchParams(await readText(req));
        const of = form.get("id") ?? "", why = (form.get("note") ?? "").trim();
        const events = await serialize(async () => {
          const st = reduce(await store.read()).instructions.get(of);
          const out = [await append(store, { kind: "ack", actor: human, of }, { human })];
          if (why) {
            const task = /\bt-\d+\b/.exec(st?.instruction.body ?? "")?.[0];
            const known = task && reduce(await store.read()).tasks.has(task) ? task : undefined;
            out.push(await append(store, { kind: "note", actor: human, body: `${DEFER_PREFIX}${why}`, refs: [of], task: known }, { human }));
          }
          return out;
        });
        emitAll(events);
        if (wantsHtml) return back();
        return json(res, 201, { events });
      }

      // The human says one sentence on the board.
      if (req.method === "POST" && path === "/say") {
        if (!isAdmin) return html(res, 401, unauthorizedPage());
        const text = (new URLSearchParams(await readText(req)).get("text") ?? "").trim();
        if (!text) return json(res, 400, { error: "empty", message: "说点什么再点「说」" });
        if (text.length > SAID_MAX_CHARS) return json(res, 400, { error: "too long", message: `一句话最多 ${SAID_MAX_CHARS} 字（现在 ${text.length}）；不够就再说一句` });
        const note = await serialize(() => append(store, { kind: "note", actor: human, body: `${SAID_PREFIX}${text}` }, { human }));
        emitAll([note]);
        if (wantsHtml) return back();
        return json(res, 201, note);
      }

      // One click on the board: ack the instruction and record the decision, as the human, in one request.
      if (req.method === "POST" && path === "/decide") {
        if (!isAdmin) return html(res, 401, unauthorizedPage());
        const form = new URLSearchParams(await readText(req));
        const of = form.get("id") ?? "", option = form.get("option") ?? "";
        const st = reduce(await store.read()).instructions.get(of);
        if (!st) return json(res, 404, { error: "not found", message: `${of} is not an instruction` });
        const i = st.instruction;
        if (!i.options?.includes(option)) return json(res, 409, { error: "rejected", rule: "decide", message: `"${option}" is not one of: ${(i.options ?? []).join(" | ")}` });
        if (st.chosen && st.chosen.by !== DEFAULT_DECIDER) return json(res, 409, { error: "rejected", rule: "decide", message: `${of} already decided: ${st.chosen.option} by ${st.chosen.by}` });
        const note = await serialize(async () => {
          const fresh = reduce(await store.read()).instructions.get(of)!;
          if (!fresh.acked_at) emitAll([await append(store, { kind: "ack", actor: human, of }, { human })]);
          return append(store, { kind: "note", actor: human, body: `decision: ${i.body} -> ${option}`, decision: true, decides: { of, option }, refs: [of] }, { human });
        });
        emitAll([note]);
        if (wantsHtml) return back();
        return json(res, 201, note);
      }

      // The API: a key of this project, and an identity. A node key is bound to its role; an admin key may speak as anyone.
      if (!record) return json(res, 401, { error: "unauthorized" });
      const actor = String(req.headers["x-actor"] ?? "").trim();
      if (!actor) return json(res, 400, { error: "X-Actor header is required" });
      if (record.role !== null && actor !== record.role) return json(res, 403, { error: "forbidden", message: `这把钥匙是 ${record.role} 的，不能以 ${actor} 说话` });

      if (req.method === "GET" && path === "/board") {
        await remind();
        const b = board(reduce(await store.read()), human);
        if (isAdmin) b.invite_url = `${origin}/invite/${(await registry.currentInvite(projectId)).code}`;
        return json(res, 200, b);
      }

      if (req.method === "GET" && path === "/log") return json(res, 200, { events: await store.since(url.searchParams.get("after")) });

      if (req.method === "GET" && path === "/events") {
        const after = url.searchParams.get("after");
        const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, maxWait);
        let result = await pull(store, actor, after);
        if (!result.events.length && wait > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, wait);
            function onAppend(x: { project: string }) { if (x.project === projectId) done(); }
            function done() { clearTimeout(timer); bus.off("append", onAppend); resolve(); }
            bus.on("append", onAppend);
            req.on("close", done);
          });
          result = await pull(store, actor, after);
        }
        return json(res, 200, result);
      }

      if (req.method === "POST" && path === "/events") {
        const body = (await readJson(req)) as NewEvent;
        const ne = { ...body, actor } as NewEvent;
        const e = await serialize(() => append(store, ne, { human }));
        emitAll([e]);
        return json(res, 201, e);
      }

      return json(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof Rejected) return json(res, 409, { error: "rejected", rule: err.rule, message: err.message });
      if (err instanceof SyntaxError) return json(res, 400, { error: "bad json" });
      console.error(err);
      return json(res, 500, { error: "internal", message: (err as Error).message });
    }
  });
  server.on("close", () => { if (timer) clearInterval(timer); });
  return server;
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