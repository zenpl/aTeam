/**
 * t-103 (T5/S9/M7). pd 23:52: `X-Actor` is no longer taken as a statement of identity — what you may say is decided by
 * the key you hold, not by a line you wrote in a header. The identity that cannot be borrowed is the person's:
 * impersonating them is impersonating the final say.
 *
 * t-234（P0）改掉了这里的一半：**当初那个「主人还没到过时管理钥匙可以代他说话」的升级窗口，从来没有关过。**
 * 本项目五天 `owner_key.state` 一直是 `none`，于是这道闸一次都没开始工作——qa 17:05 拿环境里那把 token 把
 * `x-actor` 换成 `human`，`GET /board` 回 200 并带着只给管理者的 `invite_url`。**「有一道闸」不等于「这道闸
 * 此刻是合上的」。** 现在是未配置就锁上：不看主人到过没有，一律只认他自己那把钥匙。
 *
 * 当初怕的「一步打开会把主人锁在自己的牌桌外」有一条现成的出路，而且 pd 00:28 定稿的那句拒绝话里就写着它：
 * `GET /owner-url`（持管理钥匙即可）把主人的地址原样再发一次——钥匙是算出来的，所以是同一个地址。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SERVICE_ACTOR } from "@ateam/core";
import { createApp } from "../src/app.js";
import { TEST_OWNER_SECRET } from "./owner.js";
import { MemoryRegistry } from "../src/projects.js";

const HUMAN = "human";

function world() {
  const registry = new MemoryRegistry();
  const app = createApp({ ownerSecret: TEST_OWNER_SECRET, store: new MemoryStore(), token: "ak_shared", human: HUMAN, sha: "abc1234", registry });
  const ready = new Promise<string>((r) => app.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)));
  return { registry, app, ready };
}

describe("t-103 · what you may say is decided by the key you hold", () => {
  let w: ReturnType<typeof world>, base = "";
  const post = async (key: string, actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${key}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { rule?: string; message?: string } };
  };
  const board = async (key: string) => (await (await fetch(`${base}/board`, { headers: { authorization: `Bearer ${key}`, "x-actor": "pm" } })).json()) as { owner_key: { state: string; since?: string } };
  const note = (body: string) => ({ kind: "note", body });

  const OWNER_ONLY = `你拿的是项目共享钥匙，它不能代 ${HUMAN} 说话——${HUMAN} 这个身份只有他自己那把钥匙能用。要人拍板就发一张卡等他点；牌桌地址丢了，持管理钥匙的节点可以再发一个。`;
  /** A project of its own, so one test's upgrade does not decide another's. */
  const fresh = async (name: string) => {
    const created = await (await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json() as { project: string; board_url: string; admin_key: string };
    const ownerKey = new URL(created.board_url).searchParams.get("k")!;
    return { base: `${base}/p/${created.project}`, adminKey: created.admin_key, ownerKey, ownerUrl: created.board_url, cookie: `ateam_token_${created.project}` };
  };

  beforeAll(async () => { w = world(); base = await w.ready; });
  afterAll(() => new Promise<void>((r) => w.app.close(() => r())));

  it("a node key speaks only as its own role; the admin key speaks as any role", async () => {
    const { key: nodeKey } = await w.registry.nodeKey("ateam", "agent-1", "dev");
    expect((await post(nodeKey, "dev", note("我做的"))).status).toBe(201);
    const wrong = await post(nodeKey, "qa", note("我不是 qa"));
    expect(wrong.status).toBe(403);
    expect(wrong.body.message).toContain("这把钥匙是 dev 的，不能以 qa 说话");
    expect((await post("ak_shared", "pm", note("共享钥匙照常以角色说话"))).status).toBe(201);
    expect((await post("ak_shared", "qa", note("也可以是别的角色"))).status).toBe(201);
  });

  it("nobody borrows the service's own identity, whatever key they hold", async () => {
    const svc = await post("ak_shared", SERVICE_ACTOR, note("我是服务"));
    expect(svc.status).toBe(403);
    expect(svc.body.message).toContain(`${SERVICE_ACTOR} 是服务自己的身份`);
    const { key: nodeKey } = await w.registry.nodeKey("ateam", "agent-2", "qa");
    expect((await post(nodeKey, SERVICE_ACTOR, note("我也是"))).status).toBe(403);
  });

  it("t-234：**主人还没到过时，共享钥匙也不能代他说话**——未配置就锁上，不是未配置就放行", async () => {
    expect(await board("ak_shared")).toMatchObject({ owner_key: { state: "none" } });   // 没人拿到过地址
    // 这一行在 t-234 之前是 201。那正是 qa 17:05 量到的洞：这道闸要等主人到过才开始工作，而他从没到过。
    const early = await post("ak_shared", HUMAN, note("主人还没来，我替他说一句"));
    expect(early.status, "未配置就锁上").toBe(403);
    expect(early.body.rule).toBe("owner-key");
    expect(early.body.message).toBe(OWNER_ONLY);
    // 判据 3：读这一侧同样收紧——只给管理者的 invite_url 不会顺着「我说我是 human」这条路出去
    const asHuman = await fetch(`${base}/board`, { headers: { authorization: "Bearer ak_shared", "x-actor": HUMAN } });
    expect(asHuman.status, "qa 17:05 量到的就是这一个 200").toBe(403);
    expect(JSON.stringify(await asHuman.json())).not.toContain("invite_url");
    // 而人进不来这件事有出路，就在那句拒绝话里：持管理钥匙的节点把地址要出来发给他
    const issued = await (await fetch(`${base}/owner-url`, { headers: { authorization: "Bearer ak_shared", "x-owner-secret": TEST_OWNER_SECRET } })).json() as { board_url: string; say: string; state: string };
    expect(issued.state).toBe("issued");
    expect(issued.say).toContain("牌桌在这里：");
    expect(await board("ak_shared")).toMatchObject({ owner_key: { state: "issued" } });
    expect((await post("ak_shared", HUMAN, note("发出去了也还是不能代签"))).status, "「已发未用」也不放行").toBe(403);
    // 要第二次也是同一个地址：钥匙是算出来的，不是存下来的
    const again = await (await fetch(`${base}/owner-url`, { headers: { authorization: "Bearer ak_shared", "x-owner-secret": TEST_OWNER_SECRET } })).json() as { board_url: string };
    expect(again.board_url).toBe(issued.board_url);
    // 人打开了自己的地址
    const opened = await fetch(issued.board_url, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(opened.status).toBe(303);
    expect(await board("ak_shared")).toMatchObject({ owner_key: { state: "in_use" } });
  });

  it("t-234 判据 4 的第四处：**管理钥匙打开牌桌，不算「他看过了」**", async () => {
    const p = await fresh("已读项目");
    const readUpto = async () => ((await (await fetch(`${p.base}/board?full=1`, { headers: { authorization: `Bearer ${p.adminKey}`, "x-actor": "pm" } })).json() as { presence: { actor: string; last_pull: string | null }[] }).presence.find((x) => x.actor === HUMAN)?.last_pull) ?? null;
    await fetch(`${p.base}/?token=${encodeURIComponent(p.adminKey)}`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(await readUpto(), "管理钥匙看一眼，不替他标已读").toBeNull();
    await fetch(p.ownerUrl, { headers: { accept: "text/html" }, redirect: "manual" });
    await fetch(`${p.base}/`, { headers: { accept: "text/html", cookie: `${p.cookie}=${encodeURIComponent(p.ownerKey)}` } });
    expect(await readUpto(), "他自己打开，才算他看过").not.toBeNull();
  });

  it("once the owner has arrived, no other key speaks as them — and the refusal is pd 00:29 的定稿", async () => {
    const denied = await post("ak_shared", HUMAN, note("升级后还想代签"));
    expect(denied.status).toBe(403);
    expect(denied.body.rule).toBe("owner-key");
    expect(denied.body.message).toBe(`你拿的是项目共享钥匙，它不能代 ${HUMAN} 说话——${HUMAN} 这个身份只有他自己那把钥匙能用。要人拍板就发一张卡等他点；牌桌地址丢了，持管理钥匙的节点可以再发一个。`);
    const { key: nodeKey } = await w.registry.nodeKey("ateam", "agent-3", "pm");
    expect((await post(nodeKey, HUMAN, note("节点更不行"))).status).toBe(403);
    // 而人自己那把钥匙照常
    const { key: ownerKey } = await w.registry.ownerKey("ateam", HUMAN);
    expect((await post(ownerKey, HUMAN, note("我自己说的"))).status).toBe(201);
    expect((await post(ownerKey, "pm", note("人也不能反过来冒充角色"))).status).toBe(403);
    // 角色照常说话，一点没变（判据 2：不许退化）
    expect((await post("ak_shared", "dev", note("角色照常"))).status).toBe(201);
  });

  it("a fresh project hands the owner their own address in the sentence the first agent relays", async () => {
    const created = await (await fetch(`${base}/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "新项目" }) })).json() as { project: string; board_url: string; admin_key: string };
    expect(created.board_url).toContain("?k=nk_");
    // 那个地址就是人的钥匙：他一打开，这个项目立刻是「已升级」的，共享钥匙从没代签过
    const p = `${base}/p/${created.project}`;
    const before = await (await fetch(`${p}/board`, { headers: { authorization: `Bearer ${created.admin_key}`, "x-actor": "pm" } })).json() as { owner_key: { state: string } };
    expect(before.owner_key.state).toBe("issued");
    await fetch(created.board_url, { headers: { accept: "text/html" }, redirect: "manual" });
    const after = await (await fetch(`${p}/board`, { headers: { authorization: `Bearer ${created.admin_key}`, "x-actor": "pm" } })).json() as { owner_key: { state: string } };
    expect(after.owner_key.state).toBe("in_use");
    const denied = await fetch(`${p}/events`, { method: "POST", headers: { authorization: `Bearer ${created.admin_key}`, "x-actor": HUMAN, "content-type": "application/json" }, body: JSON.stringify(note("代签")) });
    expect(denied.status).toBe(403);
  });

  it("pd 23:53 的兜底：切换前后各留一条事实，写清此刻怎么进得来", async () => {
    const log = await (await fetch(`${base}/log`, { headers: { authorization: "Bearer ak_shared", "x-actor": "pm" } })).json() as { events: { kind: string; key?: string; value?: Record<string, unknown>; method?: string }[] };
    const facts = log.events.filter((e) => e.kind === "reading" && e.key === "entry.form");
    expect(facts.map((f) => f.value!.state)).toEqual(["issued", "in_use"]);   // 发出那一刻、人第一次打开那一刻
    for (const f of facts) {
      expect(f.value!.board_url).toContain("/?k=<主人钥匙>");                 // 地址的形态，不是钥匙本身
      expect(String(f.value!.board_url)).not.toContain("nk_");                // 事实里不留钥匙
      expect(f.value!.reissue).toContain("/owner-url（要管理钥匙）");
      expect(f.value!.cookie_max_age_s).toBe(2592000);
      expect(f.method).toBeTruthy();
    }
  });

  /**
   * qa 01:05 找到的那一半：牌桌上的按钮也是以 human 的身份写事件，所以它们归同一条规则管。原先它们只认管理钥匙，
   * 于是人打得开自己的牌桌却按不动任何按钮，而每一个持共享钥匙的节点都能替他点——方向正好是反的。
   */
  it("the board's buttons obey the same rule as the API: the owner presses their own, the shared key cannot press for them", async () => {
    const p = await fresh("按钮项目");
    const press = (key: string, action: string, body: Record<string, string>) =>
      // 照浏览器真正发的样子：带 cookie、表单编码、accept: text/html，成功后 303 回牌桌
      fetch(`${p.base}${action}`, { method: "POST", headers: { cookie: `${p.cookie}=${encodeURIComponent(key)}`, "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: new URLSearchParams(body), redirect: "manual" });
    // t-234：**人还没来过的时候，管理钥匙也按不动**——这一行在 t-234 之前是 303
    expect((await press(p.adminKey, "/say", { text: "人还没来，我替他说" })).status, "未配置就锁上").toBe(403);
    // 人打开自己的地址
    await fetch(p.ownerUrl, { headers: { accept: "text/html" }, redirect: "manual" });
    // 现在：主人自己的钥匙按得动
    expect((await press(p.ownerKey, "/say", { text: "我自己说的" })).status).toBe(303);
    // 而共享钥匙按不动，拒绝话与 /events 那条一模一样
    const denied = await press(p.adminKey, "/say", { text: "替他说" });
    expect(denied.status).toBe(403);
    expect((await denied.json() as { rule: string; message: string })).toEqual({ error: "forbidden", rule: "owner-key", message: OWNER_ONLY });
    const decide = await press(p.adminKey, "/decide", { id: "01X", option: "要" });
    expect(decide.status).toBe(403);
    for (const action of ["/ack", "/fact"]) expect((await press(p.adminKey, action, { id: "01X" })).status, action).toBe(403);
    // 落库的那一句确实是人自己说的，不是谁代签的
    const log = await (await fetch(`${p.base}/log`, { headers: { authorization: `Bearer ${p.adminKey}`, "x-actor": "pm" } })).json() as { events: { kind: string; actor: string; body?: string }[] };
    const said = log.events.filter((e) => e.kind === "note" && e.body?.includes("我自己说的"));
    expect(said).toHaveLength(1);
    expect(said[0].actor).toBe(HUMAN);
  });

  it("qa 01:08 ④：没带钥匙点按钮不是死路，是问一句地址再把这件事做掉", async () => {
    const p = await fresh("按钮永远可点");
    const r = await fetch(`${p.base}/say`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" }, body: new URLSearchParams({ text: "cookie 过期了还想说" }), redirect: "manual" });
    const page = await r.text();
    expect(page).toContain("<form");
    expect(page).toContain('name="then" value="/say"');              // 把他按的那件事带着
    expect(page).toContain('name="text" value="cookie 过期了还想说"'); // 连正文一起带着，不用重打
    expect(page).not.toContain(p.ownerKey);                          // 页面从不回显钥匙（pd 01:02）
    // 把地址里那段粘进来，刚才按的那一下就落下去了
    const done = await fetch(`${p.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: p.ownerKey, then: "/say", text: "cookie 过期了还想说" }), redirect: "manual" });
    expect(done.status).toBe(303);
    const log = await (await fetch(`${p.base}/log`, { headers: { authorization: `Bearer ${p.adminKey}`, "x-actor": "pm" } })).json() as { events: { kind: string; actor: string; body?: string }[] };
    expect(log.events.filter((e) => e.kind === "note" && e.body?.includes("cookie 过期了还想说"))).toMatchObject([{ actor: HUMAN }]);
  });

  it("the token page takes the owner's key too, and stops taking the shared one once they have arrived", async () => {
    const p = await fresh("小页面项目");
    await fetch(p.ownerUrl, { headers: { accept: "text/html" }, redirect: "manual" });
    const enter = (key: string) => fetch(`${p.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: key }), redirect: "manual" });
    expect((await enter(p.ownerKey)).status).toBe(303);       // 人把整条地址里的那段粘进来，进得去
    expect((await enter(p.adminKey)).status).toBe(403);       // 共享钥匙不再是「人」的入口
  });

  it("qa 01:12：照 pd 的提示粘整条地址也进得去，不只是粘 k= 后面那一段", async () => {
    const p = await fresh("粘地址项目");
    const enter = (pasted: string) => fetch(`${p.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: pasted }), redirect: "manual" });
    const url = new URL(p.ownerUrl);
    const reordered = `${url.origin}${url.pathname}?ask=1&k=${p.ownerKey}`;   // 参数换了顺序，还多带一个
    for (const pasted of [
      p.ownerUrl,                        // 整条地址，人手上真正有的那样东西
      `  ${p.ownerUrl}  `,               // 复制时带上的空白
      `${p.ownerUrl}#hash`,              // 有的客户端会补一个锚点
      `${p.ownerUrl}/`,                  // 末尾多一个斜杠
      `${p.ownerUrl}。`,                 // 从一句话里连标点一起复制
      reordered,                         // query 参数顺序不同
      p.ownerKey,                        // 只粘 k= 后面那一段
      ` ${p.ownerKey}\n`,
      `${p.ownerKey}/`,
    ]) expect((await enter(pasted)).status, JSON.stringify(pasted)).toBe(303);
    expect((await enter("这不是钥匙")).status).toBe(401);              // 乱粘仍然被挡，并且是「token 不对」那一页
    expect((await enter(`${url.origin}${url.pathname}`)).status).toBe(401);   // 一条不带钥匙的地址：也认不出
    // 判据 3（pd 01:17 定稿）：认不出时说清该粘什么形态，给一个假值例子；判据 4：不回显钥匙
    const wrong = await (await enter(`${p.ownerUrl}zzz`)).text();
    expect(wrong).not.toContain(p.ownerKey);
    // pd 01:23：这一条是「地址对、k= 也在、钥匙不对」，所以说的是那个形状，不是通用的那句
    expect(wrong).toContain("像一条地址，k= 那一段也在，但这张牌桌不认那把钥匙。");
    expect(wrong).not.toContain("token 不对");                       // 不用他手上没有的那个词
    expect(wrong).not.toContain("再试一次");                          // 不告诉他重来，告诉他形态
    expect(wrong).toContain("<code>https://ateam.fly.dev/p/demo/?k=xxxxxxxx</code>");   // 假值、代码体
    expect(wrong).not.toMatch(/<a[^>]*ateam\.fly\.dev\/p\/demo/);   // 例子不做成链接：点不到
    // pd 01:23 裁定：碰到秘密的那条赢——不回显任何原文；要让人知道错在哪，就说形状不说内容
    expect(wrong).toMatch(/<input type="password" name="token"/);
    expect(wrong).not.toContain("value=\"http");
  });

  it("pd 01:23：认不出时说形状不说内容，形状描述里不出现原文的任何片段", async () => {
    const p = await fresh("说形状项目");
    const url = new URL(p.ownerUrl);
    const enter = async (pasted: string) => (await fetch(`${p.base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: pasted }), redirect: "manual" })).text();
    // 一条地址，但没有 k=
    expect(await enter(`${url.origin}${url.pathname}`)).toContain("像一条地址，但没找到 k= 那一段。");
    // 一条地址，k= 也在，但钥匙不对
    expect(await enter(`${url.origin}${url.pathname}?k=nk_${"x".repeat(32)}`)).toContain("像一条地址，k= 那一段也在，但这张牌桌不认那把钥匙。");
    // 一段钥匙，长度不对
    expect(await enter("nk_tooshort")).toContain("像一段钥匙，但长度对不上。");
    // 一段钥匙，长度也对，但不认
    expect(await enter(`nk_${"y".repeat(32)}`)).toContain("像一段钥匙，长度也对，但这张牌桌不认它。");
    // 一整段字，里面根本没有 k=
    expect(await enter("他发给我的那条消息里好像没有钥匙这种东西我把整段都粘过来了")).toContain("这一整段里没有 k=。");
    // 说不出形状时退回 01:17 那句加例子
    const short = await enter("abc");
    expect(short).toContain("这不像一条牌桌地址。把 agent 给你的那条整个粘进来就行，末尾带 k= 的那种。");
    // 三条约束：例子始终在；原文的任何片段都不出现；输入框清空
    for (const [pasted, page] of [["abc", short], ["nk_tooshort", await enter("nk_tooshort")]] as const) {
      expect(page).toContain("<code>https://ateam.fly.dev/p/demo/?k=xxxxxxxx</code>");
      expect(page).not.toContain(pasted.slice(0, 6));
      expect(page).toMatch(/<input type="password" name="token"/);
      expect(page).not.toMatch(/name="token"[^>]*value=/);
    }
    // 而含着真钥匙的那种粘贴，页面里一个字都不出现
    expect(await enter(`${p.ownerUrl}zzz`)).not.toContain(p.ownerKey.slice(4, 20));
  });

  it("re-issuing the address needs the admin key: a node key cannot ask for it", async () => {
    const { key: nodeKey } = await w.registry.nodeKey("ateam", "agent-4", "frontend");
    expect((await fetch(`${base}/owner-url`, { headers: { authorization: `Bearer ${nodeKey}` } })).status).toBe(401);
  });
});

