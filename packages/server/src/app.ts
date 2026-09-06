import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { append, pull, reduce, board, Rejected, type EventStore, type NewEvent } from "@ateam/core";
import { renderBoard } from "./html.js";

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
        return html(res, 200, renderBoard(board(state, human), state, { sha, canDecide: authed() }));
      }

      // One click on the board: ack the instruction and record the decision, as the human, in one request.
      if (req.method === "POST" && url.pathname === "/decide") {
        if (!authed()) return html(res, 401, unauthorizedPage());
        const form = new URLSearchParams(await readText(req));
        const of = form.get("id") ?? "", option = form.get("option") ?? "";
        const st = reduce(await store.read()).instructions.get(of);
        if (!st) return json(res, 404, { error: "not found", message: `${of} is not an instruction` });
        const i = st.instruction;
        if (!i.options?.includes(option)) return json(res, 409, { error: "rejected", rule: "decide", message: `"${option}" is not one of: ${(i.options ?? []).join(" | ")}` });
        if (st.chosen) return json(res, 409, { error: "rejected", rule: "decide", message: `${of} already decided: ${st.chosen.option} by ${st.chosen.by}` });
        // Inside the write lock, look again: a click that raced another one must not half-apply.
        const note = await serialize(async () => {
          const fresh = reduce(await store.read()).instructions.get(of)!;
          if (!fresh.acked_at) bus.emit("append", await append(store, { kind: "ack", actor: human, of }, { human }));
          return append(store, { kind: "note", actor: human, body: `decision: ${i.body} -> ${option}`, decision: true, decides: { of, option }, refs: [of] }, { human });
        });
        bus.emit("append", note);
        if (String(req.headers.accept ?? "").includes("text/html")) { res.writeHead(303, { location: "/" }); return res.end(); }
        return json(res, 201, note);
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

function unauthorizedPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>aTeam board</title></head><body style="font:15px system-ui;padding:2rem"><h1>aTeam board</h1><p>This page needs the project token. Open <code>/?token=&lt;ATEAM_TOKEN&gt;</code> once; it is then kept in a cookie.</p></body></html>`;
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
