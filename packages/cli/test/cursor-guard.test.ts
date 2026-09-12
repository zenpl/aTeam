/**
 * t-225：**一次坏响应不得清掉游标，也不得杀掉进程。**
 *
 * 端到端复现过的那条链：HTTP 200、正文不是 JSON ⇒ `client.ts` 在 `.catch` 里造一个 `{ error }` 顶上去 ⇒
 * `res.ok` 为真，于是这个替身被当成 `PullResult` 返回 ⇒ `cursor` 是 `undefined`（走过两道只认 `null` 的闸，
 * 把游标写没了）、`events` 是 `undefined`（下一行抛）⇒ 进程 exit 1。**一次坏响应同时清游标并杀进程。**
 *
 * 三处各有闸，这里逐条钉住。
 */
import { describe, it, expect } from "vitest";
import { advance, isTransient, watch, type CursorStore, type Puller } from "../src/loop.js";
import { BadResponse, ClientError, Client } from "../src/client.js";

const store = (init: string | null): CursorStore & { value: string | null; writes: number } => {
  const s = { value: init, writes: 0, read: () => s.value, write: (c: string | null) => { s.value = c; s.writes += 1; } };
  return s;
};
const OLD = "01M00000000000000000000000", NEW = "01M99999999999999999999999";

describe("t-225 判据 2 · advance 先问「这是不是一个位置」，再问「它是不是更新」", () => {
  it("正例一：更新的 ULID 写进去", () => {
    const c = store(OLD);
    expect(advance(c, NEW)).toBe(true);
    expect(c.value).toBe(NEW);
  });

  it("正例二：更旧的 ULID 不写（游标只往前，t-049）", () => {
    const c = store(NEW);
    expect(advance(c, OLD)).toBe(false);
    expect([c.value, c.writes]).toEqual([NEW, 0]);
  });

  it("反例一：undefined 不许写——**这正是打进来的那个值**，旧版两道闸都放它过去", () => {
    const c = store(NEW);
    expect(advance(c, undefined as unknown as string)).toBe(false);
    expect(c.value, "游标一个字都不许动").toBe(NEW);
    expect(c.writes, "连写都不许发生一次").toBe(0);
  });

  it("反例二：null 不许覆盖已有的位置（原来就有的闸，没被这次改动带走）", () => {
    const c = store(NEW);
    expect(advance(c, null)).toBe(false);
    expect([c.value, c.writes]).toEqual([NEW, 0]);
  });

  it("不是位置的东西一律拒：数字、对象、空串——闸认的是「一个 ULID 或 null」，不是「不等于 null」", () => {
    for (const bad of [0, 1, {}, [], "", "   ", NaN]) {
      const c = store(NEW);
      expect(advance(c, bad as unknown as string), JSON.stringify(bad)).toBe(false);
      expect(c.writes, JSON.stringify(bad)).toBe(0);
    }
  });

  it("空日志那一格仍然成立：还没有位置时，null 写得进去（这是「我从头读」的意思）", () => {
    const c = store(null);
    expect(advance(c, null)).toBe(true);
  });
});

describe("t-225 判据 1、3 · 正文坏掉是一次失败，不是一个假的 PullResult", () => {
  it("坏响应算服务那一侧的时刻：看守重试，不退出", () => {
    expect(isTransient(new BadResponse(200, "<html>502 Bad Gateway")), "200 带一张网关页").toBe(true);
    expect(isTransient(new ClientError(500, { error: "boom" })), "5xx 照旧").toBe(true);
    expect(isTransient(new ClientError(409, { error: "rejected" })), "4xx 是我们自己的事").toBe(false);
  });

  it("看守撞上坏响应：游标不动、进程不死、说出发生了什么，然后继续", async () => {
    const c = store(NEW);
    let calls = 0;
    const puller: Puller = {
      pull: async () => {
        calls += 1;
        if (calls === 1) throw new BadResponse(200, "<!doctype html><title>登录</title>");
        return { events: [], for_me: [], cursor: NEW };
      },
    };
    const out: string[] = [];
    const ctl = new AbortController();
    // 第二次拉取时就收工：**不靠 print 被调用来结束**——空拉取本来就不打印，靠它结束会挂住整个用例
    const stopping: Puller = { pull: async (a, w) => { const r = await puller.pull(a, w); ctl.abort(); return r; } };
    await watch(stopping, "dev", c, 10, (l) => out.push(l), { sleep: async () => {}, signal: ctl.signal, backoffMs: [1] });
    expect(calls, "撞上之后还在拉").toBeGreaterThanOrEqual(2);
    expect(c.value, "游标一个字没动").toBe(NEW);
    expect(out.join("\n"), "说得出是哪一种坏").toContain("正文不是可解析的 JSON");
  });

  it("消息里带着正文开头：网关页、登录页、截断的 JSON，一眼分得出是哪一种", () => {
    expect(new BadResponse(200, "<html>502").message).toContain("<html>502");
    expect(new BadResponse(200, "").message, "空正文也要说出来，别让它长得像别的").toContain("空正文");
  });
});

/**
 * **这一组是注入逼出来的。** 我先只写了 `isTransient` 与 `watch` 那两条，然后把 client 那一处改回「造一个假的
 * `{error}` 顶上去」——**用例一条都没红**：我测的是「拿到 BadResponse 之后怎么办」，而**没有一条在测「什么时候
 * 该造出 BadResponse」**。端到端那次注入证得了它，可端到端不会在别人改坏它的时候红。
 */
describe("t-225 判据 1 · 谁把「200 带坏正文」变成一次失败", () => {
  const withFetch = async (status: number, body: string, ct = "text/html") => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status, headers: { "content-type": ct } })) as typeof fetch;
    try { return await new Client({ url: "http://x", me: "dev" }).pull(null); }
    finally { globalThis.fetch = real; }
  };

  it("200 ＋ 非 JSON 正文 ⇒ 抛 BadResponse，**不返回任何东西**", async () => {
    await expect(withFetch(200, "<!doctype html><title>502</title>")).rejects.toBeInstanceOf(BadResponse);
  });

  it("200 ＋ 空正文 ⇒ 同样是一次失败（空不等于「服务说了『没有新东西』」）", async () => {
    await expect(withFetch(200, "")).rejects.toBeInstanceOf(BadResponse);
  });

  it("4xx／5xx 带一张错误页 ⇒ 仍是 ClientError，不是 BadResponse——那是服务在说话", async () => {
    await expect(withFetch(502, "<html>bad gateway")).rejects.toBeInstanceOf(ClientError);
    await expect(withFetch(502, "<html>bad gateway")).rejects.not.toBeInstanceOf(BadResponse);
  });

  it("200 ＋ 正常 JSON ⇒ 照常返回（这道闸不许误伤好响应）", async () => {
    const r = await withFetch(200, JSON.stringify({ events: [], for_me: [], cursor: null }), "application/json");
    expect(r.cursor).toBeNull();
  });
});
