/**
 * t-234（P0）：**那道分辨「是不是主人」的闸从来没合上过。**
 *
 * qa 17:05 走 t-110 时想看一句拒绝话：拿环境里那把 token 发 `GET /board`、把 `x-actor` 换成 `human`。
 * **回的是 200**，而且带着只有管理者才有的 `invite_url`。根在那道闸只在 `ownerArrived()` 之后才生效——
 * 而本项目五天 `owner_key.state` 一直是 `none`，**主人从没到过，所以它一次都没开始工作**。
 *
 * **第二十五面，也是最贵的一面：「有一道闸」不等于「这道闸此刻是合上的」。** 我们读代码看见了它，就以为
 * 权限这一层有人管；它确实存在，它只是还没开始工作——而落点是整套东西唯一一处「人的最终权力」。
 *
 * 这一份守的是「未配置就锁上」：**不看主人到过没有**，一律只认他自己那把钥匙。判据 4 要求盘一遍所有
 * 认 `x-actor`／代人写入的门，所以下面是逐扇门走一遍，不是只走 `/events` 那一扇。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, type Event } from "@ateam/core";
import { createApp } from "../src/app.js";
import { MemoryRegistry } from "../src/projects.js";
import { ownerKeyOf, TEST_OWNER_SECRET } from "./owner.js";

const ADMIN = "ak_shared";
const HUMAN = "human";
const store = new MemoryStore();
const registry = new MemoryRegistry();
let app: ReturnType<typeof createApp>;
let base = "";
let OWNER = "";
let NODE = "";
const soon = () => new Date(Date.now() + 3_600_000).toISOString();

const events = (key: string, actor: string, body: unknown) =>
  fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
const button = (key: string, action: string, fields: Record<string, string>) =>
  fetch(`${base}${action}`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
const count = async () => (await store.read()).events.length;

beforeAll(async () => {
  app = createApp({ store, token: ADMIN, human: HUMAN, sha: "abc1234", registry, alertIntervalMs: 0, ownerSecret: TEST_OWNER_SECRET });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  OWNER = await ownerKeyOf(registry, "ateam", HUMAN);
  NODE = (await registry.nodeKey("ateam", "agent-1", "pm")).key;
  await events(ADMIN, "pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

describe("t-234 判据 1、2 · 主人还没到过，也不放行——未配置就锁上", () => {
  it("此刻确实是「从没有人拿到过地址」那一态：闸要在这一态下就已经合上", async () => {
    const b = await (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm" } })).json() as { owner_key: { state: string } };
    expect(["none", "issued"], "主人还没打开过").toContain(b.owner_key.state);
  });

  it("**写：以 human 名义发事件，用管理钥匙 ⇒ 拒，规则名说得出来，日志一条不多**", async () => {
    const before = await count();
    const r = await events(ADMIN, HUMAN, { kind: "note", body: "我替他说一句" });
    expect(r.status).toBe(403);
    expect((await r.json() as { rule: string }).rule).toBe("owner-key");
    expect(await count(), "被拒就是没写").toBe(before);
  });

  it("节点钥匙更不行，而且它连自己那一关都过不去（说的是「这把钥匙是 pm 的」）", async () => {
    const r = await events(NODE, HUMAN, { kind: "note", body: "我也替他说" });
    expect(r.status).toBe(403);
  });

  it("**读：`GET /board` 说自己是 human ⇒ 拒，`invite_url` 不会顺着这条路出去**（判据 3，qa 17:05 的原样本）", async () => {
    const r = await fetch(`${base}/board`, { headers: { authorization: `Bearer ${ADMIN}`, "x-actor": HUMAN } });
    expect(r.status, "这一格在 t-234 之前是 200").toBe(403);
    expect(JSON.stringify(await r.json())).not.toContain("invite_url");
  });

  it("**他自己那把钥匙照常**：说得了话，也仍然不能反过来冒充角色", async () => {
    expect((await events(OWNER, HUMAN, { kind: "note", body: "我自己说的" })).status).toBe(201);
    expect((await events(OWNER, "pm", { kind: "note", body: "我冒充 pm" })).status).toBe(403);
  });

  it("**角色照常说话，一点没变**——这道闸收紧的只有人的身份", async () => {
    expect((await events(ADMIN, "dev", { kind: "note", body: "角色照常" })).status).toBe(201);
    expect((await events(NODE, "pm", { kind: "note", body: "节点照常" })).status).toBe(201);
  });
});

/**
 * 判据 4：**盘一遍每一扇代人写入的门。** 牌桌上四个按钮（`/ack`、`/decide`、`/say`、`/fact`）与 `/events`
 * 写的是同一种事件、署的是同一个名字，所以它们归同一条规则管——今天已经两次「改了一处、同病第二处没改」。
 */
