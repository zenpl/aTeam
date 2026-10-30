/**
 * t-262 判据 1、2、3：**「谁在」那一格要两个时刻，不是一个。**
 *
 * 起因（pm 13:42 → dev 03:15 实测）：牌桌上的 `listening` 只看一件事——`LISTEN_WINDOW_MS = 5 分钟`
 * 之内拉过一次（`board.ts` 的 `presenceStatus`）。而**每一次拉取都无条件推游标**
 * （`packages/core/src/pull.ts:95`：`await store.setCursor({ actor: me, last_event_id: cursor, at: nowIso })`，
 * 在这一批空不空之外），`ateam watch` 每 60 秒走的正是那条路。
 *
 * 于是「拉取很近」证明的是**那个循环还在跑**——容器活着、网络通、钥匙有效——**它不证明任何人读了任何东西**。
 *
 * 下面这一组不是「印得出两个数」那么松。它先造两个**用合成那一个数分不开**的世界（`last_seen` 逐字相同），
 * 再要求这两个时刻把它们分开。合成的那个数要是够用，第一条断言就会红。
 *
 * **这里一个结论都不给**（判据 2）：一小时不出声可能是在干重活，服务端没有任何依据分辨这两者，一分辨就是在猜。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.parse("2026-09-15T04:00:00.000Z");
const NOW = new Date(T0);
const at = (mins: number) => new Date(T0 + mins * 60_000);

/** 两个节点都在五分钟内拉过（都算 listening）；写事件的时刻由调用方给。 */
async function world(devWroteMinsAgo: number | null, qaWroteMinsAgo: number | null) {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  if (devWroteMinsAgo !== null) await put({ kind: "note", actor: "dev", body: "干活" }, -devWroteMinsAgo);
  if (qaWroteMinsAgo !== null) await put({ kind: "note", actor: "qa", body: "干活" }, -qaWroteMinsAgo);
  // 两边在同一时刻拉过：合成的那个数因此逐字相同
  const pulled = at(-0.5).toISOString();
  for (const who of ["dev", "qa"]) await s.setCursor({ actor: who, last_event_id: "01ZZZ", at: pulled });
  const b = board(reduce(await s.read(), NOW), HUMAN, NOW);
  const row = (who: string) => b.presence.find((p) => p.actor === who)!;
  return { b, row };
}

describe("t-262 · 拉取的时刻与写入的时刻，分开给", () => {
  it("正：两个节点用合成那一个数分不开（`last_seen`、`idle_s`、`status` 逐字相同），而两个时刻分得开", async () => {
    // dev 半分钟前刚写过；qa 六十分钟没写过。两边都刚拉过。
    const { row } = await world(0.5, 60);
    const dev = row("dev"), qa = row("qa");

    // ① 合成的那个数分不开——**这三条要是分得开，这一格本来就不缺什么，下面就都不必了**
    expect(qa.status, "两边都在窗口内拉过").toBe("listening");
    expect(dev.status).toBe("listening");
    expect(qa.last_seen, "`last_seen` 取两者之晚，而两边最晚的都是那一次拉取").toBe(dev.last_seen);
    expect(qa.idle_s).toBe(dev.idle_s);

    // ② 两个时刻分得开
    expect(dev.last_pull).toBeTruthy();
    expect(dev.last_event).toBeTruthy();
    expect(qa.last_pull).toBeTruthy();
    expect(qa.last_event).toBeTruthy();
    expect(qa.last_pull).toBe(dev.last_pull);                 // 拉取一样
    expect(qa.last_event).not.toBe(dev.last_event);           // 写入不一样
    expect(Math.round(dev.idle_event_s!)).toBe(30);           // 半分钟
    expect(Math.round(qa.idle_event_s!)).toBe(3600);          // 一小时
    expect(Math.round(qa.idle_pull_s!)).toBe(30);
    expect(qa.idle_event_s! - qa.idle_pull_s!, "差出来的正是「循环在跑而没有产出」那一段").toBe(3570);
  });

  it("反：刚写过事件的那个，这一格一个字都不多说——没有新字段，没有结论", async () => {
    const { row } = await world(0.5, 0.5);
    const dev = row("dev");

    // 键集逐字钉住：以后谁往这一行加一个 `stuck`、`idle_reason`、`looks_*`，这条当场红
    expect(Object.keys(dev).sort()).toEqual([
      "actor", "cli_sha", "idle_event_s", "idle_pull_s", "idle_s",
      "last_event", "last_pull", "last_seen", "listening", "present", "push", "role", "since", "status",
    ]);
    // 判据 2：服务端不下判断。整行里不许出现任何给人读的话（中文），它只有时刻、秒数与既有的状态词
    expect(JSON.stringify(dev)).not.toMatch(/[一-鿿]/);
  });

  it("从没写过事件的节点：写入那一格是 null，不是 0——「没有过」与「刚刚」不是一回事", async () => {
    const { row } = await world(null, 0.5);
    const dev = row("dev");
    expect(dev.status, "它拉过，所以照旧算 listening").toBe("listening");
    expect(dev.last_pull).toBeTruthy();
    expect(dev.last_event).toBeNull();
    expect(dev.idle_event_s).toBeNull();
  });
});
