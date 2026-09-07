/**
 * t-150：一道闸知道自己不可信时，它的每条结论都要带上实话（pd 06:37）——页面这一半。
 *
 * 那句话由 t-149 在 core 一处算出。这里做的只有三件事：逐字印它、印在挖层里、没有就什么都不印。
 * 三条都能被注入验证：`bin/inject` 去掉 core 那一处，这里的断言会红。
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, gateHonesty, reduce, type State } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";

function server() {
  const app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  let base = "", store!: MemoryStore;
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j as { id: string };
  };
  const page = async () => (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const state = async (): Promise<State> => reduce(await store.read());
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  return { post, page, state, start, setStore: (s: MemoryStore) => { store = s; }, stop: () => new Promise<void>((r) => app.close(() => r())) };
}

/** 一道被判过误报、而修法还没上生产的接缝闸——core 只在这种状态下才说那句话。 */
async function withKnownDefect() {
  const store = new MemoryStore();
  const app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j as { id: string };
  };
  await post("pm", { kind: "reading", surface: "project", key: "roles", value: ["pm", "dev", "qa", "frontend"] });
  // 两件碰同一处的任务 ⇒ 闸报出一条接缝
  for (const [id, who] of [["t-1", "dev"], ["t-2", "frontend"]] as const) {
    // t-151 的闸从 done 扩到 create：建任务也要说清对人有什么影响。夹具里这几件是接缝的两端，
    // 不是人能看到的改动，所以照实写 no_human_impact，而不是给它编一句 shows。
    await post("pm", { kind: "task", op: "create", task: id, title: `第 ${id} 件`, criteria: ["能用"], no_human_impact: true });
    await post(who, { kind: "task", op: "claim", task: id, touches: ["src/same.ts"] });
  }
  // 有人判它是误报，而修法那件还没在生产上验过 —— 两个条件齐了，core 才会说话
  await post("pm", { kind: "task", op: "seam", tasks: ["t-1", "t-2"], resolution: "这条是假的：两边改的不是同一段", verdict: "false" });
  await post("pm", { kind: "task", op: "create", task: "t-9", title: "修这道闸", criteria: ["不再假报"], shows: "牌桌挖层里那句实话不再多报一条假接缝" });
  await post("pm", { kind: "reading", surface: "project", key: "gate.seam.fix", value: "t-9", method: "pm 指定" });
  const html = await (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const line = gateHonesty(reduce(await store.read()), "seam")?.line;
  await new Promise<void>((r) => app.close(() => r()));
  return { html, line };
}

const digLayer = (html: string) => html.slice(html.indexOf('<details class="rest"'));
const firstScreen = (html: string) => html.slice(0, html.indexOf('<details class="rest"'));

describe("t-150 · 那句实话印在挖层里", () => {
  it("逐字印 core 算出的那一句，一个字不加", async () => {
    const { html, line } = await withKnownDefect();
    expect(line, "夹具没造出「已知缺陷」那个状态，下面的断言就没有意义").toBeTruthy();
    expect(html).toContain(line!);
  });

  it("在挖层里，不在首屏，也不在给人的卡上（判据 2）", async () => {
    const { html, line } = await withKnownDefect();
    expect(digLayer(html)).toContain(line!);
    expect(firstScreen(html)).not.toContain(line!);
    // 「需要你」那一段整个在首屏里，上面一条已经覆盖；这里再钉一次它没被做成卡
    expect(html).not.toContain(`<button`.concat(line!.slice(0, 8)));
  });

  it("没有已知缺陷时一个字都不印，也不印「暂无」（判据 3）", async () => {
    const v = server();
    const store = new MemoryStore();
    v.setStore(store);
    await v.start();
    try {
      await v.post("pm", { kind: "task", op: "create", task: "t-1", title: "一件普通的", criteria: ["能用"], no_human_impact: true });
      const html = await v.page();
      expect(html).not.toContain("gate-honesty");    // 那一段整个不存在
      expect(html).not.toContain("暂无");
    } finally { await v.stop(); }
  });
});
