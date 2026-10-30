/**
 * t-308：**不要钥匙、而且每次重放整本日志的那两个公开地址。**
 *
 * 两件事叠在一处才是这张单：`GET /manual/<角色>` 与 `POST /invite/<code>/join` 都在鉴权之前
 * （`app.ts` 那一行注释写着「generic by construction, so they need no key」），而它们此前各自
 * `reduce(await …read())` —— **外人每打一次，服务端就从头折叠一遍整本日志**。qa 量的：生产那一版
 * 对 13,135 条事件跑一次 reduce 是 647 ms，容量约 1.4 个板级请求／秒。
 *
 * **这一份的对照格按 pm 18:20 立的第三层写：它自证活着。** 只断言「整本读取一次都没被叫过」是不够的——
 * 那一格会在 `override` 哪天不覆盖基类时一次都不叫、计数恒 0、测试全绿而什么也没守（这一条是我 18:12
 * 在自己另一份用例上量出来的）。所以每一格都在同一格里把开关关掉、真叫一次、断言计数**增加**了。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, MANUAL_ONLY_GENERIC, type Log } from "@ateam/core";
import { createApp } from "../src/app.js";
import { MemoryRegistry } from "../src/projects.js";
import { TEST_OWNER_SECRET } from "./owner.js";

const TOKEN = "secret-token";
const HUMAN = "human";

/** 数「整本读取」被叫了几次，并且可以让它必抛。写入那一路走 `readSince`，两条分得开。 */
class Counting extends MemoryStore {
  reads = 0;
  broken = false;
  override async read(): Promise<Log> {
    this.reads++;
    if (this.broken) throw new Error("整本读取坏了（注入）");
    return super.read();
  }
}

const store = new Counting();
let app: ReturnType<typeof createApp>;
let base = "";

beforeAll(async () => {
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, storeFor: () => store, token: TOKEN, human: HUMAN, registry: new MemoryRegistry(), sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { pm: ["R4"], dev: ["R5"] } }, { human: HUMAN });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

/** pm 18:20 的第三层：这一格自己证明它测得到那件事发生。一处写、两处用。 */
async function provesItCanSee(label: string) {
  store.broken = false;
  const before = store.reads;
  await store.read();
  expect(store.reads, `${label}：计数器与 override 都得是活的，否则上面那一格空着也能过`).toBe(before + 1);
}

describe("t-308 判据① · `GET /manual/<角色>` 不再重放整本日志", () => {
  it("**打坏整本读取之后它仍然答得出那一页**，而整本读取一次都没被叫过", async () => {
    store.broken = true;
    const before = store.reads;
    const res = await fetch(`${base}/manual/dev`, { headers: { accept: "text/markdown" } });
    expect(res.status, "它该照旧答得出").toBe(200);
    expect((await res.text()).length, "而且真有内容").toBeGreaterThan(50);
    expect(store.reads, "一次整本读取都不许有——若有，上面那一句会是 500").toBe(before);
    await provesItCanSee("判据①");
  });

  it("**不要钥匙这一半一个字没动**（判据④：不许顺手加一道闸把外部那支队伍挡在门外）", async () => {
    store.broken = false;
    const res = await fetch(`${base}/manual/dev`, { headers: { accept: "text/markdown" } });   // 不带 authorization
    expect(res.status, "外人照旧打得开").toBe(200);
    const unknown = await fetch(`${base}/manual/没这个角色`, { headers: { accept: "text/markdown" } });
    expect(unknown.status, "没声明过的角色照旧 404，这一条也没变").toBe(404);
  });
});

