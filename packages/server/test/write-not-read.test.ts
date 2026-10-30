/**
 * t-306 判据②：**写入不许依赖读取算得出来。**
 *
 * 判据给的证法就是这一份干的事：**注入一个必抛的 `board()`**，然后看人点按钮那条路还成不成。
 * 为什么这个注入才是对的：今天打不开的那一页同时就是收不了话的那一页——而「打不开」坏在算那一页上，
 * 不坏在存储上。所以注入要打在 `board()` 上，不是打在 `store.read()` 上（后者我在 receipt.test.ts 里另有一条，
 * 它证的是另一件：整日志那条路坏掉时写入照旧）。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";

/** 必抛的 `board()`，其余一切照原样。**只换这一个函数**，这样红起来只能是因为有人在写入路上叫了它。 */
vi.mock("@ateam/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ateam/core")>();
  return { ...real, board: () => { throw new Error("board() 坏了（注入）"); } };
});

const { MemoryStore, append } = await import("@ateam/core");
const { createApp } = await import("../src/app.js");
const { UI } = await import("../src/i18n.js");
const { ownerCookie, TEST_OWNER_SECRET } = await import("./owner.js");

const TOKEN = "secret-token";
const HUMAN = "human";
const HTML = "text/html,application/xhtml+xml";
const store = new MemoryStore();
let app: ReturnType<typeof createApp>;
let base = "";
let cookie = "";
let card = "";

beforeAll(async () => {
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  cookie = await ownerCookie(base, TOKEN);
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "qa"] }, { human: HUMAN });
  await append(store, { kind: "reading", actor: "pm", surface: "project", key: "alert.ask", value: true }, { human: HUMAN });
  card = (await append(store, { kind: "instruction", actor: "pm", to: HUMAN, body: "看一眼", ack_by: new Date(Date.now() + 3_600_000).toISOString() }, { human: HUMAN })).id;
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

const press = (path: string, fields: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: HTML, cookie }, body: new URLSearchParams(fields).toString() });

describe("t-306 判据② · `board()` 必抛时，人点按钮这条路照旧成立", () => {
  it("注入真的生效：牌桌本身答不出（不然这一份什么都没验）", async () => {
    const res = await fetch(`${base}/`, { headers: { accept: HTML, cookie } });
    expect(res.status, "牌桌要算 board()，所以它该坏").toBeGreaterThanOrEqual(500);
  });

  it("**`/say` 仍然成**：回执出得来，那句话进了日志，再读一次日志看得见它", async () => {
    const res = await press("/say", { text: "牌桌算不出来我也要说这一句" });
    expect(res.status, "写入不许等读取成功").toBe(200);
    expect(res.headers.get("location"), "更不许把人送回那个算不出来的页").toBeNull();
    expect(await res.text()).toContain(UI.receipt.what["/say"]);
    expect((await store.read()).events.some((e) => e.actor === HUMAN && e.body?.includes("牌桌算不出来我也要说这一句"))).toBe(true);
  });

  it("`/ack` 同样——它要查一条指令，而那是增量状态上的一次 map 查，不是一张牌桌", async () => {
    const res = await press("/ack", { id: card });
    expect(res.status).toBe(200);
    expect((await store.read()).events.some((e) => e.kind === "ack" && e.of === card)).toBe(true);
  });

  it("**`/fact` 同样，而它此前不是**：那一行曾是 `contactEnabled(board(…))`——人填一个地址要等整张牌桌", async () => {
    const res = await press("/fact", { key: "alert.webhook", value: "https://example.invalid/hook" });
    expect(res.status, "判据②的原话只点了 /say，这一处是同族，我核码时撞上的").toBe(200);
    expect(await res.text()).toContain(UI.receipt.what["/fact"]);
    expect((await store.read()).events.some((e) => e.kind === "reading" && e.key === "alert.webhook")).toBe(true);
  });
});
