import type { Event, ClientEvent, Board, BoardTask, PullResult } from "@ateam/core";

export interface Config { url: string; token?: string; me: string }

export class ClientError extends Error {
  constructor(public status: number, public body: { error: string; rule?: string; message?: string }) {
    super(body.message ?? body.error);
  }
}

export class Client {
  constructor(private cfg: Config) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "x-actor": this.cfg.me, "content-type": "application/json" };
    if (this.cfg.token) h.authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.cfg.url.replace(/\/$/, "") + path, {
      method, headers: this.headers(), body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({ error: res.statusText }))) as never;
    if (!res.ok) throw new ClientError(res.status, data);
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
