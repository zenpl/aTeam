/**
 * t-273：把整个进程的「现在」向前推 SHIFT_DAYS 天。**只改 Date 的读，不改它的算术**——
 * `new Date(x)`、`Date.parse(x)`、两个时刻相减，行为与平移前逐字相同；变的只有「不带参数的 now」。
 *
 * 这是 bin/timeshift 用 --import 预载进被测进程的那一份。它会被 NODE_OPTIONS 带进每一个子进程
 * （vitest 的 worker 也在内），所以**必须便宜、必须在 SHIFT_DAYS 没设时完全不作为**。
 *
 * 为什么不是一道常设闸，以及它抓不住哪六件事：见 t-272 的证据与 pm 01:35 的裁定。
 */
const days = Number(process.env.SHIFT_DAYS ?? "0");
const SHIFT = Number.isFinite(days) ? days * 86400_000 : 0;

if (SHIFT !== 0) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + SHIFT); else super(...a); }
    static now() { return RealDate.now() + SHIFT; }
  };
}
