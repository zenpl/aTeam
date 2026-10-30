/**
 * t-062: `ateam fixture` prints a sample log built with the same code the server runs. No server, no config needed.
 */
import { sampleLog } from "@ateam/core";

export interface FixtureOptions { start?: string; stepMs?: number }

/** The sample log as JSON text, one object with events, cursors and deliveries. */
export async function fixtureText(opts: FixtureOptions = {}): Promise<string> {
  const start = opts.start !== undefined ? Date.parse(opts.start) : undefined;
  if (opts.start !== undefined && Number.isNaN(start)) throw new Error(`--start 要一个 ISO 时间，不是 ${JSON.stringify(opts.start)}`);
  // t-278：**只把真的给了的那几项传下去。** `sampleBuilder` 的默认步长（60s）是用 `{ stepMs: 60_000, ...opts }`
  // 给的，而展开一个显式的 `undefined` 会把默认值盖掉——于是 `ateam fixture` 不带 `--step` 时步长悄悄变回 1s，
  // 整份样本只跨 20 秒。样本因此不像真的：任何以「过了多久」为条件的东西（比如服务那张卡）在它里面都不会发生。
  // 这不是本件新造的洞，是本件把它照出来的：判据 3 说「fixture 的输出会变」，不修这一句，人真正跑的那条命令不会变。
  const log = await sampleLog({ ...(start !== undefined && { start }), ...(opts.stepMs !== undefined && { stepMs: opts.stepMs }) });
  return JSON.stringify(log, null, 2);
}
