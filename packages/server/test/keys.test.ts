/**
 * t-103 (T5/S9/M7). pd 23:52: `X-Actor` is no longer taken as a statement of identity — what you may say is decided by
 * the key you hold, not by a line you wrote in a header. The identity that cannot be borrowed is the person's:
 * impersonating them is impersonating the final say.
 *
 * The upgrade ships with the enforcement (pm 23:53, pd 23:53), because getting this wrong locks the project's owner out
 * of their own board and there is no way back in. So: until the owner has opened their address once, the admin key may
 * still speak for them; the first time they arrive, that door closes for good.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, SERVICE_ACTOR } from "@ateam/core";
import { createApp } from "../src/app.js";
import { MemoryRegistry } from "../src/projects.js";

const HUMAN = "human";

function world() {
  const registry = new MemoryRegistry();
  const app = createApp({ store: new MemoryStore(), token: "ak_shared", human: HUMAN, sha: "abc1234", registry });
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

  it("the upgrade: before the owner has arrived the shared key may still speak for them, and the board says so", async () => {
    expect(await board("ak_shared")).toMatchObject({ owner_key: { state: "none" } });   // 没人拿到过地址
    expect((await post("ak_shared", HUMAN, note("升级前，人还进不来，共享钥匙代签"))).status).toBe(201);
    // 一个持管理钥匙的节点把地址要出来发给人：状态变成「已发未用」
    const issued = await (await fetch(`${base}/owner-url`, { headers: { authorization: "Bearer ak_shared" } })).json() as { board_url: string; say: string; state: string };
    expect(issued.state).toBe("issued");
    expect(issued.say).toContain("牌桌在这里：");
    expect(await board("ak_shared")).toMatchObject({ owner_key: { state: "issued" } });
    expect((await post("ak_shared", HUMAN, note("还没打开过，仍然代签得了"))).status).toBe(201);
    // 要第二次也是同一个地址：钥匙是算出来的，不是存下来的
    const again = await (await fetch(`${base}/owner-url`, { headers: { authorization: "Bearer ak_shared" } })).json() as { board_url: string };
    expect(again.board_url).toBe(issued.board_url);
    // 人打开了自己的地址：升级完成
    const opened = await fetch(issued.board_url, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(opened.status).toBe(303);
    expect(await board("ak_shared")).toMatchObject({ owner_key: { state: "in_use" } });
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

  it("re-issuing the address needs the admin key: a node key cannot ask for it", async () => {
    const { key: nodeKey } = await w.registry.nodeKey("ateam", "agent-4", "frontend");
    expect((await fetch(`${base}/owner-url`, { headers: { authorization: `Bearer ${nodeKey}` } })).status).toBe(401);
  });
});
