/**
 * pm 09:39 留下的那个问题，和它自己收窄掉的那条口径。
 *
 * pm 08:4x 曾定：「`502` ⇒ 没落，可安全重发」。09:39 它自己收窄了，理由是**那个结论是从客户端侧的量测
 * 推出来的**（qa 量的是游标在 502 时没被推进），而「服务端写没写」没有任何人量过。pm 把问法也留下了：
 * **「造一个在收下请求之后、回包之前超时的桩，看事件落没落。谁量都行，一次就够。」**
 *
 * 这一份就是那个桩，整件事在本机跑：真 app ＋ 一个夹在中间的 TCP 桩，生产一个字节都不碰。
 *
 * **量出来的结论比「未知」更强：它是构造性地不可知。** 三个码各做一对——先转给 app、等它真答了再对客户端
 * 做手脚（app 已经写过），与根本不转给 app（app 没收到）。**每一对里客户端看到的东西一模一样，而日志一边多
 * 了一条、一边没有。** 所以 pm 收窄后那条「写入失败一律先核再补」不是谨慎，是证据只允许这一条；而它 08:4x
 * 给 502 开的那个例外，这里直接被 `502-after` 推翻：客户端看到 502，事件落下去了。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { MemoryStore } from "@ateam/core";
import { createApp } from "../src/app.js";
import { TEST_OWNER_SECRET } from "./owner.js";

const TOKEN = "secret-token";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let APP = 0;

beforeAll(async () => {
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: "human", sha: "rig0000" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  APP = (app.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

/** 边缘怎么失败：掐断连接，或自己回一个码。两种都不转达 app 真正的回包。 */
const EDGE = {
  reset: null,
  502: "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 11\r\nconnection: close\r\n\r\nBad Gateway",
  408: "HTTP/1.1 408 Request Timeout\r\ncontent-length: 15\r\nconnection: close\r\n\r\nRequest Timeout",
} as const;

/** `when` 是关键：after ＝ app 已经答过（也就是已经写过）；before ＝ app 根本没收到。 */
async function stub(how: keyof typeof EDGE, when: "after" | "before") {
  const reply = EDGE[how];
  const finish = (client: net.Socket) => { if (reply) client.end(reply); else client.destroy(); };
  const srv = net.createServer((client) => {
    client.on("error", () => {});
    if (when === "before") { client.once("data", () => finish(client)); return; }
    const up = net.connect(APP, "127.0.0.1");
    up.on("error", () => client.destroy());
    client.pipe(up);
    up.once("data", () => { finish(client); up.destroy(); });   // 第一个字节就是回包的开头 ⇒ append 已经发生
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { port: (srv.address() as AddressInfo).port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const notes = async () => (await store.read()).events.filter((e) => e.kind === "note").length;
/** 落库是异步的，给它一个有界的等待——不是固定 sleep，也不是无限等。 */
async function settle(was: number): Promise<number> {
  for (let i = 0; i < 40; i++) {
    const n = await notes();
    if (n > was) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
  return notes();
}
/** 客户端看到的那一样东西，归一成一个字符串——它就是人与看守唯一拿得到的信息。 */
async function clientSees(port: number, body: unknown): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "frontend", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return `HTTP ${res.status}`;
  } catch (e) {
    return `失败：${((e as { cause?: { code?: string } }).cause?.code) ?? (e as Error).name}`;
  }
}

async function run(how: keyof typeof EDGE, when: "after" | "before") {
  const s = await stub(how, when);
  const was = await notes();
  const saw = await clientSees(s.port, { kind: "note", body: `桩 ${how}-${when} ${Date.now()}` });
  const now = await settle(was);
  await s.close();
  return { saw, landed: now > was };
}

describe("写入失败时，客户端看到的那一样东西说不出事件落没落", () => {
  it("对照：直连 app，201，而且确实落了", async () => {
    const was = await notes();
    expect(await clientSees(APP, { kind: "note", body: `桩 对照 ${Date.now()}` })).toBe("HTTP 201");
    expect(await settle(was)).toBe(was + 1);
  });

  for (const how of ["reset", "502", "408"] as const) {
    it(`${how}：同一个症状两种结局——一边落了、一边没落，而客户端分不出`, async () => {
      const after = await run(how, "after");     // app 答过了 ⇒ 写过了
      const before = await run(how, "before");   // app 没收到 ⇒ 没写过
      expect(after.landed, `${how}-after 应当落下去（app 已经答过）`).toBe(true);
      expect(before.landed, `${how}-before 不该落（app 没收到）`).toBe(false);
      // **这一行才是结论**：两次结局相反，而客户端拿到的是同一个字符串。
      expect(after.saw).toBe(before.saw);
    });
  }

  it("所以 pm 08:4x 给 502 开的那个例外不成立：看到 502 不等于没落", async () => {
    expect((await run("502", "after")).landed).toBe(true);
  });
});