describe("t-234 判据 4 · 四个按钮与 API 同一条规则", () => {
  let card = "";
  beforeAll(async () => {
    card = (await (await events(ADMIN, "pm", { kind: "instruction", to: HUMAN, body: "选一个", options: ["A", "B"], ack_by: soon() })).json() as Event).id;
  });

  it.each([
    ["/say", { text: "替他说一句" }],
    ["/fact", { key: "alert.webhook", value: "https://hooks.example/x" }],
  ])("管理钥匙按 %s ⇒ 403，拒绝话与 /events 那条同一条规则", async (action, fields) => {
    const r = await button(ADMIN, action, fields);
    expect(r.status).toBe(403);
    expect((await r.json() as { rule: string }).rule).toBe("owner-key");
  });

  it("管理钥匙点卡 ⇒ 403；那张卡还挂着，没有被人「决定」过", async () => {
    expect((await button(ADMIN, "/decide", { id: card, option: "A" })).status).toBe(403);
    expect((await button(ADMIN, "/ack", { id: card })).status).toBe(403);
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm" } })).json() as { needs_human: { id: string }[] };
    expect(b.needs_human.map((x) => x.id), "替他点掉了").toContain(card);
  });

  it("他自己那把钥匙点得动，而且卡从「需要你」里走掉", async () => {
    expect((await button(OWNER, "/decide", { id: card, option: "A" })).status).toBe(201);
    const b = await (await fetch(`${base}/board?full=1`, { headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm" } })).json() as { needs_human: { id: string }[] };
    expect(b.needs_human.map((x) => x.id)).not.toContain(card);
  });
});

/**
 * 判据 4 的第五扇门，是我盘的时候才看见的：**加入这条路本身**。`/invite/<code>/join` 按 `project:roles`
 * 发节点钥匙，而那份名单是任何一个节点都能写的一条事实——**名单里写上 `human`，加入的人拿到的就是一把
 * role 恰好等于主人的钥匙**，于是它就是主人。这与 `:610` 是同一个病：判定「是不是他」的依据可以被别人写。
 */
describe("t-234 判据 4 · 加入这条路不许发出一把「人」的钥匙", () => {
  it("把 human 写进 project:roles 再照它加入 ⇒ 拒；拿不到一把主人的钥匙", async () => {
    const p = await (await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "冒名项目" }) })).json() as { project: string; admin_key: string; invite_url: string };
    const at = `${base}/p/${p.project}`;
    const code = p.invite_url.split("/").pop();
    const join = (agent: string, role?: string) =>
      fetch(`${base}/invite/${code}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent_id: agent, ...(role ? { role } : {}) }) });
    await fetch(`${at}/events`, { method: "POST", headers: { authorization: `Bearer ${p.admin_key}`, "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", HUMAN] }) });
    // **先让一个真角色占掉「第一个节点」**：不然冒名者会撞上「第一个节点要给人发一张卡」那条规则，
    // 被「不能给自己下指令」挡掉——**那是一次撞对的拒绝，不是这道闸**。第一版用例正是这样绿的。
    expect((await join("agent-pm")).status).toBe(201);
    const bad = await join("impostor", HUMAN);
    expect(bad.status, "加入不该发得出一把「人」的钥匙").toBe(409);
    const key = (await bad.json() as { node_key?: string }).node_key;
    expect(key, "一把都不该有").toBeUndefined();
    // 而这一把若真发了出去，它就是主人：拿它以 human 的名义写东西会成功。所以这里连带核一次反面。
    expect((await join("agent-dev", "dev")).status, "别的角色照常加得进来").toBe(201);
  });
});

/**
 * 判据 8：**我们不是「有一把管理钥匙放在某处」，是每个角色手上拿的就是管理钥匙。** pm 17:1x 量到：
 * 同一把 token 以 `x-actor: pm` 说话照样拿得到 `invite_url`（`record.role === null`）——于是 `:628` 那道
 * 专为节点钥匙写的闸对我们一个人也不生效。**只修默认，等于把门锁好而每个人兜里都揣着万能钥匙。**
 */
describe("t-234 判据 8 · 换成节点钥匙之后，以别人的身份说话当场被拦", () => {
  it("**管理钥匙此刻是万能的**：同一把钥匙说自己是 pm、是 dev、是 qa，都过——这就是那句话的样子", async () => {
    for (const who of ["pm", "dev", "qa"]) expect((await events(ADMIN, who, { kind: "note", body: `我是 ${who}` })).status).toBe(201);
    const b = await (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm" } })).json() as { invite_url?: string };
    expect(b.invite_url, "以 pm 说话也拿得到只给管理者的字段").toBeTruthy();
  });

  it("**换成绑定到 pm 的节点钥匙**：以 dev 说话被拦，拒绝话说得出这把钥匙是谁的", async () => {
    const r = await events(NODE, "dev", { kind: "note", body: "我说我是 dev" });
    expect(r.status).toBe(403);
    expect((await r.json() as { message: string }).message).toContain("这把钥匙是 pm 的");
    expect((await events(NODE, "pm", { kind: "note", body: "我是 pm，这才对" })).status).toBe(201);
  });

  it("节点钥匙也拿不到只给管理者的字段——换钥匙同时换掉的还有这个", async () => {
    const b = await (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${NODE}`, "x-actor": "pm" } })).json() as { invite_url?: string };
    expect(b.invite_url).toBeUndefined();
  });
});

