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
    expect(page, "第一行只放结果，并给出那个许可（pd 17:02 定稿）").toContain(UI.receipt.landed);
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
    reads = 0;
    override async read(): Promise<Log> {
      this.reads++;
      if (this.broken) throw new Error("读取那一侧坏了（注入）");
      return super.read();
    }
  }
  const store = new ReadBroken();
  let r: Awaited<ReturnType<typeof rig>>;
  beforeAll(async () => { r = await rig(store); });
  afterAll(() => r.close());

  /**
   * **这一格换了形状，而换它的是 t-307，不是这件事的判决松了。** 原来它拿 `GET /release` 当对照：那一页走
   * `reduce(await store.read())`，所以把 `read()` 打坏它必 500，用来证明「注入是真的」。t-307 判据④ 把
   * `/release` 从全量重放改成了同一个增量缓存（`stateFor`），**于是人碰得到的路里再没有一条叫 `read()`**，
   * 这个对照格就失去了它的对照对象。
   *
   * **t-306 判据② 本身没有变松，而证它的那一跑不在这个文件里**：qa 17:50 的判决是把 `board()` 改成必抛
   * 量出来的——同一跑里牌桌 500、`/say` 仍 200 ＋ 回执 ＋ 那句话进了日志。这个文件里的 `read()` 注入，
   * 从一开始就只是那件事的一个代理。
   *
   * 所以这一格改成一个**正面**的量，而它比原来那个代理更接近判据本身要说的话：
   * **把全量重放整个打坏之后，人碰到的三条路一条都没少**（牌桌、线上那一页、说一句），
   * 而「注入是真的」由 `read()` 一次都没被叫过来证（它若被叫过，这三条就都是 500 了）。
   */
  it("把 `read()` 整个打坏：牌桌、`/release`、`/say` 三条路一条都不受影响——人碰到的路里再没有全量重放（t-307 判据④）", async () => {
    store.broken = true;
    const before = store.reads;
    for (const path of ["/", "/release"]) {
      const res = await fetch(`${r.base}${path}`, { headers: { accept: HTML, cookie: r.cookie } });
      expect(res.status, `${path} 不该再依赖全量重放`).toBe(200);
    }
    const said = await press(r.base, r.cookie, "/say", { text: "读取那一侧坏着我也要说这一句" });
    expect(said.status).toBe(200);
    expect(await said.text()).toContain(UI.receipt.landed);
    // 注入是真的：它一次都没被叫过。若被叫过，上面三条全是 500——这就是这一格的对照。
    expect(store.reads, "人碰到的路里一次 read() 都不许有").toBe(before);
    /**
     * **下面四行是 dev 合并时加的（t-308 的接缝义务），不是 frontend 写的**——我 18:14 把缺口报给它、
     * 说「若它没补，我合的时候补上并在证据里写明是我加的」，此刻就是那一刻。
     *
     * 缺口：上面那一格靠「reads 没有增加」来对照，而这只在那个 override 真的还覆盖着基类方法时才说明
     * 问题。我量过两件：packages/server/tsconfig.json 只 include ["src"]，**用例文件从不被类型检查**
     * （vitest 用 esbuild 抹类型、不检查）；而把 MemoryStore.read 改名会让 core 自己编译红 6 处——
     * **所以这一次挡住它的不是这一格，是 core 里别处在调 read()**。换一个 core 能容忍的改动，这一格会
     * 一次都不叫 read()、计数恒为 0、测试全绿，而它什么也没守。
     *
     * 所以按 pm 18:20 立的第三层：**对照格要自证活着。** 下面三行把它从「它没被叫过」升成
     * 「它没被叫过，**而且我证明了我叫得动它**」。
     */
    store.broken = false;
    const live = store.reads;
    await store.read();
    expect(store.reads, "计数器与 override 都得是活的，否则上面那一格空着也能过").toBe(live + 1);
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
