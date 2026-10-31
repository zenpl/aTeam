/**
 * t-340（P0；pd 的要求㉘㉙㉚，decision `01M69N0XVK591XAJBME7ACGDFT`，措辞定稿在它的路标 cb655f2）：
 * **渲染一崩就无声丢一批，而节点仍显示「在听」。**
 *
 * 实测代价（pd 18:51 亲历，我按归属引）：它的看守与手跑 `sync` 两次都只打出
 * `Cannot read properties of undefined (reading 'join')` 就退，而游标被推进到 `01M69M4F9YCZRXYGX8W8H18B2R`
 * ——它一个字没读到，而看守随后重启成功，因为毒已经被跳过去了。于是节点看起来健康、牌桌上它是「在听」。
 *
 * 这一份钉三件：
 * ① 要求㉘：**整条渲染链**崩掉时游标一步都不动，再跑一次仍然拿得到同一批（判据② 的判法）；
 * ② 要求㉙㉚：**其中一条**渲染不出来时，说出它是第几条、id、kind、actor、时刻，而且**不丢**——
 *    那一行就是它的交付，批次照常往下走；
 * ③ 对照：什么都没崩的那一次，游标照旧推进（这道屏障没有把正常那条路一起关掉）。
 */
import { describe, it, expect, vi } from "vitest";
import { sync, report, renderOne } from "../src/loop.js";
import { unrenderableLine, batchBrokeLine } from "@ateam/core";
import type { PullResult } from "@ateam/core";
import type { Event } from "@ateam/core";

const ME = "dev";
const ev = (id: string, over: Record<string, unknown> = {}): Event => ({
  id, at: "2026-10-31T18:39:00.000Z", actor: "pm", kind: "note", body: "一条正常的 note", ...over,
} as unknown as Event);

/** 一个只认一次拉取的假服务端；每次拉都给同一批（服务端那一侧不会因为客户端崩了就改口）。 */
const puller = (events: Event[], extra: Partial<PullResult> = {}) => {
  const calls: (string | null)[] = [];
  return {
    calls,
    pull: async (after: string | null) => {
      calls.push(after);
      return { events, cursor: events[events.length - 1]?.id, owed: undefined, ...extra } as unknown as PullResult;
    },
  };
};
/** 一个记得住自己被写成什么的游标。 */
const cursorStore = (v: string | null = null) => {
  let cur = v;
  return { read: () => cur, write: (x: string | null) => { cur = x; }, get value() { return cur; } };
};

describe("t-340 · 整条渲染链崩掉时，游标一步都不许动", () => {
  it("**判据②（要求㉘）**：尾巴那一段抛错 ⇒ 游标没前进，再跑一次拿到的是同一批", async () => {
    const events = [ev("01A"), ev("01B")];
    // `behind.apart` 只在服务端报了 sha 时才被问到，所以这一批要带上它——不带的话这一格会因为
    // 「压根没走到那一段」而变绿，又是一次为了错的理由通过。
    const p = puller(events, { sha: "abc1234" } as never);
    const seen = cursorStore(null);
    const cursor = cursorStore(null);
    // 崩在**游标推进之后**的那一段：pd 那一次就是这里（owedSentences / behind 那两块）。
    // 这里用 behind 那一块来造它——它与 owedSentences 在同一段尾巴上，同一个屏障管。
    const behind = { head: () => "deadbee", has: () => null, descends: () => null,
      apart: () => { throw new TypeError("Cannot read properties of undefined (reading 'join')"); } };
    const out: string[] = [];
    await expect(sync(p as never, ME, cursor as never, 0, (l) => out.push(l), behind as never, undefined, seen as never)).rejects.toThrow(/reading 'join'/);
    expect(out.some((l) => l.includes("01A")), "行是印出来过的——丢的不是显示，是游标").toBe(true);
    expect(seen.value, "**游标一步都不许动**：这一批下次还要来").toBeNull();
    expect(cursor.value).toBeNull();
    // t-343 判据 3、5：**整批那一句要在，而且后半句「没推进、下次整个再来」必须在里面**（pd 20:25 定稿）。
    // 两条都渲染出来了之后才断在尾巴上，所以它说的是「在第 2／2 条之后断了」。
    expect(out.at(-1), "照抄 pd 定稿那一句").toBe(batchBrokeLine({ nth: 2, total: 2, cursor: "null" }));
    expect(out.at(-1)).toContain("没有推进");
    expect(out.at(-1)).toContain("下次 sync 会把这一批整个再来一遍");
    expect(out.at(-1), "**这一句不许说成「算读过了」**：那是另一条路的话，处置正相反").not.toContain("算读过了");

    // 再跑一次：从同一个位置拉，拿到的是同一批（这一次不崩）
    const out2: string[] = [];
    await sync(p as never, ME, cursor as never, 0, (l) => out2.push(l), undefined, undefined, seen as never);
    expect(p.calls, "两次都从 null 拉，因为第一次没推进").toEqual([null, null]);
    expect(out2.some((l) => l.includes("01A"))).toBe(true);
    expect(seen.value, "这一次整条链走完了，才推进").toBe("01B");
  });

  it("**对照**：什么都没崩 ⇒ 游标照旧推进（屏障没有把正常那条路一起关掉）", async () => {
    const p = puller([ev("01A"), ev("01B")]);
    const seen = cursorStore(null);
    const cursor = cursorStore(null);
    await sync(p as never, ME, cursor as never, 0, () => {}, undefined, undefined, seen as never);
    expect(seen.value).toBe("01B");
    expect(cursor.value).toBe("01B");
  });
});

