/**
 * t-143：人可见的每句话在 core 有唯一 key；渲染文件里不许再有中文字面量。
 *
 * pd 05:50 的位置规则加 pd 08:55 补的那半：i18n.ts 也算第二处，**集中不等于唯一**。今晚已经因为「一句话住在
 * 两个地方」出过四个缺陷（t-126、t-133、t-142、t-146）。不做一次性搬家：存量冻成一个只减不增的数。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { SAYINGS, SECOND_HOMES, SECOND_HOME_FROZEN, SECOND_HOME_AT_FREEZE, humanSentences, duplicateKeys, LITERAL_CHECK_BLIND_SPOTS, PASSTHROUGH_IS_NOT_A_LITERAL } from "../src/index.js";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");

describe("t-143 · key 表本身", () => {
  it("判据 1：一个 key 只登记一次，且每一条都指名它出现在哪儿", () => {
    expect(duplicateKeys()).toEqual([]);
    for (const s of SAYINGS) {
      expect(s.key, `${s.from} 没有 key`).toMatch(/^[a-z][a-z0-9_.]*$/);
      expect(s.where.length, `${s.key} 没说它出现在哪儿——一句话没有位置，就没人知道改它会动到谁眼前的什么`).toBeGreaterThan(0);
      expect(s.from.length).toBeGreaterThan(0);
    }
  });

  it("登记的每一句话，在 core 里真的找得到那个出处——不是一份对不上的目录", () => {
    // t-187（frontend 10:26）：这四个文件名原来是手写的，于是登记在 `sayings.ts` 里的出处一律「找不到」——
    // **这是 t-185 那一族的第五处**：扫描器的范围自己是手写的，名单外的一切它都当作不存在。改成走一遍
    // core/src，谁把句子放进哪个文件都算数。
    const core = readdirSync(new URL("../src/", import.meta.url))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => read(`packages/core/src/${f}`))
      .join("\n");
    for (const s of SAYINGS) {
      const symbol = s.from.split(".")[0];
      expect(core.includes(`export const ${symbol}`) || core.includes(`export function ${symbol}`) || core.includes(`function ${symbol}`), `${s.key} 指的 ${s.from} 在 core 里找不到`).toBe(true);
    }
  });
});

describe("t-143 · 存量只减不增（判据 8、10）", () => {
  it("那个数是算出来的，不是数出来的；比冻结值大就红", () => {
    const per = SECOND_HOMES.map((f) => [f, humanSentences(read(f)).length] as const);
    const total = per.reduce((n, [, c]) => n + c, 0);
    const detail = per.map(([f, c]) => `${f} ${c}`).join("、");
    expect(total, `人可见的话住在 core 之外的还有 ${total} 条（${detail}），冻结值是 ${SECOND_HOME_FROZEN}。变大就是闸失效：新增的话一律进 core`).toBeLessThanOrEqual(SECOND_HOME_FROZEN);
  });

  it("变小了就要把冻结值改小——搬迁的记账动作，不是可选项", () => {
    const total = SECOND_HOMES.reduce((n, f) => n + humanSentences(read(f)).length, 0);
    expect(total, `已经搬走了一些：现在是 ${total} 条，SECOND_HOME_FROZEN 还写着 ${SECOND_HOME_FROZEN}。把它改成 ${total}，否则这条闸留着一格永远用不掉的余量`).toBe(SECOND_HOME_FROZEN);
  });
});

describe("t-143 · 检查的边界（判据 3、4）", () => {
  it("判据 3：例外是构造出来的——从日志带出的字不是字面量，检查按定义看不到它", () => {
    // 一段渲染代码：人写的字经变量流进来，源码里一个中文字面量都没有
    const render = 'const html = `<li>${esc(note.body)}</li><b>${esc(task.title)}</b>`;';
    expect(humanSentences(render)).toEqual([]);
    expect(PASSTHROUGH_IS_NOT_A_LITERAL).toContain("例外是构造出来的");
  });

  it("注释不算：它写给读代码的人，不渲染给牌桌上那个人", () => {
    expect(humanSentences('// 这一段的理由：牌桌只说一句话\nconst a = 1;')).toEqual([]);
    expect(humanSentences('/** 多行注释里的中文也一样 */\nconst a = 1;')).toEqual([]);
  });

  it("判据 4：看不见的三种，写在明处，不靠人记得", () => {
    expect(LITERAL_CHECK_BLIND_SPOTS).toHaveLength(4);
    const all = LITERAL_CHECK_BLIND_SPOTS.join("");
    for (const w of ["拼出来的中文", "从常量组装", "英文", "模板串里再插一段中文"]) expect(all).toContain(w);
    // 这三种此刻确实抓不到，逐条验给自己看
    expect(humanSentences('const s = "共" + n + "件";').every((t) => [...t].length <= 1)).toBe(true);   // ① 每一片都短
    expect(humanSentences('const s = `${A}${B}`;')).toEqual([]);                                        // ② 片段在别处
    expect(humanSentences('const s = "Nothing was sent.";')).toEqual([]);                               // ③ 英文抓不到
  });
});

