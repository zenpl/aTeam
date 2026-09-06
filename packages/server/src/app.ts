import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import { append, pull, reduce, board, Rejected, type EventStore, type NewEvent } from "@ateam/core";

export interface ServerOptions {
  store: EventStore;
  token?: string;
  human: string;
  maxWaitMs?: number;
  /** Git commit the running image was built from; "unknown" when the build did not say. */
  sha?: string;
}

/** One project, one log, one shared token. Identity is the X-Actor header. */
export function createApp(opts: ServerOptions) {
  const { store, token, human } = opts;
  const sha = opts.sha?.trim() || "unknown";
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

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) reject(new SyntaxError("too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
