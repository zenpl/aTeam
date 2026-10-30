/**
 * t-262（pm 04:17 定的新范围）：**`ateam board` 的「谁在」那一行给两个时刻，不合成、不下结论。**
 *
 * 改前那一行是 `在读  <last_seen> 前`。两处都不对：`last_seen` 是拉取与写入取晚的那个（合成过），
 * 而「在读」是个结论——每一次拉取都无条件推游标（`packages/core/src/pull.ts:95`），`ateam watch` 每 60 秒
 * 走一遍，所以拉取很近只证明那个循环还在跑，不证明任何人读了任何东西。
 *
 * 这一组的正面不是「印得出两个数」：它先造两个**用改前那一行分不开**的节点，再要求新的一行把它们分开。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, PRESENCE_NEVER_WROTE, type NewEvent } from "@ateam/core";
import * as fmt from "../src/format.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-15T04:00:00.000Z");
const NOW = new Date(T0);
const at = (mins: number) => new Date(T0 + mins * 60_000);

async function lines(devWroteMinsAgo: number | null, qaWroteMinsAgo: number | null) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  if (devWroteMinsAgo !== null) await put({ kind: "note", actor: "dev", body: "干活" }, -devWroteMinsAgo);
  if (qaWroteMinsAgo !== null) await put({ kind: "note", actor: "qa", body: "干活" }, -qaWroteMinsAgo);
  const pulled = at(-0.5).toISOString();                       // 两边在同一时刻拉过
  for (const who of ["dev", "qa"]) await s.setCursor({ actor: who, last_event_id: "01ZZZ", at: pulled });
  const b = board(reduce(await s.read(), NOW), HUMAN, NOW);
  const text = fmt.board(b, "pm");
  const block = text.slice(text.indexOf("PRESENCE")).split("\n").slice(1);
  const of = (who: string) => block.find((l) => l.trim().startsWith(who))!;
  return { b, text, of };
}

describe("t-262 · PRESENCE 那一行：两个时刻，不合成、不下结论", () => {
  it("正：改前那一行分不开的两个节点，新的一行分得开", async () => {
    const { b, of } = await lines(0.5, 60);          // dev 半分钟前写过，qa 六十分钟没写过
    const dev = of("dev"), qa = of("qa");

    // ① 先证它们改前分不开：那一行读的是 last_seen，而两边的 last_seen 逐字相同
    const row = (w: string) => b.presence.find((p) => p.actor === w)!;
    expect(row("qa").last_seen, "改前那一行的唯一来源，两边一模一样").toBe(row("dev").last_seen);

    // ② 新的一行分得开，而且分得开的正是「写入」那一半
    expect(dev).not.toBe(qa);
    expect(dev.replace(/^\s*dev\s*/, "")).not.toBe(qa.replace(/^\s*qa\s*/, ""));
    for (const l of [dev, qa]) {
      expect(l).toContain("拉取");
      expect(l).toContain("写入");
    }
    expect(qa, "compact() 出的是 1h，不是「1 小时」——这里钉的是真出口，不是我以为的那句").toMatch(/写入 1h 前/);
  });

  it("反：一个字都不多说——没有结论词，没有那个合成的数", async () => {
    const { of, text } = await lines(0.5, 0.5);
    const dev = of("dev");
    for (const verdict of ["在读", "卡", "可能", "似乎", "没在", "停"]) expect(dev).not.toContain(verdict);
    expect(text).not.toContain("在读");                        // 改前那句话在整块里一次都不再出现
    expect(dev.match(/前/g) ?? [], "两个时刻各说各的，不是一个").toHaveLength(2);
  });

  it("从没写过事件的节点：说「从没写过」，不说「刚刚」", async () => {
    const { of } = await lines(null, 0.5);
    const dev = of("dev");
    expect(dev).toContain("拉取");
    expect(dev).toContain(PRESENCE_NEVER_WROTE);
    expect(dev).not.toContain("刚刚");
  });
});
