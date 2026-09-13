import { PART_NAMES } from "@ateam/core";

/**
 * t-241：**吸收那几件叫什么名字。**
 *
 * 原来在 main.ts 里写成 `e.a` / `e.b`，而 `seamCheck` 造的事件带的是 `tasks: [a, b]`——于是它们在终端上
 * 与本地那本账上都叫「解决接缝 +」。**一个永远说不出是哪一件的名字，与没有名字一样**；
 * 这是本件上线后记下的第一条记录自己照出来的。
 *
 * 说不出时给 `?`，不给空：**「说不出」与「是空的」要分得开**（t-077 那一条）。
 */
export function seamAbsorbName(e: unknown): string {
  const [a, b] = ((e as { tasks?: string[] })?.tasks ?? []);
  return PART_NAMES.seamAbsorb(a ?? "?", b ?? "?");
}
