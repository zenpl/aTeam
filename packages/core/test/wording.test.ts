/**
 * t-214：往 core 之外加人可见的话有闸，往 core 里加没有——今晚冻结就是从这个口子被穿的。
 *
 * 真样本：t-166 第一版把两句新话加在 events.ts（core 里），core 外那 7 条断言一条都没红。认出它的是 qa 手工
 * 去看「是哪几条」，不是任何一道闸。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceFiles, isProductSource, SECOND_HOMES_ROOT, measureWording, newWording, wordingHash, WORDING_AT_FREEZE, WORDING_ADDED_DURING_FREEZE, WORDING_FROZEN } from "../src/index.js";

const ROOT = join(import.meta.dirname, "../../..");
const sources = () => Object.fromEntries(
  sourceFiles(join(ROOT, SECOND_HOMES_ROOT), SECOND_HOMES_ROOT).filter(isProductSource)
    .map((f) => [f, readFileSync(join(ROOT, f), "utf8")] as const));

describe("t-214 判据 1 · 往 core 里加也有闸", () => {
  it("此刻没有人新造人可见的字（快照 ＋ 旁桶之外一句都没有）", () => {
    const added = newWording(sources());
    expect(added, `多了 ${added.length} 句人可见的话，冻结开着：\n${added.map((w) => `  ${w.file}  ${w.text}`).join("\n")}\n` +
      `pd 通过之后跑 bin/wording --write 重新起算；不许为了让它变绿而顺手跑一遍。`).toEqual([]);
  });

  it("往 core 里加一句：闸红，并说得出是哪一句、在哪个文件", () => {
    const s = { ...sources(), "packages/core/src/events.ts": `const x = "这是一句谁也没说过的新话，加在 core 里";` };
    const added = newWording(s);
    expect(added).toHaveLength(1);
    expect(added[0].file).toBe("packages/core/src/events.ts");
    expect(added[0].text).toContain("谁也没说过的新话");
  });

  it("往 core 之外加一句也红——这道闸不分住在哪儿", () => {
    const added = newWording({ ...sources(), "packages/cli/src/format.ts": `const x = "另一句谁也没说过的新话，加在命令行那侧";` });
    expect(added).toHaveLength(1);
    expect(added[0].file).toBe("packages/cli/src/format.ts");
  });
});

describe("t-214 判据 2 · 按内容判，不按总数判", () => {
  it("加一句同时删一句：总数一动不动，闸照样红——这正是 t-166 两版都是 524 那次骗过人的形状", () => {
    const s = sources();
    const before = measureWording(s).length;
    // 拿 core 里一句真的存在的话换成一句新话：条数不变
    const one = measureWording(s).find((w) => w.file === "packages/core/src/events.ts")!;
    const swapped = { ...s, "packages/core/src/events.ts": s["packages/core/src/events.ts"].replace(one.text, "换上来的这一句谁也没说过") };
    expect(measureWording(swapped).length, "这个用例要的就是条数不变").toBe(before);
    const added = newWording(swapped);
    expect(added).toHaveLength(1);
    expect(added[0].text).toContain("换上来的这一句");
  });

  it("闸给的是那几句原文，不是一个数——「多了 3 句」没人能据它做事", () => {
    const added = newWording({ ...sources(), "packages/core/src/events.ts": `const x = "又一句没说过的话，用来看闸印不印原文";` });
    expect(added[0]).toHaveProperty("text");
    expect(added[0]).toHaveProperty("file");
  });
});

describe("t-214 判据 3 · 搬位置不算新增", () => {
  it("把一句话从 cli 原样搬进 core：闸看都看不见（口径是整个仓库的集合，不分住哪儿）", () => {
    const s = sources();
    const fromCli = measureWording(s).find((w) => w.file.startsWith("packages/cli/src/"))!;
    const moved = {
      ...s,
      [fromCli.file]: s[fromCli.file].replace(fromCli.text, ""),
      "packages/core/src/events.ts": `${s["packages/core/src/events.ts"]}\nconst moved = ${JSON.stringify(fromCli.text)};`,
    };
    expect(newWording(moved)).toEqual([]);
  });

  it("改一个字就算新增——搬位置放过，改字不放过", () => {
    const s = sources();
    const one = measureWording(s).find((w) => w.file === "packages/core/src/events.ts" && w.text.length > 8)!;
    const tweaked = { ...s, "packages/core/src/events.ts": s["packages/core/src/events.ts"].replace(one.text, one.text + "了") };
    expect(newWording(tweaked)).toHaveLength(1);
  });
});

describe("t-214 判据 4 · 闸不硬编码「现在冻结着」", () => {
  it("newWording 不问冻结开着没有：同一份输入，两种状态下答案一样", () => {
    const s = { ...sources(), "packages/core/src/events.ts": `const x = "冻结与否都该被数出来的一句新话";` };
    expect(newWording(s)).toHaveLength(1);
    // 它的函数体里不许出现 WORDING_FROZEN：闸只回答「多了哪几句」，据此拒不拒是调用方的事
    const body = /export function newWording[\s\S]*?\n}/.exec(readFileSync(join(ROOT, "packages/core/src/wording.ts"), "utf8"))![0];
    expect(body).not.toContain("WORDING_FROZEN");
  });

  it("冻结是一条可切换的事实，不是闸的一部分", () => {
    expect(typeof WORDING_FROZEN).toBe("boolean");
  });

  it("解冻之后同一个数仍然有用：它就是「这一批新增了几句人可见的话」", () => {
    const s = { ...sources(), "packages/core/src/events.ts": `const a = "解冻之后这一句仍然要被数出来";` };
    expect(newWording(s).length).toBe(1);
  });
});

describe("t-214 · 旁桶只减不增", () => {
  it("冻结期间已经落下的那些进具名旁桶，pd 逐条裁掉一条就删一条", () => {
    expect(WORDING_ADDED_DURING_FREEZE.length).toBeGreaterThan(0);
    for (const h of WORDING_ADDED_DURING_FREEZE) expect(h).toMatch(/^[0-9a-f]{12}$/);
    // 旁桶与快照不许重叠：一条话只能属于一边，否则「只减不增」数不清
    const snap = new Set(WORDING_AT_FREEZE);
    expect(WORDING_ADDED_DURING_FREEZE.filter((h) => snap.has(h))).toEqual([]);
  });

  it("快照存的是指纹不是原文：快照文件自己不含任何一句人可见的话", () => {
    const src = readFileSync(join(ROOT, "packages/core/src/wording.ts"), "utf8");
    const own = measureWording({ "packages/core/src/wording.ts": src });
    expect(own, `快照若存原文，它就成了每一句话的第二个出处，而且扫描器会把整份快照再数一遍：\n${own.map((w) => w.text).join("\n")}`).toEqual([]);
  });

  it("指纹认的是那句话本身：一字不差同一个指纹，差一个字就不同", () => {
    expect(wordingHash("一句话")).toBe(wordingHash("一句话"));
    expect(wordingHash("一句话")).not.toBe(wordingHash("一句话。"));
  });
});

describe("t-211 判据 2 · 节点自报的构建版本进牌桌，但只出数据不出话", () => {
  it("没自报过就是 null，自报过就是那个 sha——两者分得开", async () => {
    const { MemoryStore, append, reduce, board, NODE_SURFACE } = await import("../src/index.js");
    const s = new MemoryStore();
    const at = (m: number) => new Date(Date.now() + m * 60_000);
    await append(s, { kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev"] }, { human: "human", now: at(-100) });
    await append(s, { kind: "reading", actor: "dev", surface: NODE_SURFACE, key: "dev:cli.sha", value: "abc1234" }, { human: "human", now: at(-10) });
    const b = board(reduce(await s.read(), at(0)), "human", at(0));
    const row = (r: string) => b.presence.find((x) => x.actor === r);
    expect(row("dev")?.cli_sha).toBe("abc1234");
    expect(row("pm")?.cli_sha ?? null).toBeNull();     // 没自报过：null，不是空字符串也不是「最新」
  });
});