/**
 * 判据 9：**造主人钥匙这件事，不该是任何节点做得了的。** `/owner-url` 原来只要管理钥匙，而每个角色手上
 * 拿的就是管理钥匙；它会「没有就造一把」并把带钥匙的地址交出来，**而第一个打开它的人就永久是主人**。
 * 所以此刻任何一个节点能拿走的不是「替他点一次卡」，是整个主人身份。
 */
describe("t-234 判据 9 · 发出主人地址，要一样任何节点手上都没有的东西", () => {
  const freshApp = async (secret?: string) => {
    const reg = new MemoryRegistry();
    const a = createApp({ store: new MemoryStore(), token: ADMIN, human: HUMAN, sha: "abc1234", registry: reg, alertIntervalMs: 0, ...(secret ? { ownerSecret: secret } : {}) });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    return { app: a, reg, at: `http://127.0.0.1:${(a.address() as AddressInfo).port}` };
  };
  const ask = (at: string, headers: Record<string, string>) => fetch(`${at}/owner-url`, { headers: { authorization: `Bearer ${ADMIN}`, ...headers } });

  it("**服务没配那段口令 ⇒ 这扇门是关的**，而且那把钥匙一把都没造出来（未配置就锁上）", async () => {
    const w = await freshApp();
    try {
      const r = await ask(w.at, {});
      expect(r.status).toBe(403);
      expect((await r.json() as { rule: string; message: string }).rule).toBe("owner-key");
      expect(await w.reg.ownerKeyRecord("ateam", HUMAN), "被拒的那一次不许顺手把钥匙造出来").toBeNull();
    } finally { await new Promise<void>((r) => w.app.close(() => r())); }
  });

  it("判据 12 ②：**「没配口令」与「你没权限」要分得开**——不是一个长得一样的 401", async () => {
    const locked = await freshApp();
    const noKey = await freshApp("ops-only");
    try {
      const a = await ask(locked.at, {});                                  // 服务没配口令
      const b = await ask(noKey.at, {});                                   // 配了，但请求没带
      const c = await fetch(`${noKey.at}/owner-url`);                      // 连管理钥匙都没有
      expect([a.status, b.status, c.status], "没权限是 401，两种「造不了」是 403").toEqual([403, 403, 401]);
      const [am, bm] = [(await a.json() as { message: string }).message, (await b.json() as { message: string }).message];
      expect(am, "「这扇门还没配钥匙」要说出去配什么").toContain("ATEAM_OWNER_SECRET");
      expect(am, "而且不能与「你该带口令而没带」是同一句").not.toBe(bm);
      expect(bm).toContain("x-owner-secret");
    } finally {
      await new Promise<void>((r) => locked.app.close(() => r()));
      await new Promise<void>((r) => noKey.app.close(() => r()));
    }
  });

  it("**只有管理钥匙不够**：不带口令、带错口令，都拒；钥匙仍然没造出来", async () => {
    const w = await freshApp("ops-only");
    try {
      expect((await ask(w.at, {})).status).toBe(403);
      expect((await ask(w.at, { "x-owner-secret": "guessed-wrong" })).status).toBe(403);
      expect(await w.reg.ownerKeyRecord("ateam", HUMAN)).toBeNull();
      // 带对了才给，而这时钥匙才第一次被登记
      const ok = await ask(w.at, { "x-owner-secret": "ops-only" });
      expect(ok.status).toBe(201);
      expect((await ok.json() as { board_url: string }).board_url).toContain("?k=");
      expect(await w.reg.ownerKeyRecord("ateam", HUMAN)).not.toBeNull();
    } finally { await new Promise<void>((r) => w.app.close(() => r())); }
  });
});

