/**
 * t-118 (pd 01:19): a card's sentence had three sources — the question constant the service writes into the log, a
 * second copy in i18n that the page actually rendered, and the button labels. pd changed the wording three times
 * tonight before all three agreed. Now there is one: the instruction's own body. Change it once and it is changed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { MemoryStore, CONTACT_ASK, CONTACT_OPTIONS, splitTitle } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";

function world() {
  const store = new MemoryStore();
  const app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  const ready = new Promise<string>((r) => app.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(app.address() as AddressInfo).port}`)));
  return { store, app, ready };
}

describe("t-118 · the words on a card come from the card", () => {
  let w: ReturnType<typeof world>, base = "";
  const post = (actor: string, body: unknown) =>
    fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
  const page = async () => (await fetch(`${base}/`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/html" } })).text();
  const soon = () => new Date(Date.now() + 3600_000).toISOString();

  beforeAll(async () => { w = world(); base = await w.ready; });
  afterAll(() => new Promise<void>((r) => w.app.close(() => r())));

  it("判据 4：i18n 里不再存问句——这条断言会红，我把一份问句放回去试过", () => {
    const i18n = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const strings = [...i18n.matchAll(/"([^"\\]*)"/g)].map((m) => m[1]);
    for (const v of strings) {
      // a question the human is asked ends in ？ and is a sentence, not a heading like 「你不在时怎么找你」 in a label
      expect(/[？?]/.test(v) && [...v].length > 6, `i18n 里存了一句问句：${JSON.stringify(v)}——卡上的话只能有一处出处，就是指令正文`).toBe(false);
    }
    expect(i18n).not.toContain("contactTitle");
    expect(i18n).not.toContain("contactBody");
  });

  it("判据 5a：改指令正文就改渲染——同一张卡，换一句话，页面跟着换", async () => {
    await post("pm", { kind: "instruction", to: HUMAN, body: "第一版问句？后面这半句是细节。", intent: "ask", ack_by: soon(), options: ["甲", "乙"] });
    let html = await page();
    expect(html).toContain("第一版问句？");
    expect(html).toContain('value="甲"');
    expect(html).toContain('value="乙"');
    await post("pm", { kind: "instruction", to: HUMAN, body: "第二版问句？换了一句话。", intent: "ask", ack_by: soon(), options: ["丙", "丁"] });
    html = await page();
    expect(html).toContain("第二版问句？");
    expect(html).toContain("换了一句话。");
    // 判据 5b：按钮标签就是选项值，不是另一份写死的标签
    expect(html).toContain(">丙</button>");
    expect(html).toContain(">丁</button>");
    expect(html).toContain(">甲</button>");           // 旧卡照旧按它自己带的值作答
  });

  it("判据 3 / 5c：外呼卡人看到的字一个没动，而它现在来自 CONTACT_ASK", async () => {
    const w2 = world();
    const b2 = await w2.ready;
    await fetch(`${b2}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm", "content-type": "application/json" },
      body: JSON.stringify({ kind: "reading", surface: "project", key: "alert.ask", value: true }) });
    await fetch(`${b2}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "pm" } });   // 服务借这一次发出外呼卡
    const html = await (await fetch(`${b2}/`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/html" } })).text();
    const { title, detail } = splitTitle(CONTACT_ASK);
    expect(html).toContain(`${title}？`);              // 问号由 cardTitle 补回，与改造前一模一样
    expect(html).toContain(detail);
    for (const o of CONTACT_OPTIONS) expect(html).toContain(`value="${o}"`);
    w2.app.close();
  });
});
