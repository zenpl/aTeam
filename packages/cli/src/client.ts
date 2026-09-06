import type { Event, ClientEvent, Board, PullResult } from "@ateam/core";

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
  board(): Promise<Board> { return this.call("GET", "/board"); }
  log(after: string | null): Promise<{ events: Event[] }> { return this.call("GET", `/log${after ? `?after=${after}` : ""}`); }
}
