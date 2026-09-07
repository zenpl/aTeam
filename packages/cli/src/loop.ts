import { owedSentences, type PullResult } from "@ateam/core";
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
  /** Called once per loop turn: the lock file's heartbeat (t-049). */
  heartbeat?: () => void;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000];
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Network trouble and 5xx are the server's moment, not ours; 4xx, rejections and config errors are ours. */
export function isTransient(err: unknown): boolean {
  if (err instanceof ClientError) return err.status >= 500;
  return err instanceof Error && !(err instanceof SyntaxError);
}

/**
 * The cursor only moves forward (t-049). Two processes sharing the file interleave read-pull-write; a stale
 * value must never overwrite a newer one, or old instructions replay. ULIDs sort by time, so a plain compare works.
 */
export function advance(cursor: CursorStore, next: string | null): boolean {
  const current = cursor.read();
  if (next !== null && current !== null && next <= current) return false;
  if (next === null && current !== null) return false;
  cursor.write(next);
  return true;
}

/** Render one pull the way `ateam sync` shows it. */
export function report(r: PullResult, me: string, after: string | null): string[] {
  const lines: string[] = [];
  if (!r.events.length) lines.push(after ? "nothing new" : "log is empty");
  const batch = new Set(r.events.map((e) => e.id));
  for (const e of r.events) {
    lines.push(fmt.event(e, me));
    // t-064: an instruction to me taken back after I had already pulled it: say so, or I might still act on it
    if (e.kind === "untell" && !batch.has(e.of) && r.taken_back_seen?.includes(e.of)) lines.push(`  ⇐ 你已看过的这条被撤回了（${e.of}），不要照着做`);
  }
  // t-140 (pd 07:34): there is no tail here at all any more. t-147 had replaced the old 「ateam ack」 line with one
  // that named the two things still owed; pd deleted that too, integrally, because it said the same thing as the
  // 「你欠什么」 line at sync while counting something else — this batch, not the standing debt — and two same-meaning
  // numbers from two sources are the shape 07:07 forbids: if they were really the same thing they would be one.
  // What just arrived is already marked instruction by instruction (⇐ FOR YOU); what is owed is said once, at sync.
  return lines;
}

/**
 * One protocol step: pull since the cursor, advance the cursor exactly once, print what came in.
 * `print` null keeps it quiet (the cursor still moves; that is the heartbeat).
 */
export async function sync(client: Puller, me: string, cursor: CursorStore, waitMs: number, print: Print | null): Promise<PullResult> {
  const after = cursor.read();
  const r = await client.pull(after, waitMs);
  advance(cursor, r.cursor);
  if (print) for (const line of report(r, me, after)) print(line);
  // t-140 (pd 06:23): what I still owe, to me and only here. Not in watch's every round, not on the board — it is
  // this node's own business, not the team's and certainly not the human's. The sentences are core's, computed from
  // the server's `owed` (core's `owedNow`): what is owed does not empty out when the cursor moves, which is the
  // whole of qa 06:32's failure against the first version of this line.
  if (print) for (const line of owedSentences(r.owed, new Date())) print(line);
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
    opts.heartbeat?.();
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
