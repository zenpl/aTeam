/**
 * t-286：**发之前那道长度预检。**
 *
 * 三条写死，各有来历：
 * ① **用闸自己那把尺**——`instructionOverBy` 与 `rules.ts` 引的是 `events.ts` 里同一个 `instructionBodyLength`。
 *    「两边量同一个量」从此是结构，不是一条会被下一次改动悄悄推翻的断言。
 * ② **只报告，不替人做决定**（判据 4）：不改那个 280、不截断、不拒绝发送。发卡的人可能有理由那么写，
 *    **但他不许在不知情的情况下那么写**（与 t-265 那条标题提醒同一条道理）。
 * ③ **预检自己出错时不许悄悄跳过**（判据 5）：返回一句「没量成」，命令照发、由服务端裁。
 *    一道关着的时候看起来和开着一样的闸，比没有这道闸更坏——今晚 t-284 买的就是这一条。
 *
 * 量法与说法都从外面传进来，**只为了让「出错那一格」有一条站得住的用例**：`noteRefusal` 那次
 * （t-285）的教训是「手跑证明今天对」不是护栏。行为与直接写在调用处时逐字相同。
 */
import { instructionOverBy, tooLongLine, precheckFailedLine } from "@ateam/core";

export function tellPrecheck(
  body: string,
  measure: (b: string) => number = instructionOverBy,
  say: (b: string) => string = tooLongLine,
): string[] {
  try {
    return measure(body) > 0 ? [say(body)] : [];
  } catch (e) {
    return [precheckFailedLine(e instanceof Error ? e.message : String(e))];
  }
}