/**
 * 判据 4 的**第五扇门**，qa 18:26 在 `0dc69cc` 上量出来的：`POST /token` 拿到钥匙之后**紧接着把 `then` 那个
 * 动作真的执行了**，而那四个动作 append 时 `actor` 写死是 `human`。原来那道闸问的是「主人到过没有」——
 * 而 `owner_key = none` 时这个问法永远为假，于是**同一把管理钥匙在 `POST /say` 上被拒、在这一页上被放进来**，
 * 并以人的名义落下 `ack` 与决策。
 *
 * qa 核过：所有把钥匙粘进这一页的用例，用的都是主人自己那把、或另一个项目的管理钥匙（测项目隔离），
 * **没有一条是「本项目管理钥匙 ＋ `then=` ＋ `owner_key = none`」**——**这条路不是被测过之后放过的，是从来没被问过。**
 */
describe("t-234 判据 4 · token 小页面那第五扇门", () => {
  const post = (at: string, fields: Record<string, string>) =>
    fetch(`${at}/token`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const humanEvents = async (st: MemoryStore) => (await st.read()).events.filter((e) => e.actor === HUMAN).length;

  it("**管理钥匙经这一页点卡 ⇒ 403，日志里以人名义的事件一条不多**（这一格量出来时是 303 ＋ 两条）", async () => {
    const st = new MemoryStore();
    const reg = new MemoryRegistry();
    const a = createApp({ store: st, token: ADMIN, human: HUMAN, sha: "abc1234", registry: reg, alertIntervalMs: 0, ownerSecret: TEST_OWNER_SECRET });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
    try {
      await fetch(`${at}/events`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ kind: "reading", surface: "project", key: "roles", value: ["pm", "dev"] }) });
      const card = await (await fetch(`${at}/events`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm", "content-type": "application/json" }, body: JSON.stringify({ kind: "instruction", to: HUMAN, body: "要不要上线？", options: ["要", "先不要"], ack_by: soon() }) })).json() as Event;
      const board0 = await (await fetch(`${at}/board`, { headers: { authorization: `Bearer ${ADMIN}`, "x-actor": "pm" } })).json() as { owner_key: { state: string } };
      expect(board0.owner_key.state, "这就是生产此刻的形态：主人从来没到过").toBe("none");
      const before = await humanEvents(st);
      expect((await post(at, { token: ADMIN, then: "/decide", id: card.id, option: "要" })).status, "替他答卡").toBe(403);
      expect((await post(at, { token: ADMIN, then: "/say", text: "我是人，我用管理钥匙说了一句" })).status, "替他说一句").toBe(403);
      expect((await post(at, { token: ADMIN, then: "/ack", id: card.id })).status, "替他 ack").toBe(403);
      expect(await humanEvents(st), "以人的名义一条都没落").toBe(before);
      // 换钥匙进门本身不受影响：不带 then 的还是进得来（管理者看得见牌桌，只是按不动他的按钮）
      expect((await post(at, { token: ADMIN })).status).toBe(303);
    } finally { await new Promise<void>((r) => a.close(() => r())); }
  });
});
