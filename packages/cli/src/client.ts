import { BOARD_SHAPE, type Event, type ClientEvent, type Board, type BoardTask, type PullResult } from "@ateam/core";

/** t-080: the server speaks a newer shape than this CLI knows. One sentence, exit 2; never a field error. */
export class ShapeError extends Error {
  constructor(public readonly server: number, public readonly mine: number) {
    super(`服务端的看板结构比你的 CLI 新（服务 ${server} / 你 ${mine}），请 git pull && pnpm build`);
  }
}

/** t-080: a response that names a shape newer than BOARD_SHAPE is refused whole, before any field is read. */
export function checkShape(data: unknown): void {
  const shape = data && typeof data === "object" ? (data as { shape?: unknown }).shape : undefined;
  if (typeof shape === "number" && shape > BOARD_SHAPE) throw new ShapeError(shape, BOARD_SHAPE);
}

export interface Config { url: string; token?: string; me: string }

/** t-137: what the last answer said about this node, for whoever prints the reminders at the end of a command. */
export const seen: { pullIdle: string | null } = { pullIdle: null };

export class ClientError extends Error {
  constructor(public status: number, public body: { error: string; rule?: string; message?: string }) {
    super(body.message ?? body.error);
  }
}

export class Client {
  constructor(private cfg: Config) {}

  private headers(): Record<string, string> {
    // X-Ateam-Client says which board shape this CLI speaks (t-080): the server sends the slim board only to a client that knows it
    const h: Record<string, string> = { "x-actor": this.cfg.me, "content-type": "application/json", "x-ateam-client": String(BOARD_SHAPE) };
    if (this.cfg.token) h.authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.cfg.url.replace(/\/$/, "") + path, {
      method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body),
    });
    // t-137: every answer says how long the server has gone without seeing this node pull. Kept, not acted on: the
    // command that carried it decides whether to say anything, and only it knows whether the watch is alive.
    seen.pullIdle = res.headers.get("x-ateam-pull-idle");
    const data = (await res.json().catch(() => ({ error: res.statusText }))) as never;
    if (!res.ok) throw new ClientError(res.status, data);
    checkShape(data);
    return data as T;
  }

  emit(e: ClientEvent): Promise<Event> { return this.call("POST", "/events", e); }
  pull(after: string | null, waitMs = 0): Promise<PullResult> {
    const q = new URLSearchParams();
    if (after) q.set("after", after);
    if (waitMs) q.set("wait", String(waitMs));
    return this.call("GET", `/events?${q}`);
  }
  /** The board; slim by default (t-070), `full` for criteria, evidence, notes and every instruction. */
  board(full = false): Promise<Board> { return this.call("GET", full ? "/board?full=1" : "/board"); }
  /** One task in full, with the seams touching it (t-068). */
  task(id: string): Promise<{ task: BoardTask; seams: Board["seams"]; refs: string[] }> { return this.call("GET", `/task/${encodeURIComponent(id)}`); }
  /** The manual for a role, as Markdown; null when the server has none for it. */
  async manual(role: string): Promise<string | null> {
    const res = await fetch(this.cfg.url.replace(/\/$/, "") + `/manual/${encodeURIComponent(role)}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new ClientError(res.status, { error: res.statusText });
    return res.text();
  }
  log(after: string | null): Promise<{ events: Event[] }> { return this.call("GET", `/log${after ? `?after=${after}` : ""}`); }
}
