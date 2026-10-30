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
/** 两个服务端（开关为真／为假）共用这一份：判据⑨ 那一格要在两边问同一个真项目。 */
const registry = new MemoryRegistry();
let app: ReturnType<typeof createApp>;
let base = "";

beforeAll(async () => {
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, storeFor: () => store, token: TOKEN, human: HUMAN, registry, sha: "abc1234" });
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
 * 接缝 t-307+t-308（pm 19:21 裁，执行归我这一侧，因为我是后落地的那一半）：
 * **两支各修了对方没修的那一处**——我修 `/manual` 与邀请加入，frontend 修 `/release`，
 * **合并时任一半被取掉，刚修好的那条路就无声退回**。所以证据要三条路各一格，
 * 每格自证活着，**不许一格盖三条**：`/manual` 与加入那两格在上面（判据①②），这是第三格。
 */
describe("接缝 t-307+t-308 第三格 · `GET /release` 也不再重放整本日志（frontend 那一半）", () => {
  it("**打坏整本读取之后那一页照旧打得开**，而整本读取一次都没被叫过", async () => {
    store.broken = true;
    const before = store.reads;
    const res = await fetch(`${base}/release`, { headers: { accept: "text/html" } });
    expect(res.status, "合完之后它该照旧答得出这一页；frontend 那一半被取掉就是 500").toBe(200);
    expect((await res.text()).length, "而且真有内容").toBeGreaterThan(50);
    expect(store.reads, "一次整本读取都不许有").toBe(before);
    await provesItCanSee("接缝第三格");
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

/**
 * t-309 判据⑨⑩（pd 20:12 的 decision、pm 20:14 收成判据）：**那个本该决定这件事的开关。**
 *
 * pd 在发车那一支上核出来的缺陷不是「`/manual` 是公开的」，是**「它公开得不管那个本该决定这件事的开关」**：
 * `boardPublic` 守的是牌桌、`/task`、`/release` 三处，而 `/manual/<角色>` 排在它们前面，整条路一次都没问过它。
 * ⇒ 一个把 `boardPublic` 设成 false 的部署，照旧无钥匙吐出那个项目的职责打包。
 *
 * **而我这一笔没有往 `/manual` 上加那个开关，我加的是一道比它更紧的闸——这一点我写在明处，由验收去判**：
 * 无钥匙时连 `registry.get` 都不做（判据③），于是**开关为真为假拿到的是同一份**，而那一份不依赖项目。
 * 按判据⑩ 的两问：`boardPublic: true` 是对**牌桌**的一次明示公开，**它从来没明示过 `/manual`**，所以这条路
 * 不在那次明示底下；而无钥匙那一边既然已经没有任何项目相关的东西，再去问那个开关也改不了答案。
 * **开关为假时该红的那一格因此就在这里**：那道闸若被摘掉，`boardPublic: false` 的服务端会照旧吐出职责打包。
 *
 * 判据⑨ 要两问，而**那一格要自证活着**——所以第三条用例证明这两个服务端的开关真的取了不同的值
 * （同一个无钥匙请求一边 401、一边 200），否则上面两格可能只是把同一件事量了两遍。
 */
describe("t-309 判据⑨ · `boardPublic` 两种取值下，无钥匙的说明书都不依赖项目", () => {
  let shut: ReturnType<typeof createApp>;
  let shutBase = "";
  let real = "";
  const read = async (b: string, path: string) => {
    const r = await fetch(`${b}${path}`, { headers: { accept: "text/markdown" } });
    const t = await r.text();
    return { status: r.status, bytes: Buffer.byteLength(t, "utf8"), text: t };
  };

  beforeAll(async () => {
    store.broken = false;
    // 同一份 store、同一份 registry，只有这一个开关不同——**两个服务端之间唯一的差别必须是它**，
    // 否则下面两格的「一样」可能来自别的地方。
    shut = createApp({ ownerSecret: TEST_OWNER_SECRET, store, storeFor: () => store, token: TOKEN, human: HUMAN, registry, sha: "abc1234", boardPublic: false });
    await new Promise<void>((r) => shut.listen(0, "127.0.0.1", r));
    shutBase = `http://127.0.0.1:${(shut.address() as AddressInfo).port}`;
    real = (await (await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "开关为假的那个项目" }) })).json() as { project: string }).project;
    await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: { dev: ["R5", "R9"], legal: ["R9"] } }, { human: HUMAN });
  });
  afterAll(() => new Promise<void>((r) => shut.close(() => r())));

  it("**开关为假**：无钥匙问真项目的说明书，与问一个不存在的项目逐字节相同——职责那一节一行都没有", async () => {
    const a = await read(shutBase, `/p/${real}/manual/dev`);
    const b = await read(shutBase, "/p/没这个项目/manual/dev");
    expect(a.status, "通用那一份照旧给（M1／S8：陌生节点加入前要读得到自己的说明书）").toBe(200);
    expect(a.bytes, `真项目 ${a.bytes} B ／ 假项目 ${b.bytes} B——开关为假时这两个数更不许分得出来`).toBe(b.bytes);
    expect(a.text, "连正文也逐字相同").toBe(b.text);
    expect(a.text, "依赖项目的那一节不出现").not.toContain("## 你在这个项目里持有的职责");
    const legal = await read(shutBase, `/p/${real}/manual/legal`);
    expect(legal.status, "这个项目声明过 legal，而无钥匙时它照旧 404——状态码也不许回答「有没有这个角色」").toBe(404);
  });

  it("**开关为真**：同一对请求在公开那一个服务端上，答复同样不依赖项目（闸不随开关变松）", async () => {
    const a = await read(base, `/p/${real}/manual/dev`);
    const b = await read(base, "/p/没这个项目/manual/dev");
    expect(a.status).toBe(200);
    expect(a.text, "开关为真时也一样——这一份与开关无关").toBe(b.text);
    expect(a.text).not.toContain("## 你在这个项目里持有的职责");
    const shutSide = await read(shutBase, `/p/${real}/manual/dev`);
    expect(a.text, "两个服务端给无钥匙的人的是同一份字").toBe(shutSide.text);
  });

  it("**这一格自证活着**：同一个无钥匙请求在两个服务端上拿到的牌桌状态码不同（401 ／ 200）——上面两格真的测在开关的两种取值上", async () => {
    const shutBoard = await fetch(`${shutBase}/`, { headers: { accept: "text/html" } });
    const openBoard = await fetch(`${base}/`, { headers: { accept: "text/html" } });
    expect(shutBoard.status, "开关为假：无钥匙看不见牌桌").toBe(401);
    expect(openBoard.status, "开关为真：无钥匙看得见牌桌").toBe(200);
    expect(shutBoard.status, "两个数必须不同，否则这一对服务端的开关是恒等的，上面两格什么也没证").not.toBe(openBoard.status);
  });
});
