/**
 * t-133: GET /release — the detail page behind the 线上 row. pd 03:32: not a second board. No cards, nothing in
 * 需要你, and the件数 stays on the board, because one number computed in two places drifts (t-118, six copies in
 * one night). What lives here is what the board has no room for: which version runs, what the next one brings,
 * and which string is not moving because a member of it has not passed.
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, type Board } from "@ateam/core";
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
  const page = async (path = "/release") => (await fetch(`${base}${path}`, { headers: { accept: "text/html" } })).text();
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  return { get base() { return base; }, post, page, start, stop: () => new Promise<void>((r) => app.close(() => r())) };
}

/** A task carried to `status`, naming `sha` in its evidence. */
async function task(v: ReturnType<typeof server>, id: string, title: string, sha: string, status: "done" | "verified") {
  await v.post("pm", { kind: "task", op: "create", task: id, title, criteria: ["能用"] });
  await v.post("dev", { kind: "task", op: "claim", task: id, touches: [`src/${id}.ts`] });
  await v.post("dev", { kind: "task", op: "done", task: id, evidence: `${sha}：做完了` , no_human_impact: true});
  if (status === "verified") await v.post("qa", { kind: "task", op: "verify", task: id, surface: "repo", pass: true, evidence: "跑过了" });
}

describe("t-133 · 上线详情页", () => {
  it("names the version the way a person says it, and never repeats the board's count", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111", method: "ateam release --deploy 推到 production" });
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222", method: "ateam release --deploy 推到 production" });
      const html = await v.page();
      // 第 N 次上线, counted within the day; the sha is there too, but the name is what leads
      expect(html).toMatch(/线上这一版<\/span> <b>\d{2}-\d{2} 第 2 次上线<\/b> <code>bbbbbbb<\/code>/);
      // pd 03:32 / criterion 2: the page is not a second place that counts what is waiting
      expect(html).not.toContain("件验过了，等一次上线");
      expect(html).not.toMatch(/\d+ 件验过了/);
      // not a second board: no cards, no 需要你, nothing to press
      expect(html).not.toContain('class="ask"');
      expect(html).not.toContain("需要你");
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<button");
    } finally { await v.stop(); }
  });

  it("a string held by one of its members says so, and names who it is waiting on", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
      // three tasks on one sha: two passed, one not — the whole string is held (release's second clause)
      await task(v, "t-1", "灰字", "ccccccc3333", "verified");
      await task(v, "t-2", "按钮", "ccccccc3333", "verified");
      await task(v, "t-3", "外呼", "ccccccc3333", "done");
      // and a unit of its own that is moving
      await task(v, "t-9", "接缝", "ddddddd4444", "verified");
      const html = await v.page();
      expect(html).toContain("必须一起上的几件");
      expect(html).toContain("按住没发：t-3");
      expect(html).toContain("等 dev");            // the owner of the member that has not passed
      expect(html).toContain("这次能带上");
      // a unit whose members all passed is not described as held
      const moving = html.slice(html.indexOf("这次能带上"));
      expect(moving).toContain("t-9");
      expect(moving).not.toContain("按住没发");
    } finally { await v.stop(); }
  });

  it("a packed batch that cannot go out says why, in core's words, and one that can says so plainly (t-129)", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "aaaaaaa1111" });
      await task(v, "t-1", "灰字", "ccccccc3333", "verified");
      expect(await v.page()).not.toContain("装好的几批");

      // packed on the head production is actually running: nothing stands in its way, and nothing is warned about
      await v.post("release", { kind: "reading", surface: "repo", key: "batch.2.10", value: { sha: "eeeeeee5555", base: "aaaaaaa1111", contains: ["t-1"] } });
      const ok = await v.page();
      expect(ok).toContain("装好的几批");
      expect(ok).toContain("2.10");
      expect(ok).toContain("可以推");
      expect(ok).not.toContain("按住没发");

      // production moved on, and the batch would take two tasks back off it: core's sentence, printed as it stands
      await v.post("qa", { kind: "task", op: "verify", task: "t-1", surface: "production", pass: true, evidence: "线上看到" });
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: "bbbbbbb2222" });
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.tasks", value: { sha: "bbbbbbb2222", contained: ["t-1", "t-2"], not_contained: [], method: "git merge-base --is-ancestor 逐件测" } });
      const held = await v.page();
      expect(held).toContain("按住没发：");
      expect(held).toContain("推它会把");
      expect(held).toContain("从生产上退回去。重装，别推。");
      // the page must not have written a second sentence of its own about the same thing
      expect(held).not.toContain("这批不能推");
    } finally { await v.stop(); }
  });

  it("says so plainly when there is nothing to ship, and when nobody has checked what is live", async () => {
    const v = server();
    await v.start();
    try {
      const empty = await v.page();
      expect(empty).toContain("还没人核对过线上是哪一版");
      expect(empty).toContain("没有可上线的东西。");
      expect(empty).not.toContain("第 0 次上线");
    } finally { await v.stop(); }
  });
});
