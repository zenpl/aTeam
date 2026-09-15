/**
 * t-274：**后台 `watch` 把游标推过去，于是重启之后的 `sync` 说「nothing new」——而指令确实到过。**
 *
 * qa 14:10 亲历并报：它今天 12.66 小时的沉默就是这么来的，14:09 一次性 ack 了 21 条。
 * 我 14:14 端到端复现过那一幕（真服务端、真 watch、真 kill、真 sync），并用对照组定位：
 * 决定 `sync` 印不印的是**本地** `.ateam/cursor.<me>`（`watch` 的 `advance` 推的），
 * 不是服务端那次 `setCursor`——对照组里服务端游标照旧不动、只把本地游标拨回去，同一条当场逐字印出来。
 *
 * 修法不是「`watch` 别推游标」（判据 3 的禁令）：那样它每轮重复报同一批，t-225 那条链付过学费。
 * 分成两样——`cursor` 是送到了，`seen` 是有人读过了。下面一正一反各钉一件，外加那条禁令本身。
 */
import { describe, it, expect } from "vitest";
import type { Event, PullResult } from "@ateam/core";
import { sync, watch, type CursorStore, type Puller } from "../src/loop.js";

const ME = "qa";
const at = "2026-09-15T14:14:00.000Z";
const LOG: Event[] = [
  { id: "01A", actor: "pm", at, kind: "note", body: "先有一条不相干的" },
  { id: "01B", actor: "pm", at, kind: "instruction", to: ME, body: "四件等你判：t-262/t-267/t-272/t-273", ack_by: "2026-09-15T18:14:00.000Z" },
  { id: "01C", actor: "pm", at, kind: "instruction", to: ME, body: "再补一条", ack_by: "2026-09-15T18:14:00.000Z" },
];

/** 一个把整本日志一次给出去的服务端；记下每次被问到的 `after`。 */
function server(): Puller & { asked: (string | null)[] } {
  const asked: (string | null)[] = [];
  return {
    asked,
    async pull(after) {
      asked.push(after);
      const start = after ? LOG.findIndex((e) => e.id === after) + 1 : 0;
      const events = LOG.slice(start);
      return { events, for_me: events.filter((e) => e.kind === "instruction" && e.to === ME), cursor: events.length ? events[events.length - 1].id : after } as PullResult;
    },
  };
}

function memoryCursor(init: string | null = null): CursorStore {
  let c = init;
  return { read: () => c, write: (v) => { c = v; } };
}

describe("t-274 · 送到了与有人读过了，是两样", () => {
  it("正：`watch` 把「送到了」推过那两条之后进程死掉——重启后的 `sync` 仍然逐字看得见它们", async () => {
    const delivered = memoryCursor(), seen = memoryCursor();
    const watched: string[] = [];
    // watch 拉到、印进它自己那个管道，然后（模拟被杀）不再有人读那个管道
    await watch(server(), ME, delivered, 10, (l) => watched.push(l), { once: true });
    expect(watched.join("\n"), "它确实到过这个节点").toContain("四件等你判");
    expect(delivered.read(), "「送到了」被推过去了").toBe("01C");
    expect(seen.read(), "而「有人读过了」一步没动").toBeNull();

    // 重启：同一个 .ateam，跑一次 sync
    const out: string[] = [];
    await sync(server(), ME, delivered, 0, (l) => out.push(l), undefined, undefined, seen);
    const text = out.join("\n");
    expect(text, "这正是改前说的那句").not.toContain("nothing new");
    expect(text).toContain("四件等你判：t-262/t-267/t-272/t-273");
    expect(text).toContain("再补一条");
    expect(seen.read(), "印给人之后才推「有人读过了」").toBe("01C");
  });

  it("反：已经读过的那个节点不被重复打扰——同一条不会印第二遍", async () => {
    const delivered = memoryCursor(), seen = memoryCursor();
    const first: string[] = [];
    await sync(server(), ME, delivered, 0, (l) => first.push(l), undefined, undefined, seen);
    expect(first.join("\n")).toContain("四件等你判");

    const second: string[] = [];
    await sync(server(), ME, delivered, 0, (l) => second.push(l), undefined, undefined, seen);
    expect(second.join("\n"), "读过了就不再印").not.toContain("四件等你判");
    expect(second.join("\n")).toContain("nothing new");
  });

  it("判据 3 的那条禁令：`watch` 自己照旧不重复——它问的仍然是「送到了」那一处", async () => {
    const delivered = memoryCursor(), seen = memoryCursor();
    const s1 = server();
    await watch(s1, ME, delivered, 10, () => {}, { once: true });
    expect(s1.asked, "第一轮从头问").toEqual([null]);
    expect(delivered.read()).toBe("01C");

    // 接着跑的第二个 watch：服务端此后又来了一条 01D。它必须从 delivered（01C）往下问，不是从 seen（null）。
    const later: Event = { id: "01D", actor: "pm", at, kind: "instruction", to: ME, body: "后来的一条", ack_by: "2026-09-15T18:14:00.000Z" };
    const asked: (string | null)[] = [];
    const s2: Puller = {
      async pull(after) {
        asked.push(after);
        const all = [...LOG, later];
        const start = after ? all.findIndex((e) => e.id === after) + 1 : 0;
        const events = all.slice(start);
        return { events, for_me: events.filter((e) => e.kind === "instruction" && e.to === ME), cursor: events.length ? events[events.length - 1].id : after } as PullResult;
      },
    };
    const again: string[] = [];
    await watch(s2, ME, delivered, 10, (l) => again.push(l), { once: true });
    expect(asked[0], "接着上次的位置问，不是回到 seen 那一处").toBe("01C");
    expect(again.join("\n"), "所以那两条它一条都不重印").not.toContain("四件等你判");
    expect(again.join("\n"), "只印真正新的那一条").toContain("后来的一条");
    expect(seen.read(), "watch 一路没碰过「有人读过了」").toBeNull();
  });

  it("`seen` 不给就退回今天的行为：两者同一个位置，一条路的调用方不受影响", async () => {
    const only = memoryCursor();
    const out: string[] = [];
    await sync(server(), ME, only, 0, (l) => out.push(l));
    expect(out.join("\n")).toContain("四件等你判");
    expect(only.read()).toBe("01C");
    const again: string[] = [];
    await sync(server(), ME, only, 0, (l) => again.push(l));
    expect(again.join("\n")).toContain("nothing new");
  });
});
