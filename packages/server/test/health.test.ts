/**
 * t-249 · 健康检查答 ok 的时候要说出自己答得有多慢。
 *
 * 本件存在的理由是 qa 00:15 那一句，判据 2 要求留着它：**「一个不设期限的健康检查在任何故障里都会说 ok，
 * 这跟它探什么无关。」** 实测基线（qa 00:14）：稳态 0.24s、最慢 48.13s，**而两者正文逐字相同**——
 * 九次卡住全是 200、全是 `{ ok: true, sha }`。
 *
 * 它服务 **T8**（少了谁都不停：机器答不答得动，得有人看得出来）与 **T1**（对世界的认知一致：
 * 「它说 ok」和「它答得动」此前是两回事）。
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";
import { LoopLag, healthBody, queueDelayMs, sampleLoopLag, HEALTH_BUDGET_MS, HEALTH_WINDOW_MS, HEALTH_SAMPLE_MS, STORE_PROBE } from "../src/health.js";

const TOKEN = "secret-token";

function server(sha = "abc1234") {
  const app = createApp({ store: new MemoryStore(), token: TOKEN, human: "human", sha });
  let base = "";
  return {
    get base() { return base; },
    health: async () => (await fetch(`${base}/health`)).json() as Promise<Record<string, unknown>>,
    start: async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; },
    stop: () => new Promise<void>((r) => app.close(() => r())),
  };
}

describe("t-249 · 判据 1：回包里要带时间", () => {
  it("正文带上这次等了多久、最近最坏多久、期限是多少——不再是稳态与卡住逐字相同的一行", async () => {
    const v = server();
    await v.start();
    try {
      const b = await v.health();
      expect(b.sha).toBe("abc1234");
      expect(typeof b.queue_ms).toBe("number");
      expect(typeof b.lag_max_ms).toBe("number");
      expect(b.budget_ms).toBe(HEALTH_BUDGET_MS);
      expect(b.window_ms).toBe(HEALTH_WINDOW_MS);
      expect(b.ok).toBe(true);
    } finally { await v.stop(); }
  });

  /**
   * **判据 1 的真正内容：两种状态下正文必须不同。** 上一版过不了这一条——它两种状态下一个字都不差。
   *
   * 这一条走真路由，而且不靠「跑得慢一点」碰运气：**真把事件循环同步堵住**（就是 `DatabaseSync` 干的事），
   * 让采样器把那一段记进窗口，然后再问一次 `/health`。
   *
   * **我第一版把这条写错了，写法留在这儿当教训**：我原来断言堵塞期间那次请求的 `queue_ms` 会长出来。
   * 它不会——在同一个进程里，客户端连把请求发出去都要先拿到一个回合，于是堵塞结束之后请求才出门，
   * `queue_ms` 量到 0。**而那正是 queue_ms 在生产上也有的盲区**：它只看得见处理函数跑起来时还在继续的堵塞。
   * 兜住「刚才卡过」的是 `lag_max_ms`，所以判据 1 该由它来证。
   */
  it("事件循环真被堵住之后，正文就说得出「刚才卡过多久」并且不再说 ok——两种状态不再逐字相同", async () => {
    const v = server();
    await v.start();
    try {
      const quiet = await v.health();
      expect(quiet.ok).toBe(true);
      const until = Date.now() + HEALTH_BUDGET_MS + 400;
      while (Date.now() < until) { /* 同步忙等：生产上那 48 秒就是这么来的，只是来自 sqlite 的同步 API */ }
      await new Promise((r) => setTimeout(r, 1200));        // 让采样器记下这一段
      const after = await v.health();
      expect(after.lag_max_ms as number).toBeGreaterThan(HEALTH_BUDGET_MS);
      expect(after.ok).toBe(false);
      expect(JSON.stringify(after)).not.toBe(JSON.stringify(quiet));
      expect(after.sha).toBe(quiet.sha);                    // 变的是耗时那几个数，不是它报的版本
    } finally { await v.stop(); }
  });
});

