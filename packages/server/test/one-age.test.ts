/**
 * t-334（pd ㉔，定稿在 `3a40fe9` 的 `docs/product.md:286`）：**一张给人看的卡片上只许有一个年龄。**
 *
 * 真样本（pd 10-31 量于 production，判据②）：人那一页上那三张「<角色> 缺人 N 分钟，M 条没送到。起一个
 * <角色>？」，id 全铸于 2026-09-07，正文的分钟数却是现算的（16:24 读到 1062、16:26 读到 1063）——**同一张卡上
 * `ack_by` 过期 53 天，而正文说 17 小时**，而 overdue 是空的。读数 `production:needs_human.card.oldest.days = 54`。
 *
 * 卡的身份（id、页上那句「几天前问的」）和正文里的数必须说同一件事；**做不到就不要印第二个数**。
 *
 * 与 t-333 的接缝（判据③）：正文那个数是现算的（t-210 刻意让它随时间重述），所以「保留这个数」就要求卡的身份
 * 是「这一次」的——那是 t-333，已交（7dbe650：角色回来即结束，下一次缺人铸新 id）。**这一件管的是另一半**：
 * 日志里已经躺着的那几张老卡（它们的事实此刻仍然成立，所以 t-333 不会结束它们），以及任何一张正文自带年龄的卡
 * ——这一页上不许再印第二个年龄。两张单合起来才覆盖 pd 量到的那一张。
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, append, pull, SERVICE_ACTOR, missingCard } from "@ateam/core";
import { createApp } from "../src/app.js";
import { MemoryRegistry } from "../src/projects.js";
import { ownerKeyOf } from "./owner.js";

const TOKEN = "tok";
const HUMAN = "human";
const DAY = 24 * 3600_000;
const apps: ReturnType<typeof createApp>[] = [];
afterAll(() => Promise.all(apps.map((a) => new Promise<void>((r) => a.close(() => r())))));

/**
 * 页上一个「年龄」长什么样，两族都算：
 * · 身份那一个，`ago()` 那把梯子印出来的四档（「3 天前」）；
 * · 正文自带的那一个，`missingCard` 那一族（「缺人 1062 分钟」「有 N 分钟没读日志了」）。
 * **两族都要数**，否则「只剩一个」会被一个数不到的年龄骗过去——我第一版只数了梯子那一族，于是正文里
 * 那个 1062 分钟压根没被数上，断言差点为了一个错的理由变绿。
 */
const AGE = /(刚刚|\d+ 分钟前|\d+ 小时前|\d+ 天前|缺人 \d+ 分钟|有 \d+ 分钟没读日志了)/g;

async function up() {
  const store = new MemoryStore();
  let t = Date.parse("2026-10-31T16:24:00.000Z");
  const registry = new MemoryRegistry();
  const app = createApp({ store, token: TOKEN, human: HUMAN, sha: "abc1234", alertIntervalMs: 0, testHooks: true, registry, clock: () => new Date(t) });
  apps.push(app);
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const owner = await ownerKeyOf(registry, "ateam", HUMAN);
  // t-134：服务自己的事实由用例从里面写，不借 HTTP（队里那条 P0 也在这儿：谁都不许以 x-actor: human 写入）。
  const put = (e: Parameters<typeof append>[1], at: number) => append(store, e, { human: HUMAN, now: new Date(at) });
  return {
    store, put, now: () => t,
    page: () => fetch(`${base}/`, { headers: { accept: "text/html", authorization: `Bearer ${owner}` } }).then((r) => r.text()),
    post: (actor: string, body: unknown) => fetch(`${base}/events`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()),
  };
}
/** 那张卡在页面上的那一段。 */
const cardOf = (html: string, needle: string) => {
  const i = html.indexOf(needle);
  expect(i, `那张卡要在页上（找 ${needle}）`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<article", i), html.indexOf("</article>", i));
};

describe("t-334 · 一张卡上只许有一个年龄", () => {
  it("**判据②**：九月铸的 id ＋ 正文现算的「缺人 1062 分钟」⇒ 页上只有一个年龄，没有「53 天前」", async () => {
    const w = await up();
    const nine = w.now() - 53 * DAY;
    await w.put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "gone"] }, nine - 60_000);
    // 它读过一次日志，然后走了 1062 分钟——正文那个数就是从这一刻算出来的
    await pull(w.store, "gone", null, new Date(w.now() - 1062 * 60_000));
    await w.put({ kind: "instruction", actor: "pm", to: "gone", body: "干一件", ack_by: new Date(nine + 3600_000).toISOString() }, nine);
    // 服务九月发的那张卡，一字照它当时的形状（正文里的数是发卡那一刻算的 5 分钟）
    const card = await w.put({ kind: "instruction", actor: SERVICE_ACTOR, to: HUMAN, intent: "do",
      body: missingCard("gone", "missing", 5, 1), ack_by: new Date(nine + 3600_000).toISOString() }, nine);

    const art = cardOf(await w.page(), "起一个 gone？");
    expect(art, "正文照当下重述（t-210）").toContain("缺人 1062 分钟");
    const ages = art.match(AGE) ?? [];
    expect(ages, `一张卡上只许有一个年龄，这里有 ${ages.length}：${ages.join("、")}`).toHaveLength(1);
    expect(ages[0], "留下的那一个是正文里的那个").toBe("缺人 1062 分钟");
    expect(art, "**53 天前**不许出现：它与正文那个 17 小时互相矛盾").not.toContain("53 天前");
  });

  it("**对照**：正文不自带年龄的卡，照旧印「谁 · 几天前问的」（这一件没有把那一行一起拿掉）", async () => {
    const w = await up();
    await w.put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "gone"] }, w.now() - 60 * DAY);
    await w.put({ kind: "instruction", actor: "pm", to: HUMAN, intent: "ask", body: "先发哪个？",
      ack_by: new Date(w.now() + 3600_000).toISOString() }, w.now() - 3 * DAY);
    const art = cardOf(await w.page(), "先发哪个？");
    expect(art).toContain("3 天前");
    expect(art.match(AGE) ?? [], "也只有一个").toHaveLength(1);
  });
});
