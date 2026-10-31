/**
 * t-242 ②：**「线上」那一节的标题，此刻说的是这份名单到底是什么。**
 *
 * 原来那句问的是「这一版带来了什么」，而它印的是「在生产上验过的那几件」——一版可以带来十件而一件都还
 * 没人验，所以标题比名单大一圈。它不是假话，是**说大了**，而这一族今天已经出过三次（t-237 两处、t-231 一处）。
 *
 * **这一份存在的理由，是既有用例挡不住改这句话**：`html.test.ts` 里那几条引的是常量
 * （`${VERIFIED_ON_THIS_VERSION}`），所以标题改成任何字它们都绿。**一句 pd 定稿过的话，要有一处逐字钉它。**
 * 定稿：pd 10-30 22:35，指令 `01M67F840S7HVT8P2ADCXA30Y4`。
 *
 * 连带钉住 pd 给的那条前提：**它可以不提版本，是因为它嵌在那个 sha 的块里**——所以这一份也断言那一行
 * （sha 与「在生产上验过 N 件」）确实在它前面、在同一块里。搬出那个块，版本就得回到标题里。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, VERIFIED_ON_THIS_VERSION, type NewEvent } from "@ateam/core";
import { createApp } from "../src/app.js";
import { ownerCookie, TEST_OWNER_SECRET } from "./owner.js";

const TOKEN = "secret-token";
const HUMAN = "human";
const HTML = "text/html,application/xhtml+xml";
const SHA = "ede0f06b9d08";

let app: ReturnType<typeof createApp>;
let base = "";
let cookie = "";
const store = new MemoryStore();
const put = (e: NewEvent) => append(store, e, { human: HUMAN });

beforeAll(async () => {
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] });
  await put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: SHA, method: "ateam release --deploy", writes: ["production:deployed.sha"] });
  // 一件在生产上验过的：它进「线上」那一节的名单
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "Cookie flags", criteria: ["一条"], no_human_impact: true });
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["src/a.ts"] });
  await put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: `${SHA}：这一笔`, shows: "登录页的 cookie 现在带 Secure" });
  await put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "在生产上走过一遍" });
  app = createApp({ ownerSecret: TEST_OWNER_SECRET, store, token: TOKEN, human: HUMAN, sha: "abc1234" });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  cookie = await ownerCookie(base, TOKEN);
});
afterAll(() => new Promise<void>((r) => app.close(() => r())));

const page = async () => (await fetch(`${base}/`, { headers: { accept: HTML, cookie } })).text();

describe("t-242 ② · 那一节的标题逐字是 pd 定稿的那一句", () => {
  it("**逐字**：页上出现「在生产上验过的那几件」，而原来那句说大了的标题一个字都不在", async () => {
    const html = await page();
    expect(html).toContain("在生产上验过的那几件");
    expect(html, "占位撤掉了：页上不许再出现「措辞待定」").not.toContain("措辞待定");
    expect(html, "说大了的那一句不许还在").not.toContain("这一版带来了什么");
    expect(VERIFIED_ON_THIS_VERSION, "常量本身就是那一句——页上那串字不是另一处抄的").toBe("在生产上验过的那几件");
  });

  it("**pd 那条前提**：标题之所以能不提版本，是因为 sha 与「验过 N 件」就在它前面的同一块里", async () => {
    const html = await page();
    const sha = html.indexOf("ede0f06");
    const count = html.indexOf("在生产上验过 1 件");
    const title = html.indexOf(VERIFIED_ON_THIS_VERSION);
    expect(sha, "sha 在页上").toBeGreaterThan(-1);
    expect(count, "「在生产上验过 N 件」在页上").toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(-1);
    expect(sha, "sha 在标题之前").toBeLessThan(title);
    expect(count, "件数也在标题之前——这两行就是那个「块」").toBeLessThan(title);
  });

  it("名单一个字没动：标题下面列的还是那件事本身（判据：改的是标题，不是信息）", async () => {
    const html = await page();
    expect(html).toContain("登录页的 cookie 现在带 Secure");
  });
});
