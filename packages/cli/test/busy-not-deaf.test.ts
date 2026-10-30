/**
 * t-300 判据 1、2、3：**服务端最忙的那一刻，看守不许聋掉。**
 *
 * 活体两个，都在 2026-10-30：pd 08:4x 的看守死于一个 server 408（它据此量出机制）；pm 自己一直在听，
 * 只因为它把看守挂在「退出就重挂」的循环里——**那是自保不是修复**（pd 原话）。别人的节点仍然会在下一个
 * 408 上变聋，而他们不会知道。
 *
 * 机制：`isTransient` 原来是 `err.status >= 500`，而 `watch` 只在 transient 时退避重试、否则抛出去结束。
 * 于是 **408（请求超时）、429（太多请求）这两个「服务端忙，待会儿再来」的码，被归成了「我们自己发错了」**。
 * 那段注释自己已经写对了标准（「网络问题与 5xx 是服务端的时刻，不是我们的」）——是实现按区间判、没照它做。
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, ClientError, retryAfterMs } from "../src/client.js";
import { watch, isTransient, retryWait, OURS_NOT_THEIRS, RETRY_AFTER_MAX_MS, type CursorStore } from "../src/loop.js";

const store = (init: string | null): CursorStore => {
  let v = init;
  return { read: () => v, write: (c) => { v = c; } };
};
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** 一台只会说某个码的服务（可带 Retry-After）。`seen` 数它被问过几次。 */
async function says(status: number, headers: Record<string, string> = {}) {
  const seen = { n: 0 };
  server = createServer((_req, res) => {
    seen.n += 1;
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ error: "busy" }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { seen, client: new Client({ me: "dev", url: base, token: "k" }) };
}

describe("t-300 判据 3 · 一台只回 408 的服务：看守没有退出", () => {
  it("408 ⇒ 退避重试，看守活着；它确实又去问了服务端", async () => {
    const { seen, client } = await says(408);
    const ac = new AbortController();
    const waited: number[] = [];
    const p = watch(client, "dev", store(null), 60_000, () => {}, {
      signal: ac.signal,
      backoffMs: [1, 1, 1],
      sleep: async (ms) => { waited.push(ms); if (waited.length >= 3) ac.abort(); },
    });
    await expect(p, "**不许抛**——抛出去就是看守结束，就是那个节点聋掉").resolves.toBeDefined();
    expect(waited.length, "它真的退避重试了，不是一次就走").toBeGreaterThanOrEqual(3);
    expect(seen.n, "服务端真的被又问了几次").toBeGreaterThanOrEqual(3);
  }, 20_000);

  it("429 同样不聋——它和 408 是同一句话的两种说法", async () => {
    const { client } = await says(429);
    const ac = new AbortController();
    let n = 0;
    await expect(watch(client, "dev", store(null), 60_000, () => {}, {
      signal: ac.signal, backoffMs: [1], sleep: async () => { if (++n >= 2) ac.abort(); },
    })).resolves.toBeDefined();
    expect(n).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("真属于我们的那一类照旧让看守停下来——这次改动不许把所有错都变成「再试一次」", async () => {
    const { client } = await says(403);
    await expect(watch(client, "dev", store(null), 60_000, () => {}, { backoffMs: [1], sleep: async () => {} }))
      .rejects.toBeInstanceOf(ClientError);
  }, 20_000);
});

describe("t-300 判据 1 · 按含义分类，不按区间", () => {
  it("「服务端的时刻」那一边：408、425、429、503、504，以及 5xx", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504])
      expect(isTransient(new ClientError(s, { error: "x" })), `${s}`).toBe(true);
  });

  it("「我们自己发错了」那一边：400、401、403、404、409、422", () => {
    for (const s of [400, 401, 403, 404, 409, 422])
      expect(isTransient(new ClientError(s, { error: "x" })), `${s}`).toBe(false);
    expect([...OURS_NOT_THEIRS].sort((a, b) => a - b)).toEqual([400, 401, 403, 404, 409, 422]);
  });

  it("**名单只列我们那一边，另一边是默认**：没列进来的码按「服务端的时刻」处理", () => {
    for (const s of [413, 418, 499, 598])
      expect(isTransient(new ClientError(s, { error: "x" })), `${s} 默认该重试`).toBe(true);
  });
});

describe("t-300 判据 2 · 等多久是服务端说的", () => {
  it("Retry-After 两种写法都认：秒数与 HTTP-date", () => {
    const now = new Date("2026-10-30T09:00:00.000Z");
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Fri, 30 Oct 2026 09:00:45 GMT", now)).toBe(45_000);
    expect(retryAfterMs(null, now), "没说就是没说").toBeUndefined();
    expect(retryAfterMs("随便", now), "认不出来就说不出").toBeUndefined();
    expect(retryAfterMs("Fri, 30 Oct 2026 08:59:00 GMT", now), "过去的时刻 ⇒ 0，不是负数").toBe(0);
  });

  it("服务端说了就照它说的，没说才用自己的退避表", () => {
    const backoff = [1_000, 2_000];
    expect(retryWait(new ClientError(429, { error: "x" }, 7_000), backoff, 0, 60_000)).toBe(7_000);
    expect(retryWait(new ClientError(429, { error: "x" }), backoff, 0, 60_000), "没说 ⇒ 退避表").toBe(1_000);
    expect(retryWait(new Error("断网"), backoff, 1, 60_000)).toBe(2_000);
  });

  it("一个荒谬的 Retry-After 要封顶——睡一天和聋掉没有区别", () => {
    expect(retryWait(new ClientError(429, { error: "x" }, 86_400_000), [1_000], 0, 60_000)).toBe(RETRY_AFTER_MAX_MS);
  });

  it("端到端：服务回 429 ＋ Retry-After: 2，看守等的就是 2 秒那一档", async () => {
    const { client } = await says(429, { "retry-after": "2" });
    const ac = new AbortController();
    const waited: number[] = [];
    await watch(client, "dev", store(null), 60_000, () => {}, {
      signal: ac.signal, backoffMs: [1], sleep: async (ms) => { waited.push(ms); ac.abort(); },
    });
    expect(waited[0], "不是退避表里那个 1 ms").toBe(2_000);
  }, 20_000);
});
