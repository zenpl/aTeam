/**
 * t-306：**人点完按钮不再掉进那个打不开的页；而且写入不许等读取成功。**
 *
 * 现场：四个按钮（`/ack` `/say` `/decide` `/fact`）成功之后，服务端 303 跳回牌桌——而牌桌正是今天打不开的
 * 那一页（我 16:10 量到的那条形状：每个在飞的整日志 GET 在 256MB 机器上押约 30MB 几分钟）。**写入在 303
 * 之前早就落了，而人的浏览器挂在跳转上，于是他看到的是失败。**
 *
 * 判据 1 要求①②一起成立，所以这一份两件一起钉：①成功之后给一页回执、代价与日志长度无关；
 * ②把读取那一侧整个打断，写入仍然成立、人仍然拿到回执。
 *
 * **第二扇门是我核码时撞上的，判据里没点到**：`/token` 那一页拿到钥匙之后会紧接着执行 `then`，执行完也 303
 * 跳回牌桌。只有「换钥匙进门而没有要办的事」那一路该回牌桌。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, type Log } from "@ateam/core";
import { createApp } from "../src/app.js";
import { UI } from "../src/i18n.js";
import { ownerKey, ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
const HTML = "text/html,application/xhtml+xml";

/** 一个真服务 ＋ 它的主人 cookie。每个 describe 起自己那一台，免得日志互相串。 */
async function rig(store: MemoryStore) {
  const app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const cookie = await ownerCookie(base, TOKEN);
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "qa"] }, { human: HUMAN });
  return { app, base, cookie, close: () => new Promise<void>((r) => app.close(() => r())) };
}
const press = (base: string, cookie: string, path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: HTML, cookie }, body: new URLSearchParams(fields).toString() });

describe("t-306 判据① · 四个按钮成功之后都给回执，没有一个跳回牌桌", () => {
  let r: Awaited<ReturnType<typeof rig>>;
  const store = new MemoryStore();
  let card = "", chooser = "";
  beforeAll(async () => {
    r = await rig(store);
    card = (await append(store, { kind: "instruction", actor: "pm", to: HUMAN, body: "看一眼", ack_by: soon() }, { human: HUMAN })).id;
    chooser = (await append(store, { kind: "instruction", actor: "pm", to: HUMAN, body: "选一个", options: ["A", "B"], ack_by: soon() }, { human: HUMAN })).id;
    // `/fact` 这个按钮是被一条事实开关着的（pm 22:39）：没开就没有入口，也就没有路由。先把它开上，
    // 不然那一格量到的是 404，而 404 说的是「这个项目没开这个功能」，不是「回执坏了」。
    await append(store, { kind: "reading", actor: "pm", surface: "project", key: "alert.ask", value: true }, { human: HUMAN });
  });
  afterAll(() => r.close());

  it("`/say`：200 ＋ 回执，不是 303；而那句话真进了日志", async () => {
    const res = await press(r.base, r.cookie, "/say", { text: "开工了" });
    expect(res.status, "不许再是 303").toBe(200);
    expect(res.headers.get("location"), "一个 location 都不许有").toBeNull();
    const page = await res.text();
    expect(page).toContain(UI.receipt.landed);
    expect(page).toContain(UI.receipt.what["/say"]);
    expect(page, "回牌桌是可选的，所以它是一个链接，而且它不在那句话的结尾").toContain(`href="/"`);
    expect(page, "那句话自己说完（pd 06:42：全部用意是「你不用做任何事」的句子，不许以要人做一件事结尾）").toContain(UI.receipt.nothingToDo);
    expect((await store.read()).events.some((e) => e.actor === HUMAN && e.body?.includes("开工了")), "写入真落了").toBe(true);
  });

  it("另外三个按钮同样：200 ＋ 各自那一句，没有 location", async () => {
    for (const [path, fields] of [
      ["/ack", { id: card }],
      ["/decide", { id: chooser, option: "A" }],
      ["/fact", { key: "alert.webhook", value: "https://example.invalid/hook" }],
    ] as [string, Record<string, string>][]) {
      const res = await press(r.base, r.cookie, path, fields);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      const page = await res.text();
      expect(page, path).toContain(UI.receipt.landed);
      expect(page, path).toContain(UI.receipt.what[path]);
    }
  });

  it("**回执的代价与日志长度无关**（判据①后半句）：日志长 400 条之后，同一个动作的回执逐字节一样长", async () => {
    const first = await (await press(r.base, r.cookie, "/say", { text: "一" })).text();
    for (let i = 0; i < 400; i++) await append(store, { kind: "note", actor: "pm", body: `第 ${i} 条 ${"字".repeat(80)}` }, { human: HUMAN });
    const later = await (await press(r.base, r.cookie, "/say", { text: "一" })).text();
    // 事件 id 是定长的 ULID，所以同一个动作的回执长度是一个常数——**它不含任何按日志算出来的东西**
    expect(Buffer.byteLength(later, "utf8"), `短日志 ${Buffer.byteLength(first, "utf8")} ／ 长日志 ${Buffer.byteLength(later, "utf8")}`).toBe(Buffer.byteLength(first, "utf8"));
    expect(later, "也不许顺手印出那 400 条里的任何一条").not.toContain("第 399 条");
  });
});

