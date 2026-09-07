/**
 * t-155：读数区只印那一句话，值折进挖层。
 *
 * 今晚这个洞的形状值得写在最上面：`production:deployed.tasks` 的值是 83 个任务 id 的 JSON，它原样印在了人眼前，
 * 而「页面上不许有英文」那条断言看着它通过了——因为任务 id 里没有英文单词。夹具里没有生产上真实存在的形状，
 * 于是没有一条用例发现它。所以这里的断言不是「没有大括号」，是逐条：那一句在，值不在第一层。
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, PROJECT_SURFACE } from "@ateam/core";
import { createApp } from "../src/app.js";

const TOKEN = "secret-token";
const HUMAN = "human";

function server() {
  const app = createApp({ store: new MemoryStore(), token: TOKEN, human: HUMAN, sha: "abc1234" });
  let base = "";
  const post = async (actor: string, body: unknown) => {
    const r = await fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (r.status !== 201) throw new Error(`append ${r.status}: ${JSON.stringify(j)}`);
    return j;
  };
  const page = async () => (await fetch(`${base}/`, { headers: { accept: "text/html" } })).text();
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  return { get base() { return base; }, post, page, start, stop: () => new Promise<void>((r) => app.close(() => r())) };
}

/** Only what the readings section itself renders, so an assertion here cannot be satisfied by some other section. */
const readingsSection = (html: string) => html.slice(html.indexOf('<section id="readings"'), html.indexOf('<section id="readings"') === -1 ? 0 : undefined).split("</section>")[0];
/** The first layer: what a reader sees without opening anything. */
const firstLayer = (section: string) => section.replace(/<details class="dig">[\s\S]*?<\/details>/g, "");

describe("t-155 · 读数区只说那一句话", () => {
  it("a structured fact reads as its sentence; its value is one fold down, not on the first layer", async () => {
    const v = server();
    await v.start();
    try {
      // 一条**没有被声明**的结构化读数——今晚生产上十几条一次性测量都是这个样子，t-154 让它退化成一句真话。
      // 这一类正是把 JSON 印到人眼前的那一类：声明过的六条今天全都 said_elsewhere，读数区根本不列它们。
      await v.post("qa", { kind: "reading", surface: "production", key: "s2.walk", value: { scenario: "S2", blocked: true, why: "要一次真实的需求变更，我不替 human 造样本" }, method: "按场景在生产上走一遍" });
      const sec = readingsSection(await v.page());
      const first = firstLayer(sec);
      expect(first).toContain("production:s2.walk，");          // 退化后的那一句：名字、多久以前、谁
      expect(first).toMatch(/(刚刚|\d+ 分钟前)由 \S+ 记下/);   // t-180: 时间在句首
      expect(first).not.toContain("scenario");                  // 值的字段名不在第一层
      expect(first).not.toContain("不替 human 造样本");           // 值里那句中文也不在第一层
      expect(sec).toContain('<details class="dig">');           // 但它挖得到，一个字节不少
      expect(sec).toContain("scenario");
      expect(sec).toContain("不替 human 造样本");
      // 退化那句里已经有「N 分钟前由 qa 记下」，行尾不许再说一遍谁、也不许再说一遍多久以前。
      // t-180 之后这一行本身就含「刚刚」，所以口径从「一次都不许出现」改成「恰好出现一次」——
      // 这比原来更严：原来只挡得住行尾重复，现在连 core 那句里多说一遍也挡得住。
      expect(first.match(/qa/g) ?? []).toHaveLength(1);
      expect(first.match(/刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前/g) ?? []).toHaveLength(1);
    } finally { await v.stop(); }
  });

  it("does not repeat what core says the board already said, and says how many it left out", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111", method: "读 /health" });
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: "aaaaaaa1111", contained: ["t-1", "t-2", "t-3"], not_contained: ["t-9"] }, method: "git-ancestor" });
      const html = await v.page();
      const sec = readingsSection(html);
      // 判据 2：这一条在「线上」那一行已经说过，读数区一个字都不再说——连挖层也没有
      expect(sec).not.toContain("deployed.tasks");
      expect(sec).not.toContain("这一版带上了");
      // 但它不是被悄悄丢掉的：少了几条，这里说出来
      expect(sec).toContain("另有 1 条牌桌上别处已经说过，这里不重复");
      // 而这条事实没有消失：牌桌用它自己的方式在第一屏说这一版是哪一版（said_elsewhere 说的正是这个）
      expect(html.slice(0, html.indexOf('<details class="rest"'))).toContain("aaaaaaa");
      // 值也没有消失，要挖的人从 /board 挖得到——不显示不等于不记得
      const j = await (await fetch(`${v.base}/board`, { headers: { authorization: `Bearer ${TOKEN}`, "x-actor": "qa" } })).json() as { readings: { key: string; value: unknown }[] };
      expect(j.readings.find((r) => r.key === "deployed.tasks")?.value).toBeTruthy();
    } finally { await v.stop(); }
  });

  it("the count in the header, the number of rows, and the fold's own summary are one number", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111", method: "读 /health" });
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: "aaaaaaa1111", contained: ["t-1"], not_contained: [] }, method: "git-ancestor" });
      await v.post("qa", { kind: "reading", surface: "production", key: "users.count", value: 128, method: "数了一遍" });
      const html = await v.page();
      const sec = readingsSection(html);
      const rows = (sec.match(/<li>/g) ?? []).length;
      expect(rows).toBe(2);                              // deployed.sha 与 users.count；deployed.tasks 不在
      expect(sec).toContain("2 条有效");                  // 这一节的标题说的是它真的列出了几条
      expect(html).toContain("事实 2 条有效");             // 「其余」那一折的摘要说的是同一个数
    } finally { await v.stop(); }
  });

  it("a scalar is still printed as it is: a number, a sha, a word — printing it is saying it", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("qa", { kind: "reading", surface: "production", key: "users.count", value: 128, method: "数了一遍" });
      const sec = readingsSection(await v.page());
      expect(sec).toContain("production:users.count");
      expect(sec).toContain("128");
      expect(sec).not.toContain('<details class="dig">');   // 标量没有第二层可挖
    } finally { await v.stop(); }
  });
});
