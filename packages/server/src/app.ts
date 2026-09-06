import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { append, pull, reduce, board, manual, welcome, MemoryStore, Rejected, type EventStore, type NewEvent, DEFAULT_DECIDER, SAID_PREFIX, SAID_MAX_CHARS, DEFER_PREFIX } from "@ateam/core";
import { renderBoard, unauthorizedPage, tokenPage } from "./html.js";
import { MemoryRegistry, type Registry, type KeyRecord } from "./projects.js";

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

  const bus = new EventEmitter();
  bus.setMaxListeners(1000);
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  return createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url ?? "/", "http://x");
      const proto = String(req.headers["x-forwarded-proto"] ?? "").includes("https") ? "https" : "http";
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
      const origin = `${proto}://${host}`;
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
        const state = reduce(await store.read());
        return html(res, 200, renderBoard(board(state, human), state, { sha, canDecide: isAdmin, human, base }));
      }

      const back = () => { res.writeHead(303, { location: `${base}/` }); res.end(); };
      const emitAll = (events: unknown[]) => { for (const e of events) bus.emit("append", { project: projectId, e }); };

      // The board's buttons. Each is one form POST as the human; `act` does the writing so the token page can
      // run the same action right after the key is entered (docs/board.md: buttons are always clickable).
      const ACTIONS = new Set(["/ack", "/say", "/decide"]);
      const act = async (then: string, form: URLSearchParams): Promise<{ status: number; body: unknown }> => {
        if (then === "/ack") {
          // 「知道了」/「做好了」/「起好了」: ack. 「先不做」: the same, with a note saying why it is not happening now (t-036);
          // when the instruction names a task, the note hangs on that task too. Several ids ack together (t-043).
          const ids = form.getAll("id").filter(Boolean), of = ids[0] ?? "", why = (form.get("note") ?? "").trim();
          const events = await serialize(async () => {
            const st = reduce(await store.read()).instructions.get(of);
            const out = [await append(store, { kind: "ack", actor: human, of }, { human })];
            for (const more of ids.slice(1)) {
              const fresh = reduce(await store.read()).instructions.get(more);
              if (fresh && !fresh.acked_at) out.push(await append(store, { kind: "ack", actor: human, of: more }, { human }));
            }
            if (why) {
              const task = /\bt-\d+\b/.exec(st?.instruction.body ?? "")?.[0];
              const known = task && reduce(await store.read()).tasks.has(task) ? task : undefined;
              out.push(await append(store, { kind: "note", actor: human, body: `${DEFER_PREFIX}${why}`, refs: [of], task: known }, { human }));
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
          const note = await serialize(() => append(store, { kind: "note", actor: human, body: `${SAID_PREFIX}${text}` }, { human }));
          emitAll([note]);
          return { status: 201, body: note };
        }
        if (then === "/decide") {
          // One click: ack the instruction and record the decision, in one request.
          const of = form.get("id") ?? "", option = form.get("option") ?? "";
          const st = reduce(await store.read()).instructions.get(of);
          if (!st) return { status: 404, body: { error: "not found", message: `${of} is not an instruction` } };
          const i = st.instruction;
          if (!i.options?.includes(option)) return { status: 409, body: { error: "rejected", rule: "decide", message: `"${option}" is not one of: ${(i.options ?? []).join(" | ")}` } };
          if (st.chosen && st.chosen.by !== DEFAULT_DECIDER) return { status: 409, body: { error: "rejected", rule: "decide", message: `${of} already decided: ${st.chosen.option} by ${st.chosen.by}` } };
          // Inside the write lock, look again: a click that raced another one must not half-apply.
          const note = await serialize(async () => {
            const fresh = reduce(await store.read()).instructions.get(of)!;
            if (!fresh.acked_at) emitAll([await append(store, { kind: "ack", actor: human, of }, { human })]);
            return append(store, { kind: "note", actor: human, body: `decision: ${i.body} -> ${option}`, decision: true, decides: { of, option }, refs: [of] }, { human });
          });
          emitAll([note]);
          return { status: 201, body: note };
        }
        return { status: 404, body: { error: "not found" } };
      };

      if (req.method === "POST" && ACTIONS.has(path)) {
        if (!isAdmin) return html(res, 401, unauthorizedPage());
        const r = await act(path, new URLSearchParams(await readText(req)));
        if (r.status < 300 && wantsHtml) return back();
        return json(res, r.status, r.body);
      }

      // The token page: a form posts here with `then` (the action) and its fields; without the key it asks for
      // one; with this project's admin key it sets the cookie, performs the action, and returns to the board.
      if (path === "/token" && (req.method === "GET" || req.method === "POST")) {
        const form = new URLSearchParams(req.method === "POST" ? await readText(req) : url.search);
        const fields: Record<string, string> = {};
        for (const [k, v] of form) if (k !== "token") fields[k] = v;
        const given = form.get("token");
        if (given === null) return html(res, 200, tokenPage(fields, false, base));
        const r0 = await registry.lookup(given);
        if (!r0 || r0.project !== projectId || r0.role !== null) return html(res, 401, tokenPage(fields, true, base));
        const secure = proto === "https";
        const setCookie = `${cookieName}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
        const then = fields.then ?? "";
        const r = ACTIONS.has(then) ? await act(then, new URLSearchParams(fields)) : { status: 204, body: null };
        if (r.status >= 300) { res.writeHead(r.status, { "content-type": "application/json", "set-cookie": setCookie }); return res.end(JSON.stringify(r.body)); }
        res.writeHead(303, { location: `${base}/`, "set-cookie": setCookie });
        return res.end();
      }

      // The API: a key of this project, and an identity. A node key is bound to its role; an admin key may speak as anyone.
      if (!record) return json(res, 401, { error: "unauthorized" });
      const actor = String(req.headers["x-actor"] ?? "").trim();
      if (!actor) return json(res, 400, { error: "X-Actor header is required" });
      if (record.role !== null && actor !== record.role) return json(res, 403, { error: "forbidden", message: `这把钥匙是 ${record.role} 的，不能以 ${actor} 说话` });

      if (req.method === "GET" && path === "/board") return json(res, 200, board(reduce(await store.read()), human));

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
