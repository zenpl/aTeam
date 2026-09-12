import { BOARD_SHAPE, badResponseLine, type Refused, type Event, type ClientEvent, type Board, type BoardTask, type PullResult } from "@ateam/core";

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

/**
 * t-225：**HTTP 说成功，正文却不是 JSON。**
 *
 * 端到端复现过一次：`res.json()` 抛，旧代码在 `.catch` 里造一个 `{ error }` 顶上去；`res.ok` 是真，于是这个
 * 假东西被当成 `PullResult` 返回——`cursor` 是 `undefined`（清掉游标）、`events` 是 `undefined`（下一行抛）。
 * **一次坏响应同时清游标并杀进程。**
 *
 * 所以这里不再造替身：答不出内容就是一次失败。`status` 留着（它常常是 200，正是这件事最怪的地方），
 * `snippet` 留原文开头几十字——网关的错误页、代理的登录页、被截断的 JSON，看一眼就知道是哪一种。
 */
export class BadResponse extends Error {
  constructor(public readonly status: number, public readonly snippet: string) {
    super(badResponseLine(status, snippet));
  }
}

/** 正文开头这么多字进错误消息：够认出网关页或截断，短到能印成一行。 */
export const SNIPPET_CHARS = 80;

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
    // t-225：先拿原文，再自己解析——**拿不到 JSON 时要分得清两件事**：4xx/5xx 带一张错误页（那是服务在说话，
    // 照旧走 ClientError），与 2xx 带一张不是 JSON 的正文（那是这条响应本身坏了，谁也没在说话）。
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text) as unknown; }
    catch {
      if (res.ok) throw new BadResponse(res.status, text.slice(0, SNIPPET_CHARS).replace(/\s+/g, " ").trim());
      throw new ClientError(res.status, { error: res.statusText });
    }
    if (!res.ok) throw new ClientError(res.status, data as { error: string });
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
  /**
   * t-218：**把这台机器上那几条「没发出去就被拒了」的写入捎给服务。** 服务只记得下它认得的那几样
   * （规则名、谁、哪种写入、什么时候），正文本来就没有。返回它真记下了哪几条 id——**捎成了才划掉**。
   */
  reportRefusals(refusals: readonly Refused[]): Promise<{ recorded: string[] }> {
    return this.call("POST", "/refusals", { refusals });
  }
}
