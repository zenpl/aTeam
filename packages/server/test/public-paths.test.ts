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
import { MemoryStore, append, type Log } from "@ateam/core";
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
