/**
 * t-217：**牌桌上看得出谁在跑旧的命令行。**
 *
 * 数据这一半是 t-211 交付并验过的（`node:<角色>:cli.sha.last`，qa 16:14 在 `0721a59` 上判过），本件不重做它
 * （判据 1）。本件是另一半：**那一格给全队与人看**，而 t-211 那一句只给本人、印在他自己的 `sync` 上（判据 3）。
 *
 * 措辞不是我自拟的（判据 2）：pd 10-30 22:35 的指令 `01M67F840S7HVT8P2ADCXA30Y4` 逐字定稿，
 * 并点明「它量出来的数、它看到的提醒，都可能是旧的」那半句不许删。所以下面有一格**逐字钉它**——
 * 一句被定稿过的话，用例要让改它的人当场红，而不是等人在页面上发现它变了。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, behindOnBoard, cliBehindOnBoardLine, deployHistory, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const A = "aaaaaaa1111111111111111111111111111111a";   // 第一次上线
const B = "bbbbbbb2222222222222222222222222222222b";   // 第二次
const C = "ccccccc3333333333333333333333333333333c";   // 第三次（最新）
const MINE = "dddddddd44444444444444444444444444444d";  // 谁也没上线过的一笔

/** 三次上线，外加每个角色自报的构建。`report` 里没写的角色就是没自报过。 */
async function world(report: Record<string, string>) {
  const store = new MemoryStore();
  let at = Date.parse("2026-10-31T06:00:00Z");
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((at += 60_000)) });
  await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] });
  for (const sha of [A, B, C])
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: sha, method: "ateam release --deploy", writes: ["production:deployed.sha"] });
  for (const [role, value] of Object.entries(report))
    await emit({ kind: "reading", actor: role, surface: "node", key: `${role}:cli.sha.last`, value, method: "dist 边上那张章" });
  const s = reduce(await store.read());
  return { s, b: board(s, HUMAN) };
}
const rowOf = (b: { presence: { actor: string; behind_deploys: number | null; cli_sha: string | null }[] }, role: string) =>
  b.presence.find((p) => p.actor === role)!;

describe("t-217 判据 4 · 一正一反，对照在同一个牌桌上", () => {
  it("**跑旧构建的那个标得出来**：自报的是第一次上线那一版 ⇒ 旧 2 次；第二次那一版 ⇒ 旧 1 次", async () => {
    const { s, b } = await world({ dev: A, qa: B });
    expect(deployHistory(s)).toHaveLength(3);
    expect(behindOnBoard(s, "dev")).toBe(2);
    expect(behindOnBoard(s, "qa")).toBe(1);
    expect(rowOf(b, "dev").behind_deploys, "牌桌那一行上带着它，不只是函数算得出").toBe(2);
    expect(rowOf(b, "qa").behind_deploys).toBe(1);
  });

  it("**与生产同版的那个一个字都不多说**，而同一张牌桌上落后的那个照旧标着——对照在同一格里", async () => {
    const { s, b } = await world({ dev: A, release: C });
    expect(behindOnBoard(s, "release"), "它跑的就是最新那一版：没有话可说").toBeNull();
    expect(rowOf(b, "release").behind_deploys).toBeNull();
    expect(rowOf(b, "release").cli_sha, "而「它自报过什么」仍然看得见——沉默的是那句话，不是数据").toBe(C);
    expect(rowOf(b, "dev").behind_deploys, "同一张牌桌上落后的那个还标着，所以上面那个 null 不是「整格坏了」").toBe(2);
  });

  it("**数不出来就一个字都不说**（t-147：缺字段是不知道，不是报平安）：没上线过的那一笔、没自报过、带 +dirty，三种都是 null", async () => {
    const { s } = await world({ dev: MINE, qa: `${A}+dirty` });
    expect(behindOnBoard(s, "dev"), "它跑的是自己分支上的一笔：牌桌在服务端算，没有 git，答不出祖先关系").toBeNull();
    expect(behindOnBoard(s, "qa"), "有未提交改动的树不等于那个 sha，说它正好是某一次上线就是假话").toBeNull();
    expect(behindOnBoard(s, "pm"), "从没自报过").toBeNull();
  });

  it("只上线过一次时也不说：没有「最新的上一版」可比", async () => {
    const store = new MemoryStore();
    let at = Date.parse("2026-10-31T06:00:00Z");
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((at += 60_000)) });
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev"] });
    await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: A, method: "deploy", writes: ["production:deployed.sha"] });
    await emit({ kind: "reading", actor: "dev", surface: "node", key: "dev:cli.sha.last", value: A, method: "章" });
    expect(behindOnBoard(reduce(await store.read()), "dev")).toBeNull();
  });
});

describe("t-217 判据 2 · 那句话是 pd 定稿的，逐字钉住", () => {
  it("逐字相同，而中间那半句（「它量出来的数、它看到的提醒，都可能是旧的」）在里面", () => {
    const line = cliBehindOnBoardLine("dev", A, 2);
    expect(line).toBe("dev 的命令行是 aaaaaaa，比最新的上线旧 2 次。它量出来的数、它看到的提醒，都可能是旧的——要它自己跑 git pull && pnpm build。");
    expect(line, "pd 点名不许删的那半句").toContain("它量出来的数、它看到的提醒，都可能是旧的");
  });

  it("它只收短 sha 的前七位，而角色名与次数原样进去", () => {
    expect(cliBehindOnBoardLine("qa", B, 1)).toBe("qa 的命令行是 bbbbbbb，比最新的上线旧 1 次。它量出来的数、它看到的提醒，都可能是旧的——要它自己跑 git pull && pnpm build。");
  });
});
