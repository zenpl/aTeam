import type { PullResult } from "@ateam/core";
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
 * Loop until an instruction for `me` arrives. Every pull that brought events is printed as sync would
 * print it (empty pulls stay silent), so nothing is consumed unseen; the wake-up pull is printed before
 * "instruction received". Nothing is pulled twice, so a following `sync` says "nothing new".
 */
export async function watch(client: Puller, me: string, cursor: CursorStore, intervalMs: number, print: Print): Promise<PullResult> {
  for (;;) {
    const after = cursor.read();
    const r = await sync(client, me, cursor, Math.min(intervalMs, 30_000), null);
    if (r.events.length) for (const line of report(r, me, after)) print(line);
    if (r.for_me.length) {
      print("\ninstruction received");
      return r;
    }
  }
}
