/**
 * t-185：**一道「扫描某些文件」的闸，它的范围要算出来，不许手写名单。**
 *
 * 今晚同一个形状出现了三次，三次都是名单：t-143 的扫描器（整份文件失明，已修）、t-180 那条 ago 梯子的
 * `roots`（写死两个目录、还不进子目录）、`SECOND_HOME_FROZEN`（只盯手写的三个文件）。qa 10:01 的证伪方式对三者
 * 都成立、也最省事：**往它范围之外加一句，它必须红**。名单外当时还有 16 个文件、158 句，其中包括发到人手机上的
 * 失联告警——而 pd 08:55 那个「只减不增的数」正建立在这份名单上，名单少一半，那个数就是假的。
 *
 * 这里的注入是**在内存里做的**：范围与计数都从「文件名 → 内容」算出来，所以往任何一个文件里塞一句话不用改磁盘，
 * 每个在范围里的文件都能逐个证一遍，而不是挑一个代表。判据 2 要的就是这个。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sourceFiles, isSecondHome, CORE_SRC, SECOND_HOMES_ROOT, SECOND_HOME_FROZEN, SECOND_HOME_AT_FREEZE, humanSentences, manualFiles, manualCopies, KEY_SYMBOLS } from "../src/index.js";

const repo = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const read = (p: string) => readFileSync(`${repo}/${p}`, "utf8");
const all = () => sourceFiles(`${repo}/${SECOND_HOMES_ROOT}`, SECOND_HOMES_ROOT);
const homes = () => all().filter(isSecondHome);
/** 存量的计数，可以对任意一个文件覆盖内容——注入就是往某个文件后面加一句人可见的中文。 */
const total = (inject: Record<string, string> = {}) =>
  homes().reduce((n, f) => n + humanSentences(read(f) + (inject[f] ?? "")).length, 0);

const A_SENTENCE = '\nconst 探针 = "这是一句注入进来的、人会读到的中文。";\n';

describe("t-185 判据 1 · 范围是走出来的", () => {
  it("从仓库布局走到每一个源码文件：不要测试，不要产物，进子目录", () => {
    const files = all();
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      expect(f, "扫到了非源码").toMatch(/^packages\/[^/]+\/.+\.ts$/);
      expect(f, "扫到了测试文件").not.toMatch(/\.(test|spec)\.ts$/);
      expect(f, "扫到了产物或依赖").not.toMatch(/(^|\/)(dist|node_modules)\//);
    }
    // 进得了子目录：core 的 src 底下有目录时也走得到（这条断言防的是 readdirSync 不递归那一版）
    expect(files.some((f) => f.split("/").length > 3)).toBe(true);
  });

  it("「第二个家」是位置判出来的，不是名单：core 之外的 src 源码都算，core 自己不算", () => {
    expect(isSecondHome("packages/server/src/i18n.ts")).toBe(true);
    expect(isSecondHome("packages/cli/src/format.ts")).toBe(true);
    expect(isSecondHome("packages/server/src/deep/nested/thing.ts")).toBe(true);
    expect(isSecondHome(`${CORE_SRC}/board.ts`)).toBe(false);          // core 是唯一的家
    expect(isSecondHome("packages/server/test/html.test.ts")).toBe(false);
    expect(isSecondHome("packages/server/src/x.test.ts")).toBe(false);
    expect(isSecondHome("packages/core/manual/common.md")).toBe(false); // 说明书归 t-179 那道闸
    // 新加一个包，它当场在范围里——这正是名单做不到的那一半
    expect(isSecondHome("packages/brand-new/src/words.ts")).toBe(true);
  });

  it("qa 10:01 点名的那 16 个文件现在在范围里，不再是名单外", () => {
    const inScope = homes();
    for (const f of ["packages/server/src/app.ts", "packages/cli/src/trace.ts", "packages/cli/src/release.ts",
                     "packages/cli/src/main.ts", "packages/cli/src/touches.ts", "packages/cli/src/seamcheck.ts",
                     "packages/server/src/alerts.ts"]) {
      expect(inScope, `${f} 还在范围外`).toContain(f);
    }
    // 发到人手机上的那句失联告警就在 alerts.ts 里——那是这件任务最急的理由（判据 3）
    expect(humanSentences(read("packages/server/src/alerts.ts")).length).toBeGreaterThan(0);
  });
});

