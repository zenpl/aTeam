import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { append, pull, reduce, board, Rejected, type EventStore, type NewEvent, DEFAULT_DECIDER, SAID_PREFIX, SAID_MAX_CHARS } from "@ateam/core";
import { renderBoard, unauthorizedPage, tokenPage } from "./html.js";
import { UI } from "./i18n.js";

const COOKIE = "ateam_token";

export interface ServerOptions {
  store: EventStore;
  token?: string;
  human: string;
  maxWaitMs?: number;
  /** Git commit the running image was built from; "unknown" when the build did not say. */
  sha?: string;
  /** GET / without the token. Default true (decision 06:23). Writing (POST /decide) always needs the token. */
  boardPublic?: boolean;
}

/** One project, one log, one shared token. Identity is the X-Actor header. */
export function createApp(opts: ServerOptions) {
  const { store, token, human } = opts;
  const sha = opts.sha?.trim() || "unknown";
  const boardPublic = opts.boardPublic ?? true;
  const maxWait = opts.maxWaitMs ?? 30_000;
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
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/health") return json(res, 200, { ok: true, sha });

      // The human's page. Same data as /board, no identity needed. Reading is public unless boardPublic is off;
      // the decision buttons POST as the human and always need the token. Browsers cannot send the Bearer header,
      // so the token may arrive once as ?token= and is then kept in a cookie.
      const authed = () => !token || req.headers.authorization === `Bearer ${token}` || cookie(req, COOKIE) === token;
      if (req.method === "GET" && url.pathname === "/") {
        const given = url.searchParams.get("token");
        if (token && given !== null) {
          if (given !== token) return html(res, 401, unauthorizedPage());
          const secure = String(req.headers["x-forwarded-proto"] ?? "").includes("https");
          res.writeHead(303, { location: "/", "set-cookie": `${COOKIE}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` });
          return res.end();
        }
        if (!boardPublic && !authed()) return html(res, 401, unauthorizedPage());
        const state = reduce(await store.read());
        return html(res, 200, renderBoard(board(state, human), state, { sha, canDecide: authed(), human }));
      }

      // The board's buttons. Each is one form POST as the human; `act` does the writing so the token page can
      // run the same action right after the token is entered (docs/board.md: buttons are always clickable).
      const ACTIONS = new Set(["/ack", "/defer", "/say", "/decide"]);
      const act = async (then: string, form: URLSearchParams): Promise<{ status: number; body: unknown }> => {
        if (then === "/ack") {
          // 「知道了」/「做好了」: ack.
          const of = form.get("id") ?? "";
          const e = await serialize(() => append(store, { kind: "ack", actor: human, of }, { human }));
          bus.emit("append", e);
          return { status: 201, body: e };
        }
        if (then === "/defer") {
          // 「先不做」: ack, plus a note saying so, so the team knows it was seen and put off.
          const of = form.get("id") ?? "";
          const st = reduce(await store.read()).instructions.get(of);
          if (!st) return { status: 404, body: { error: "not found", message: `${of} is not an instruction` } };
          const note = await serialize(async () => {
            const fresh = reduce(await store.read()).instructions.get(of)!;
            if (!fresh.acked_at) bus.emit("append", await append(store, { kind: "ack", actor: human, of }, { human }));
            return append(store, { kind: "note", actor: human, body: UI.deferredNote(st.instruction.body), refs: [of] }, { human });
          });
          bus.emit("append", note);
          return { status: 201, body: note };
        }
        if (then === "/say") {
          // The human says one sentence: a note in their name, prefixed so the board can follow it (t-030).
          const text = (form.get("text") ?? "").trim();
          if (!text) return { status: 400, body: { error: "empty", message: "说点什么再点「说」" } };
          if (text.length > SAID_MAX_CHARS) return { status: 400, body: { error: "too long", message: `一句话最多 ${SAID_MAX_CHARS} 字（现在 ${text.length}）；不够就再说一句` } };
          const note = await serialize(() => append(store, { kind: "note", actor: human, body: `${SAID_PREFIX}${text}` }, { human }));
          bus.emit("append", note);
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
            if (!fresh.acked_at) bus.emit("append", await append(store, { kind: "ack", actor: human, of }, { human }));
            return append(store, { kind: "note", actor: human, body: `decision: ${i.body} -> ${option}`, decision: true, decides: { of, option }, refs: [of] }, { human });
          });
          bus.emit("append", note);
          return { status: 201, body: note };
        }
        return { status: 404, body: { error: "not found" } };
      };
      const wantsHtml = () => String(req.headers.accept ?? "").includes("text/html");

      if (req.method === "POST" && ACTIONS.has(url.pathname)) {
        if (!authed()) return html(res, 401, unauthorizedPage());
        const r = await act(url.pathname, new URLSearchParams(await readText(req)));
        if (r.status < 300 && wantsHtml()) { res.writeHead(303, { location: "/" }); return res.end(); }
        return json(res, r.status, r.body);
      }

      // The token page: a form posts here with `then` (the action) and its fields; without the token it asks for
      // one; with the right token it sets the cookie and performs the action, then returns to the board.
      if (url.pathname === "/token" && (req.method === "GET" || req.method === "POST")) {
        const form = new URLSearchParams(req.method === "POST" ? await readText(req) : url.search);
        const fields: Record<string, string> = {};
        for (const [k, v] of form) if (k !== "token") fields[k] = v;
        const given = form.get("token");
        if (given === null) return html(res, 200, tokenPage(fields));
        if (token && given !== token) return html(res, 401, tokenPage(fields, true));
        const secure = String(req.headers["x-forwarded-proto"] ?? "").includes("https");
        const setCookie = `${COOKIE}=${encodeURIComponent(given)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`;
        const then = fields.then ?? "";
        const r = ACTIONS.has(then) ? await act(then, new URLSearchParams(fields)) : { status: 204, body: null };
        if (r.status >= 300) { res.writeHead(r.status, { "content-type": "application/json", "set-cookie": setCookie }); return res.end(JSON.stringify(r.body)); }
        res.writeHead(303, { location: "/", "set-cookie": setCookie });
        return res.end();
      }

      if (token && req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
      const actor = String(req.headers["x-actor"] ?? "").trim();
      if (!actor) return json(res, 400, { error: "X-Actor header is required" });

      if (req.method === "GET" && url.pathname === "/board") {
        const b = board(reduce(await store.read()), human);
        return json(res, 200, b);
      }

      if (req.method === "GET" && url.pathname === "/log") {
        const after = url.searchParams.get("after");
        return json(res, 200, { events: await store.since(after) });
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const after = url.searchParams.get("after");
        const wait = Math.min(Number(url.searchParams.get("wait") ?? 0) || 0, maxWait);
        let result = await pull(store, actor, after);
        if (!result.events.length && wait > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, wait);
            function done() { clearTimeout(timer); bus.off("append", done); resolve(); }
            bus.on("append", done);
            req.on("close", done);
          });
          result = await pull(store, actor, after);
        }
        return json(res, 200, result);
      }

      if (req.method === "POST" && url.pathname === "/events") {
        const body = (await readJson(req)) as NewEvent;
        const ne = { ...body, actor } as NewEvent;
        const e = await serialize(() => append(store, ne, { human }));
        bus.emit("append", e);
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
