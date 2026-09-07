/**
 * t-169：那句假话的页面那半。
 *
 * t-167 在 core 里补了两格（就是现在生产上跑的那一版 / 上过线被盖过），并算出 `pending`——这一批还在等人推吗。
 * 页面这一半只做两件事：按 pending 分两段，以及清单空着时说一句话。措辞一个字都不自拟，全取 core。
 *
 * 判据 2 特别要求「空清单那一支要有一条真的走到它的用例，不是只在夹具里造」——所以下面那条用例走的路径与今晚
 * 生产上一模一样：每一批都推过一次，于是候选数是 0。
 */
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { MemoryStore, BATCH_LINES, batchesEmptyLine } from "@ateam/core";
import { UI } from "../src/i18n.js";
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
    return j as { id: string };
  };
  const release = async () => (await fetch(`${base}/release`, { headers: { accept: "text/html" } })).text();
  const start = async () => { await new Promise<void>((r) => app.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`; };
  return { post, release, start, stop: () => new Promise<void>((r) => app.close(() => r())) };
}

const shaOf = (n: number) => `${String(n).repeat(7)}${"0".repeat(33)}`.slice(0, 40);
/**
 * 只看「装好的几批」那一节，免得断言被别处的同名文字满足。切到下一个 <h3> 为止，不按字数切——
 * 我第一版按 900 字切，切进了下面那一节，而那一节印的 `UI.releaseNothing`（「没有可上线的东西。」）
 * 与 `BATCH_LINES.none()`（「没有可上线的东西」）只差一个句号，于是断言被隔壁的句子满足了。
 * 这两句同义而分处两地，我另报了 pd，本件不动它。
 */
const batchesSection = (html: string) => {
  const i = html.indexOf(UI.releaseBatches);
  if (i === -1) return "";
  const j = html.indexOf("<h3>", i + 1);
  return html.slice(i, j === -1 ? undefined : j);
};

describe("t-169 · 已经发生的不占「接下来要发生什么」的位置", () => {
  it("每一批都推过之后，上线清单说的是「没有可上线的东西」，不是一片空白", async () => {
    const v = server();
    await v.start();
    try {
      // 走的是今晚生产上真实的那条路：装一批、推它、再装一批、再推——两批都当过生产头
      for (const n of [1, 2]) {
        await v.post("release", { kind: "reading", surface: "repo", key: `batch.${n}`, value: { sha: shaOf(n), base: n === 1 ? shaOf(9) : shaOf(1), contains: [`t-${n}`] } });
        await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: shaOf(n), method: "推上去了" });
      }
      const sec = batchesSection(await v.release());
      expect(sec).toContain(BATCH_LINES.allShipped());
      // 已经发生的那两批没有消失，它们搬去了「上过线的几批」
      const html = await v.release();
      expect(html).toContain(UI.releaseShipped);
      expect(html).toContain(BATCH_LINES.deployed());   // 最后那批：就是现在生产上跑的
      expect(html).toContain(BATCH_LINES.shipped());    // 更早那批：上过线，被盖过
      // 而这两句一个字都不在上线清单那一节里
      expect(sec).not.toContain(BATCH_LINES.deployed());
      expect(sec).not.toContain(BATCH_LINES.shipped());
    } finally { await v.stop(); }
  });

  it("还在等人推的那一批留在上线清单里，不进已发生那一段", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: shaOf(1), method: "读 /health" });
      // 装在当前生产头上、还没推：它是候选
      await v.post("release", { kind: "reading", surface: "repo", key: "batch.2", value: { sha: shaOf(2), base: shaOf(1), contains: ["t-2"] } });
      const html = await v.release();
      const sec = batchesSection(html);
      expect(sec).toContain("2222222");                 // 那一批在清单里
      expect(sec).not.toContain(BATCH_LINES.allShipped());   // 清单不空，就不说那句
      expect(html).not.toContain(UI.releaseShipped);    // 没有已发生的批次，那一段整个不出现
    } finally { await v.stop(); }
  });

  it("已经上过线的两句不印成「拦住了」的样子——那是用颜色说一句 core 没说的话", async () => {
    const v = server();
    await v.start();
    try {
      for (const n of [1, 2]) {
        await v.post("release", { kind: "reading", surface: "repo", key: `batch.${n}`, value: { sha: shaOf(n), base: n === 1 ? shaOf(9) : shaOf(1), contains: [`t-${n}`] } });
        await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: shaOf(n), method: "推上去了" });
      }
      const html = await v.release();
      const line = (said: string) => html.slice(Math.max(0, html.indexOf(said) - 40), html.indexOf(said));
      expect(line(BATCH_LINES.deployed())).toContain('class="meta"');
      expect(line(BATCH_LINES.deployed())).not.toContain("held");
      expect(line(BATCH_LINES.shipped())).toContain('class="meta"');
      expect(line(BATCH_LINES.shipped())).not.toContain("held");
    } finally { await v.stop(); }
  });

  it("而真的推不出去的那一批仍然印成「拦住了」的样子", async () => {
    const v = server();
    await v.start();
    try {
      await v.post("release", { kind: "reading", surface: "production", key: "deployed.sha", value: shaOf(5), method: "读 /health" });
      // 装在一个很旧的底上、从没上过线：它是候选，而且推不出去
      await v.post("release", { kind: "reading", surface: "repo", key: "batch.7", value: { sha: shaOf(7), base: shaOf(9), contains: ["t-7"] } });
      const html = await v.release();
      const sec = batchesSection(html);
      expect(sec).toContain('class="held"');
    } finally { await v.stop(); }
  });

  it("措辞全取 core：页面不为这两格自拟任何一句", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/html.ts", import.meta.url), "utf8"));
    for (const said of [BATCH_LINES.deployed(), BATCH_LINES.shipped(), BATCH_LINES.allShipped(), BATCH_LINES.neverPacked()]) {
      expect(src, `html.ts 里写死了「${said}」，该取 core 的 BATCH_LINES`).not.toContain(said);
    }
  });
});

/**
 * t-176 (pd 08:47)：这一段空着时说的是两件独立的事——批次那边什么样，以及有没有验过了却没装进批次的。
 *
 * 这一件的由来是一句**量出来的假话**：pd 08:38 先给了两句，我拿今天的生产板一比，两句对今天都是假的
 * （批次 5、在等推 0，而 pending_deploy 有 7 件）。所以下面四种状态逐个断言，第三种就是今天生产的那一种。
 */
describe("t-176 · 空着的原因不止一种，各说各的", () => {
  it("① 一批都没装过、也没有等上线的：只说批次那一句", () => {
    expect(batchesEmptyLine([], 0)).toBe("还没装过批次。");
  });

  it("② 装过、都上线了、没有没装的：只说批次那一句", () => {
    const shipped = [{ pending: false } as never];
    expect(batchesEmptyLine(shipped, 0)).toBe("装好的批次都上线了。");
  });

  it("③ 装过、都上线了、还有没装的——今天生产就是这一种，两句都说，带上那个数", () => {
    const shipped = [{ pending: false } as never, { pending: false } as never];
    expect(batchesEmptyLine(shipped, 7)).toBe("装好的批次都上线了。还有 7 件验过了，没装进任何一批。");
    // 退役的那句一个字都不该再出现：它想同时说两件事，对这一种必然说假话
    expect(batchesEmptyLine(shipped, 7)).not.toContain("没有做完等上线的东西");
  });

  it("④ 还有没推的批次：这一段本来就在列它们，一句都不说", () => {
    expect(batchesEmptyLine([{ pending: true } as never], 3)).toBeNull();
  });

  it("一批都没装过、却有等上线的：也要说清那个数（①与③之间那一格）", () => {
    expect(batchesEmptyLine([], 2)).toBe("还没装过批次。还有 2 件验过了，没装进任何一批。");
  });
});