describe("t-308 判据② · `POST /invite/<code>/join` 不再重放整本日志", () => {
  /** pm 的单子标题写的是 `POST /projects`，而 `app.ts:360` 那一行其实是加入那条路。两者别混。 */
  it("**打坏整本读取之后节点照旧加入得进来**，而整本读取一次都没被叫过", async () => {
    store.broken = false;
    const made = await (await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "一个新项目" }) })).json() as { invite_url: string };
    const code = made.invite_url.split("/").pop()!;
    store.broken = true;
    const before = store.reads;
    const joined = await fetch(`${base}/invite/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: "a-1" }) });
    expect(joined.status, "加入这条路不该再依赖整本日志").toBeLessThan(300);
    const body = await joined.json() as { role?: string; node_key?: string };
    expect(body.role, "它该真的分到一个角色").toBeTruthy();
    expect(body.node_key, "并且拿到钥匙").toBeTruthy();
    expect(store.reads, "一次整本读取都不许有").toBe(before);
    await provesItCanSee("判据②");
  });
});

/**
 * t-309 判据③⑦⑧（pd 19:39 定稿、pm 19:43 合成一句）：**无钥匙时，三样可观测量都不许依赖项目——句子、状态码、长度。**
 *
 * 前两样我 19:20 量出来过，第三样是 qa 19:31 量的：真项目 13,907 B／不存在的项目 13,453 B，
 * **那两个字节数本身就回答了「这个项目存不存在」**。按「哪一段文字」划闸看不见它，按「依赖什么」划就看得见。
 */
describe("t-309 · 无钥匙的调用者分不出项目：句子、状态码、长度三样都一样", () => {
  const anon = (path: string) => fetch(`${base}${path}`, { headers: { accept: "text/markdown" } });
  const read = async (path: string) => { const r = await anon(path); const t = await r.text(); return { status: r.status, bytes: Buffer.byteLength(t, "utf8"), text: t }; };
  let real = "";

  beforeAll(async () => {
    store.broken = false;
    real = (await (await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "真的项目" }) })).json() as { project: string }).project;
    await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { dev: ["R5", "R9"], legal: ["R9"] } }, { human: HUMAN });
  });

  it("**长度**：真项目与两个不存在的项目，无钥匙拿到的回包逐字节一样长（判据⑦①②）", async () => {
    const a = await read(`/p/${real}/manual/dev`);
    const b = await read("/p/没这个项目/manual/dev");
    const c = await read("/p/也没有这个/manual/dev");
    expect(a.status).toBe(200);
    expect(b.bytes, "两个不同的假 id 之间先得一样").toBe(c.bytes);
    expect(a.bytes, `真项目 ${a.bytes} B ／ 假项目 ${b.bytes} B——这两个数本身不许回答「这个项目存不存在」`).toBe(b.bytes);
    expect(a.text, "连正文也逐字相同").toBe(b.text);
  });

  it("**状态码**：声明过的自定义角色与没声明的，无钥匙都是 404，而且是同一句（判据③）", async () => {
    const declared = await read(`/p/${real}/manual/legal`);     // 这个项目真声明了 legal
    const nowhere = await read("/p/没这个项目/manual/legal");
    expect(declared.status, "声明过也不许因此变成 200——那正是泄露").toBe(404);
    expect(nowhere.status).toBe(404);
    expect(JSON.parse(declared.text).message).toBe(MANUAL_ONLY_GENERIC);
    expect(declared.text, "连字节都一样").toBe(nowhere.text);
  });

  it("**通用那一份照旧无钥匙可得**（判据②后半：不许顺手收紧 M1／S8）", async () => {
    const a = await read("/manual/dev");
    expect(a.status).toBe(200);
    expect(a.text).toContain("第一句就是全部");
    expect(a.text, "而依赖项目的那一节不出现").not.toContain("## 你在这个项目里持有的职责");
  });

  it("判据⑧那张表：五行里无钥匙的那几行再也分不出项目，而带钥匙的照旧分得出——**对照就在同一条里**", async () => {
    const keyed = async (path: string) => { const r = await fetch(`${base}${path}`, { headers: { accept: "text/markdown", authorization: `Bearer ${TOKEN}` } }); return { status: r.status, text: await r.text() }; };
    // 无钥匙：真项目与假项目，两问两样都一致
    expect((await read(`/p/${real}/manual/dev`)).text).toBe((await read("/p/没这个项目/manual/dev")).text);
    expect((await read(`/p/${real}/manual/legal`)).status).toBe((await read("/p/没这个项目/manual/legal")).status);
    // 带钥匙：同一个地址分得出来——**这就是这一格的自证**：若闸被摘掉，上面两行会红；若闸把带钥匙的也挡了，这两行会红。
    const k1 = await keyed(`/manual/dev`);
    expect(k1.text, "带钥匙看得见这个项目给 dev 的那一节").toContain("## 你在这个项目里持有的职责");
    const k2 = await keyed(`/manual/legal`);
    expect(k2.status, "带钥匙时这个项目声明过的自定义角色照旧 200").toBe(200);
  });
});