describe("t-340 · 其中一条渲染不出来：说出它是谁，并且不丢", () => {
  /** 一条渲染必崩的事件：`task claim` 少了 touches，格式化那一行正是 `e.touches.join(", ")`。 */
  const poison = ev("01BAD", { kind: "task", op: "claim", task: "t-1", touches: undefined });

  it("**判据②④⑤（逐条那两行，照抄 pd 20:25 定稿）**：六项都在，而且带上「这一条算读过了」那半句", () => {
    const line = renderOne(poison, ME, 3, 7);
    expect(() => renderOne(poison, ME, 3, 7)).not.toThrow();
    expect(line).toContain("01BAD");                       // id
    expect(line).toContain("第 4／7 条");                    // 第几条／总数（人数的是 1 起）
    expect(line).toContain("kind task(claim)");            // kind 带 op，pd 点名要这个写法
    expect(line).toContain("actor pm");                    // 谁写的
    expect(line).toContain("2026-10-31T18:39:00.000Z");    // 时刻，按原样（判据 4）
    expect(line, "那句 JS 的话也要在——它是原因，不是全部").toMatch(/join/);
    // **判据 5 的要害**：这一行必须自己说出「会不会再来」，否则读的人分不清自己是丢了还是没丢
    expect(line).toContain("这一条算读过了，游标会越过它");
    expect(line, "**不许说成「还会来」**：那是整批那一条路的话").not.toContain("再来一遍");
    expect(line, "逐字照 pd 定稿").toBe(unrenderableLine({
      nth: 4, total: 7, id: "01BAD", kind: "task(claim)", actor: "pm",
      at: "2026-10-31T18:39:00.000Z", why: "Cannot read properties of undefined (reading 'join')",
    }));
  });

  it("**判据 5 的另一半**：逐条崩掉之后，游标确实越过了它（这一行就是它的交付）", async () => {
    const p = puller([ev("01A"), poison, ev("01C")]);
    const seen = cursorStore(null);
    const cursor = cursorStore(null);
    const out: string[] = [];
    await sync(p as never, ME, cursor as never, 0, (l) => out.push(l), undefined, undefined, seen as never);
    expect(seen.value, "越过它：这一批算交付了，不会永远卡在这一条上").toBe("01C");
    expect(out.some((l) => l.includes("这一条算读过了")), "而那一行说出了这件事").toBe(true);
    expect(out.some((l) => l.includes("整个再来一遍")), "**整批那一句不许在这里出现**").toBe(false);
  });

  it("**不丢**：一条崩了，整批照常印完，后面那些一条都不少", () => {
    const r = { events: [ev("01A"), poison, ev("01C")], cursor: "01C", owed: undefined } as unknown as PullResult;
    const lines = report(r, ME, "01PREV");
    expect(lines.filter((l) => l.startsWith("01A")).length).toBe(1);
    // pd 的定稿把 id 写在句子里（`id 01M…`），所以这一行不再以 id 开头——按「出现过」数，不按「开头」数。
    expect(lines.filter((l) => l.includes("01BAD")).length).toBe(1);
    expect(lines.filter((l) => l.startsWith("01C")).length, "**它后面那些不许因为它消失**").toBe(1);
  });

  it("正常的事件一个字没变（这道兜底只在抛的时候出现）", () => {
    const line = renderOne(ev("01A"), ME, 0, 1);
    expect(line).toContain("01A");
    expect(line).toContain("一条正常的 note");
    expect(line).not.toContain("渲染失败");
  });
});
