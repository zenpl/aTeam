/**
 * t-161：页面判断人有没有说「先不做」时，读 core 的 DEFER_PREFIX，不用自己写死的那三个字。
 *
 * 这一处特别在于它**不是显示、是判定**。改错一个显示的字，人一眼看得见；改错一个判定的字，页面照样好好地渲染，
 * 只是把「先不做」认成了「知道了」——没有任何东西会喊。所以这里的用例一个中文字都不自己写：判据用的每一处
 * 「先不做」都从 core 取，措辞哪天改了，用例跟着改，而一个钉死字面量的实现会当场红。
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, DEFER_PREFIX } from "@ateam/core";
import { UI } from "../src/i18n.js";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";

function server() {
  const app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  let base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json() as { id: string };
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
  const page = async () => (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  return { post, page, start, stop: () => new Promise<void>((r) => app.close(() => r())) };
}

/** A card to the human, acked, plus whatever note body the test wants to hang off it. */
async function deferred(body: string | null) {
  const v = server();
  await v.start();
  const card = await v.post("pm", { kind: "instruction", to: HUMAN, body: "外呼地址填一个？细节在任务上。", ack_by: new Date(Date.now() + 900_000).toISOString() });
  await v.post(HUMAN, { kind: "ack", of: card.id });
  if (body !== null) await v.post(HUMAN, { kind: "note", body, refs: [card.id] });
  const html = await v.page();
  await v.stop();
  return html.slice(0, html.indexOf('<details class="rest"'));   // 第一屏，「你刚定了」那一行在这里
}

describe("t-161 · 「先不做」是 core 的字，不是页面的字", () => {
  it("follows core's prefix: the body is built from DEFER_PREFIX, never typed out here", async () => {
    // 判据 2 的做法：用例不写那三个字，只从 core 取。core 里那句改成别的，这一行跟着改而断言仍然成立；
    // 一个钉死字面量的实现在那一刻会认不出来，用例当场红。
    const first = await deferred(`${DEFER_PREFIX}这周先不碰外呼`);
    expect(first).toContain(UI.notNow);
    expect(first).not.toContain(UI.gotIt);
  });

  it("a note that is not a deferral does not become one", async () => {
    const first = await deferred("外呼那件我看了，先放着");   // 像那么回事，但不是那个前缀
    expect(first).toContain(UI.didIt);
    expect(first).not.toContain(UI.notNow);
  });

  it("acking with no note at all is not a deferral either", async () => {
    const first = await deferred(null);
    expect(first).toContain(UI.didIt);
    expect(first).not.toContain(UI.notNow);
  });
});