describe("t-185 判据 2 · 往范围之外加一句，它必须红", () => {
  it("范围里的每一个文件都证一遍：加一句，那个数就多一句", () => {
    const base = total();
    expect(base).toBe(SECOND_HOME_FROZEN);
    for (const f of homes()) {
      expect(total({ [f]: A_SENTENCE }), `往 ${f} 里加一句，存量没变——这个文件此刻在范围外`).toBe(base + 1);
    }
  });

  it("这正是旧名单看不见的那一类：老名单只有三个文件，往第四个里加一句它一动不动", () => {
    const OLD_LIST = ["packages/server/src/i18n.ts", "packages/cli/src/format.ts", "packages/server/src/html.ts"];
    const oldTotal = (inject: Record<string, string> = {}) =>
      OLD_LIST.reduce((n, f) => n + humanSentences(read(f) + (inject[f] ?? "")).length, 0);
    const outside = "packages/server/src/alerts.ts";
    expect(homes()).toContain(outside);
    expect(oldTotal({ [outside]: A_SENTENCE })).toBe(oldTotal());          // 旧名单：全绿，什么都没发生
    expect(total({ [outside]: A_SENTENCE })).toBe(total() + 1);            // 现在：红
  });

  it("core 里加一句不算——那是唯一的家，不是第二个家", () => {
    expect(total({ [`${CORE_SRC}/board.ts`]: A_SENTENCE })).toBe(total());
  });
});

describe("t-185 判据 4 · 那个数变大过一次，是口径变更不是闸失效", () => {
  it("新基线由这一份范围算出来，冻结值与它逐字相等", () => {
    expect(total()).toBe(SECOND_HOME_FROZEN);
  });

  it("分布也是量出来的：每一处都不比冻结时多，合计等于那个数", () => {
    let sum = 0;
    for (const [f, n] of Object.entries(SECOND_HOME_AT_FREEZE)) {
      expect(humanSentences(read(f)).length, `${f} 与冻结时的分布对不上`).toBeLessThanOrEqual(n);
      sum += n;
    }
    expect(sum, "分布的合计与冻结值对不上").toBe(SECOND_HOME_FROZEN);
    // 范围里每一个有话的文件都在分布里：漏一个，那一处就又成了名单外
    for (const f of homes()) {
      if (humanSentences(read(f)).length === 0) continue;
      expect(Object.keys(SECOND_HOME_AT_FREEZE), `${f} 有人可见的话，却不在冻结分布里`).toContain(f);
    }
  });
});

/**
 * t-185 判据 2 的另外两道闸。三道闸同一个毛病、同一种证伪：**往它范围之外加一句，它必须红。**
 *
 * · KEY_SYMBOLS 那道（build.test.ts）：原来只扫 core 里手写的四个 / 七个文件名，rules.ts 不在里面——而拒绝话
 *   就是人读的字，那一份漏了 11 个会说人话的符号。
 * · 说明书拷贝那道（t-179）：原来是「手写三份 md，roles/ 再走一遍」，同一份范围写在两处。
 * · ago 梯子那道（server 的 ago-one-ladder.test.ts）：roots 写死两个目录且不进子目录，core/src 整个看不见。
 *   它在 server 包里，证伪写在它自己旁边。
 */
describe("t-185 判据 2 · 另外两道闸的范围也走出来了", () => {
  const coreFiles = () => sourceFiles(`${repo}/${CORE_SRC}`, CORE_SRC);

  it("KEY_SYMBOLS 那道闸现在扫得到 core 里每一个源码文件，rules.ts 不再在范围外", () => {
    const files = coreFiles();
    expect(files).toContain(`${CORE_SRC}/rules.ts`);
    expect(files).toContain(`${CORE_SRC}/manual.ts`);
    expect(files).toContain(`${CORE_SRC}/scan.ts`);
    // 范围扩到 rules.ts 之后量出来的那 11 个，此刻都在名单里；漏一个，碰了它的活就能说「不改变人看到的东西」
    for (const sym of ["PASS_ONLY_GATE", "checkShape", "humanImpactPromised", "validate", "validateTask",
                       "verifierEligibility", "whoCanVerify", "standInBlocker", "valueForm", "SHAPE_OF", "manual"]) {
      expect(KEY_SYMBOLS as readonly string[], `${sym} 会说人话却不在 KEY_SYMBOLS 里`).toContain(sym);
    }
  });

  it("说明书的范围是走出来的：roles/ 底下那几份与顶上那三份走的是同一条路", () => {
    const fake = (dir: string) => dir === ""
      ? [{ name: "common.md", dir: false }, { name: "roles", dir: true }, { name: "README.txt", dir: false }]
      : [{ name: "dev.md", dir: false }, { name: "pm.md", dir: false }];
    expect(manualFiles(fake)).toEqual(["common.md", "roles/dev.md", "roles/pm.md"]);   // 进子目录，且只要 .md
  });

  it("新加一份说明书，t-179 那道闸当场看得见它——不需要谁记得改名单", () => {
    const withNew = (dir: string) => dir === ""
      ? [{ name: "common.md", dir: false }, { name: "brand-new.md", dir: false }]
      : [];
    expect(manualFiles(withNew)).toContain("brand-new.md");
    // 而这份新说明书里若抄了一句 core 的话，manualCopies 报得出来
    const copied = manualCopies({ "src/x.ts": 'const a = "这是一句被抄进新说明书的、给人看的中文。";' },
                                { "brand-new.md": "前言。这是一句被抄进新说明书的、给人看的中文。后记。" });
    expect(copied).toHaveLength(1);
    expect(copied[0].manual).toBe("brand-new.md");
  });
});
