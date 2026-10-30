/**
 * t-256：**节点自报的 `cli.sha` 取的是 cwd 的 git HEAD，不是那份跑着的 dist。**
 *
 * pm 11:26–11:28 用一份 `e922184` 的 binary 跑 `8300434` 的 checkout，**连落两条互相矛盾的 `node:pm:cli.sha`**；
 * dev 11:45 那条同样是 HEAD 推的。牌桌上「谁在跑哪一版」是一条**别人会引用**的事实（T1）。
 *
 * 旧 `CLI_SHA_METHOD` 的原文里那半句「本机 git HEAD，**也就是这份 dist 该有的版本**」正是这次错的全部：
 * **「该有的」被当成了「是的」。**
 *
 * 每条用例各自一个空目录当 root——`recordCliSha` 会把落过的值记在 `.ateam/` 里去重，
 * **共用 cwd 的话前一条会让后一条「碰巧通过」**（我第一版就是这样，第二条其实没测到东西）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCliSha } from "../src/main.js";
import { CLI_SHA_KEY, CLI_SHA_METHOD } from "@ateam/core";

const DIST_A = "aaaaaaa1111111111111111111111111111aaaa";   // 跑着的那份 dist 从这个提交编出来
const HEAD_B = "bbbbbbb2222222222222222222222222222bbbb";   // 而 cwd 此刻站在这个提交上

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "clisha-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fakeClient() {
  const sent: Record<string, unknown>[] = [];
  return { sent, emit: async (e: unknown) => { sent.push(e as Record<string, unknown>); } };
}
const stamp = (o: unknown) => () => JSON.stringify(o);

describe("t-256 · 自报的是那份 dist，不是 cwd 的 HEAD", () => {
  it("dist 来自 A、cwd HEAD 是 B：落 A，而且一个字都不提 B", async () => {
    const c = fakeClient();
    await recordCliSha(c, "dev", stamp({ sha: DIST_A }), root);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].value).toBe(DIST_A);
    expect(JSON.stringify(c.sent[0])).not.toContain(HEAD_B);
    expect(c.sent[0].key).toBe(`dev:${CLI_SHA_KEY}`);
  });

  it("判不出那份 dist 是哪一版：不落，也不许拿 HEAD 顶（判据 1）", async () => {
    for (const bad of [null, "", "{ 不是 json", JSON.stringify({}), JSON.stringify({ sha: "不是一个 sha" }), JSON.stringify({ sha: 123 })]) {
      const c = fakeClient();
      await recordCliSha(c, "dev", () => bad as string | null, root);
      expect(c.sent, `stamp=${String(bad)}`).toEqual([]);
    }
  });

  it("盖章时工作区是脏的：说出来，不假装那份构建就等于那个提交", async () => {
    const c = fakeClient();
    await recordCliSha(c, "dev", stamp({ sha: DIST_A, dirty: true }), root);
    expect(c.sent[0].value).toBe(`${DIST_A}+dirty`);
  });

  it("同一个值不重复落；值变了才再落一条", async () => {
    const c = fakeClient();
    await recordCliSha(c, "dev", stamp({ sha: DIST_A }), root);
    await recordCliSha(c, "dev", stamp({ sha: DIST_A }), root);
    expect(c.sent).toHaveLength(1);
    await recordCliSha(c, "dev", stamp({ sha: HEAD_B }), root);   // 真换了一份构建
    expect(c.sent).toHaveLength(2);
  });

  /** 判据 7：名字与 method 都要逐字承认它是「最后一次」，不是「在跑哪一版」。 */
  it("字段名与 method 自己说清楚它是「最近一次说话用的那份构建」", async () => {
    expect(CLI_SHA_KEY).toBe("cli.sha.last");
    expect(CLI_SHA_METHOD).toContain("最近一次说话用的那份构建");
    expect(CLI_SHA_METHOD).toContain("不看 cwd");
    expect(CLI_SHA_METHOD).not.toContain("该有的版本");      // 旧 method 里那半句假话
  });
});
