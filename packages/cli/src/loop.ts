import type { PullResult } from "@ateam/core";
import { ClientError } from "./client.js";
import * as fmt from "./format.js";

/** Where the CLI keeps its read position. The file under .ateam/ in production; memory in tests. */
export interface CursorStore {
  read(): string | null;
  write(cursor: string | null): void;
}

/** The one call `sync` and `watch` need from the server. */
export interface Puller {
  pull(after: string | null, waitMs?: number): Promise<PullResult>;
}

export type Print = (line: string) => void;

export interface WatchOptions {
  /** Delays between retries after a transient failure, in ms. Each is capped at the interval. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Stop after the first pull that brings an instruction (the pre-t-046 behaviour, for old Monitor setups). */
  once?: boolean;
  /** Ends the watch from outside (tests, shutdown). */
  signal?: AbortSignal;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000];
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Network trouble and 5xx are the server's moment, not ours; 4xx, rejections and config errors are ours. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ClientError) return err.status >= 500;
  return err instanceof Error && !(err instanceof SyntaxError);
}

/** Render one pull the way `ateam sync` shows it. */
export function report(r: PullResult, me: string, after: string | null): string[] {
  const lines: string[] = [];
  if (!r.events.length) lines.push(after ? "nothing new" : "log is empty");
  for (const e of r.events) lines.push(fmt.event(e, me));
  if (r.for_me.length) lines.push(`\n${r.for_me.length} instruction(s) for you. Ack each with: ateam ack <id>`);
  return lines;
}

/**
 * One protocol step: pull since the cursor, advance the cursor exactly once, print what came in.
 * `print` null keeps it quiet (the cursor still moves; that is the heartbeat).
 */
export async function sync(client: Puller, me: string, cursor: CursorStore, waitMs: number, print: Print | null): Promise<PullResult> {
  const after = cursor.read();
  const r = await client.pull(after, waitMs);
  cursor.write(r.cursor);
  if (print) for (const line of report(r, me, after)) print(line);
  return r;
}

/**
 * Keep listening. Every pull that brought events is printed as sync would print it (empty pulls stay silent),
 * so nothing is consumed unseen; a pull that brings an instruction for `me` is followed by "instruction received"
 * and the loop goes on (t-046): a node that stops listening after one instruction is deaf until someone notices.
 * `once` returns after that first instruction instead. Nothing is pulled twice, so a following `sync` says "nothing new".
 */
export async function watch(client: Puller, me: string, cursor: CursorStore, intervalMs: number, print: Print, opts: WatchOptions = {}): Promise<PullResult> {
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? realSleep;
  let failures = 0;
  let last: PullResult = { events: [], for_me: [], cursor: cursor.read() };
  for (;;) {
    if (opts.signal?.aborted) return last;
    const after = cursor.read();
    let r: PullResult;
    try {
      r = await sync(client, me, cursor, Math.min(intervalMs, 30_000), null);
    } catch (err) {
      // A transient failure (deploy in progress, network blip) must not end the watch: the cursor is untouched,
      // say what happened, back off, try again. Anything else is ours to fix, so it still exits.
      if (!isTransient(err)) throw err;
      const wait = Math.min(backoff[Math.min(failures, backoff.length - 1)], intervalMs);
      failures += 1;
      print(`watch: ${describeError(err)}; retrying in ${wait / 1000}s (attempt ${failures})`);
      await sleep(wait);
      continue;
    }
    failures = 0;
    last = r;
    if (r.events.length) for (const line of report(r, me, after)) print(line);
    if (r.for_me.length) {
      print("\ninstruction received");
      if (opts.once) return r;
    }
  }
}

function describeError(err: unknown): string {
  if (err instanceof ClientError) return `server ${err.status}: ${err.message}`;
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ? `${e.message} (${e.cause.code})` : e.message;
}
