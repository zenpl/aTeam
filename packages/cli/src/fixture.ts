/**
 * t-062: `ateam fixture` prints a sample log built with the same code the server runs. No server, no config needed.
 */
import { sampleLog } from "@ateam/core";

export interface FixtureOptions { start?: string; stepMs?: number }

/** The sample log as JSON text, one object with events, cursors and deliveries. */
export async function fixtureText(opts: FixtureOptions = {}): Promise<string> {
  const start = opts.start !== undefined ? Date.parse(opts.start) : undefined;
  if (opts.start !== undefined && Number.isNaN(start)) throw new Error(`--start 要一个 ISO 时间，不是 ${JSON.stringify(opts.start)}`);
  const log = await sampleLog({ start, stepMs: opts.stepMs });
  return JSON.stringify(log, null, 2);
}