describe("t-143 · 判据 5：造一条就红，按 key 取就绿", () => {
  it("往渲染文件里写一句中文字面量：这条检查当场看见它", () => {
    const before = humanSentences(read("packages/server/src/html.ts")).length;
    const injected = read("packages/server/src/html.ts") + '\nconst 又一句 = "这一句是直接写在渲染文件里的";\n';
    expect(humanSentences(injected).length).toBe(before + 1);
    expect(humanSentences(injected)).toContain("这一句是直接写在渲染文件里的");
  });

  it("同一句话按 key 从 core 取：检查看不到它，因为渲染方源码里没有这句字面量", () => {
    const viaKey = 'out.push(`<li>${esc(UI_FROM_CORE.batchDeployed)}</li>`);';
    expect(humanSentences(viaKey)).toEqual([]);
  });
});

/**
 * frontend 09:06 交来的那两条，是这个口径的合同：**数不出第一条的算法，冻它没有意义。**
 *
 * 它用五种读法证明我和它数的不是同一个东西，并找到了那条轴——`UI.taskStatus` 是一个条目、八句话。按条目数，
 * 今天往它里面加第九种状态的说法，人会多读到一句，而那个数一动不动。
 */
describe("t-143 · 那个数的算法，按 frontend 09:06 的两条合同", () => {
  const base = 'const UI = { taskStatus: { pending: "待送达", delivered: "已送达" } };';

  it("该抓住的：往已有条目里加一句，数字必须变大", () => {
    const added = 'const UI = { taskStatus: { pending: "待送达", delivered: "已送达", gone: "已撤回" } };';
    expect(humanSentences(added).length).toBeGreaterThan(humanSentences(base).length);
  });

  it("不该误伤的：改 key 名、把一行拆成两行，数字必须不动", () => {
    const renamed = 'const UI = { statusOfTask: { a: "待送达", b: "已送达" } };';
    const split = 'const UI = {\n  taskStatus: {\n    pending: "待送达",\n    delivered: "已送达",\n  },\n};';
    expect(humanSentences(renamed).length).toBe(humanSentences(base).length);
    expect(humanSentences(split).length).toBe(humanSentences(base).length);
  });

  /**
   * 这条是**修复的证据**，不是记事：让扫描器失明的那个输入现在会被扫到。
   *
   * `html.ts:954` 有一句 `s.replace(/[&<>"']/g, …)`。第一版扫描器不认正则字面量，那个 `"` 被当成字符串开头，
   * **从那一行往后整份文件都数不到**。html.ts 的中文恰好都在 954 之前，所以数出来的 1 看着没错——它错在
   * 任何写在 954 之后的中文都不会被发现，而那正是这条闸要防的事。**「一整份文件不被扫到」的表现形式，
   * 就是「这份文件很干净」。**
   */
  it("正则字面量里的引号不再让扫描器失明——那一行之后的中文照样扫得到", () => {
    const input = `const esc = (s) => s.replace(/[&<>"']/g, (c) => c);\nconst x = "这一句写在正则之后";`;
    expect(humanSentences(input)).toEqual(["这一句写在正则之后"]);
    // 真文件上的同一件事：整份 html.ts 之后接一句，探针必须活着穿到末尾
    const probe = read("packages/server/src/html.ts") + '\nconst z = "探针中文";\n';
    expect(humanSentences(probe)).toContain("探针中文");
  });

  it("模板串里 ${…} 内部的字面量也算——它照样是人会读到的话", () => {
    expect(humanSentences('const s = `${x ? "在听" : "缺人"}`;')).toEqual(["在听", "缺人"]);
  });

  it("冻结时的分布留在 core 里，下一个人一眼看得出搬走的是哪一处", () => {
    for (const [f, n] of Object.entries(SECOND_HOME_AT_FREEZE)) {
      expect(humanSentences(read(f)).length, `${f} 与冻结时的分布对不上`).toBeLessThanOrEqual(n);
    }
    expect(Object.values(SECOND_HOME_AT_FREEZE).reduce((a, b) => a + b, 0)).toBe(SECOND_HOME_FROZEN);
  });
});

/**
 * t-143 判据 6 (pm 09:19)：**具名出路的退役条件是一个可测的状态，不是某件任务的状态。**
 *
 * 我原来交不了这一条：判据写的是「key 表落地后自动退役」，而 t-143 done 的那一刻表里只有一部分（19 句登记、
 * 211 句在外面），那时退掉出路等于回到文件级且无出路——碰了 html.ts 就只能写 shows，哪怕真的只删了一段死代码。
 * pm 把条件改成「那个只减不增的数归零时退役」：数归零就说明话都收进 core 了，出路当场失去理由，不需要谁记得
 * 去删它。
 */
describe("t-143 判据 6 · 出路自己退役，不靠谁记得", () => {
  it("那个数还大于零时，出路在", () => {
    expect(SECOND_HOME_FROZEN).toBeGreaterThan(0);
  });

  it("退役条件读的就是那个数，不是任何一件任务的状态", () => {
    const rules = read("packages/core/src/rules.ts");
    expect(rules).toContain("SECOND_HOME_FROZEN === 0");
    // 不许拿任务 id 当开关：那是「谁记得去删它」的另一种写法
    expect(rules).not.toMatch(/exitRetired[^\n]*t-1\d\d/);
  });

  it("那个数是被闸盯着的，所以它是真的——比实际大就红，改小是搬迁的记账动作", () => {
    const actual = SECOND_HOMES.reduce((n, f) => n + humanSentences(read(f)).length, 0);
    expect(actual).toBe(SECOND_HOME_FROZEN);
  });
});