describe("t-249 · 判据 2：要有期限，超过就不算 ok", () => {
  it("期限之内说 ok；超过期限，同样一台机器说 not ok", () => {
    expect(healthBody("a", 10, 20).ok).toBe(true);
    expect(healthBody("a", HEALTH_BUDGET_MS, HEALTH_BUDGET_MS).ok).toBe(true);      // 正好在期限上还算数
    expect(healthBody("a", HEALTH_BUDGET_MS + 1, 0).ok).toBe(false);                // 这次自己慢了
    expect(healthBody("a", 0, HEALTH_BUDGET_MS + 1).ok).toBe(false);                // 这次不慢，但刚才卡过
  });

  /** 那个数是怎么定的：qa 那批实测两群之间的缝。缝的两侧各取一个真样本钉住，改数就要连这两条一起解释。 */
  it("期限落在 qa 实测那两群之间的缝里：最慢的稳态过得去，最轻的那次卡过不去", () => {
    const 稳态最慢 = 280, 卡住最轻 = 8320;   // 0.28s / 8.32s，qa 00:14
    expect(healthBody("a", 稳态最慢, 稳态最慢).ok).toBe(true);
    expect(healthBody("a", 卡住最轻, 卡住最轻).ok).toBe(false);
    expect(HEALTH_BUDGET_MS).toBeGreaterThan(稳态最慢);
    expect(HEALTH_BUDGET_MS).toBeLessThan(卡住最轻);
  });

  it("一次卡过去之后，下一次 /health 还说得出「刚才卡过」——窗口内最坏的那次不会立刻被忘掉", () => {
    let now = 1_000_000;
    const lag = new LoopLag(HEALTH_WINDOW_MS, () => now);
    lag.record(5000);
    now += 30_000;
    expect(lag.max()).toBe(5000);
    expect(healthBody("a", 1, lag.max()).ok).toBe(false);
    now += HEALTH_WINDOW_MS;                       // 窗口滑过去了，它不再替一件陈年旧事报警
    expect(lag.max()).toBe(0);
    expect(healthBody("a", 1, lag.max()).ok).toBe(true);
  });

  it("窗口按时刻裁，不按条数——采样频率变了，那个数的意思不许跟着变", () => {
    let now = 0;
    const lag = new LoopLag(1000, () => now);
    for (let i = 0; i < 500; i++) { now += 1; lag.record(1); }   // 五百条，全在窗口内
    now += 1; lag.record(42);
    expect(lag.max()).toBe(42);
    now += 999;
    expect(lag.max()).toBe(42);                                   // 还在窗口里
    now += 2;
    expect(lag.max()).toBe(0);
  });
});

describe("t-249 · 判据 3：说清它不覆盖哪一类", () => {
  it("正文自己说出探过什么、没探什么、谁覆盖没探的那一类", async () => {
    const v = server();
    await v.start();
    try {
      const b = await v.health();
      expect(b.checks).toEqual(["process", "event_loop"]);
      expect(b.not_checked).toEqual(["store"]);
      expect(b.store_probe).toBe(STORE_PROBE);
    } finally { await v.stop(); }
  });

  /**
   * **这一条是判据 3 的要害，不是措辞**：`/health` 是第一条路由，在鉴权与任何库访问之前。
   * 所以库整个坏掉，它照样很快地说 ok——**那不是缺陷，是它的范围**，而范围必须写在正文里，
   * 否则读的人会拿它当「库也好着」。这里把库真的弄坏，然后同时证明两件事。
   */
  it("库整个坏掉时它照样说 ok——所以 not_checked 里写着 store 才不是一句客气话", async () => {
    const broken = new MemoryStore();
    const boom = () => { throw new Error("库坏了"); };
    (broken as unknown as { read: () => unknown }).read = boom;
    (broken as unknown as { since: () => unknown }).since = boom;
    const app = createApp({ store: broken, token: TOKEN, human: "human", sha: "abc1234" });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const b = await (await fetch(`${base}/health`)).json() as Record<string, unknown>;
      expect(b.ok).toBe(true);                       // 它确实说 ok
      expect(b.not_checked).toContain("store");      // 而它同时说了「库我没探」
      // 而 store_probe 指的那条路在同一台机器上是探得出来的
      const probe = await fetch(`${base}/log?after=x`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "dev" } });
      expect(probe.status).toBeGreaterThanOrEqual(500);
    } finally { await new Promise<void>((r) => app.close(() => r())); }
  });
});

describe("t-249 · 量具本身", () => {
  it("queueDelayMs 量的是等一个回合要多久：循环空着时接近 0，堵住 200ms 时就报得出来", async () => {
    expect(await queueDelayMs()).toBeLessThan(50);
    const p = queueDelayMs();
    const until = Date.now() + 200;
    while (Date.now() < until) { /* 同步堵住 */ }
    expect(await p).toBeGreaterThan(100);
  });

  it("采样器记的是它自己迟到了多久：循环空着时接近 0，被同步堵住 400ms 就记得下来", async () => {
    const lag = new LoopLag();
    const stop = sampleLoopLag(lag);
    try {
      await new Promise((r) => setTimeout(r, HEALTH_SAMPLE_MS * 3));
      expect(lag.max()).toBeLessThan(HEALTH_SAMPLE_MS * 2);
      const until = Date.now() + 400;
      while (Date.now() < until) { /* 同步堵住 */ }
      await new Promise((r) => setTimeout(r, HEALTH_SAMPLE_MS * 2));
      expect(lag.max()).toBeGreaterThan(200);
    } finally { stop(); }
  });
});