describe("t-306 判据② · 读取那一侧整个坏掉，人说的话照旧落下去、照旧拿到回执", () => {
  /** 读取那一侧必抛：`read()` 是牌桌与整日志那条路用的；写入走 `readSince`，两条分得开。 */
  class ReadBroken extends MemoryStore {
    broken = false;
    override async read(): Promise<Log> {
      if (this.broken) throw new Error("读取那一侧坏了（注入）");
      return super.read();
    }
  }
  const store = new ReadBroken();
  let r: Awaited<ReturnType<typeof rig>>;
  beforeAll(async () => { r = await rig(store); });
  afterAll(() => r.close());

  it("注入真的生效：坏掉之后 `GET /release` 这条全量重放的路确实答不出", async () => {
    store.broken = true;
    const res = await fetch(`${r.base}/release`, { headers: { accept: HTML, cookie: r.cookie } });
    expect(res.status, "它走的是 reduce(await store.read())，所以它该坏").toBeGreaterThanOrEqual(500);
  });

  it("**而 `/say` 仍然成**：回执出得来，那句话进了日志，再读一次日志看得见它", async () => {
    store.broken = true;
    const res = await press(r.base, r.cookie, "/say", { text: "读取坏了我也要说这一句" });
    expect(res.status, "写入不许等读取成功").toBe(200);
    expect(await res.text()).toContain(UI.receipt.landed);
    store.broken = false;   // 只有「再读一次日志」这一步需要读取是好的
    expect((await store.read()).events.some((e) => e.body?.includes("读取坏了我也要说这一句")), "它真的在日志里").toBe(true);
  });
});

describe("t-306 · 第二扇门：`/token` 办完事也不许跳回牌桌（判据里没点到，我核码时撞上的）", () => {
  const store = new MemoryStore();
  let r: Awaited<ReturnType<typeof rig>>;
  let k = "";
  beforeAll(async () => { r = await rig(store); k = await ownerKey(r.base, TOKEN); });
  afterAll(() => r.close());

  const token = (fields: Record<string, string>) =>
    fetch(`${r.base}/token`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: HTML }, body: new URLSearchParams({ token: k, ...fields }).toString() });

  it("带着要办的事（`then=/say`）：200 ＋ 回执 ＋ 照旧发 cookie，而不是 303", async () => {
    const res = await token({ then: "/say", text: "从钥匙那一页说的" });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie"), "钥匙照旧要存下来").toContain("=");
    expect(await res.text()).toContain(UI.receipt.what["/say"]);
    expect((await store.read()).events.some((e) => e.body?.includes("从钥匙那一页说的"))).toBe(true);
  });

  it("**没有要办的事**：照旧 303 回牌桌——那时人要的就是那一页", async () => {
    const res = await token({});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
  });
});
