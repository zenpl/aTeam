/**
 * t-186：**那份名单的生成器原来只存在于一条断言里。**
 *
 * `speaking()` 与 `deciding()` 写在 `build.test.ts` 内部，于是仓库里没有任何东西能「产出」名单，只能「检查」它。
 * 每个人的做法必然是同一种：手改到闸变绿。名单又是按每行六个排版的，所以任何一次增删都会重排整块——两个人各
 * 加一个名字，撞的不是逻辑，是排版。qa 10:11 量的：两小时撞了两次；到我合完 t-189 那一轮，我自己解到第五次。
 *
 * 所以这两段搬出测试，成为**能跑出名单的东西**：`ateam keysyms` 印出此刻应有的名单，`--write` 直接写回。
 * 冲突就从「两个人各改一行」变成「两个人各跑一次」——跑出来的结果一模一样，因为它是从源码算的。
 *
 * 名单本身仍然提交进仓库（判据 1 允许的另一半形态），理由是运行时：`touchesHumanVisible` 跑在服务端，那里只有
 * `dist/`，没有 `src/*.ts` 可读。所以名单是**生成物**而不是**运行时计算**；排版也改成一行一个、按字典序——
 * 两个人各加一个名字落在不同的行上，git 自己就合得了。
 *
 * 这个模块不碰文件系统：源码由调用方读进来（`Record<文件名, 源码>`），所以测试能拿构造的输入证明它认得对、
 * 也认得出它认不出什么。
 */
import { SAYINGS, HUMAN_FIELDS, REGISTRY_SYMBOLS } from "./sayings.js";

const CJK = /[一-龥]/;
/** 一句给人看的话至少这么长。t-184 正在改这条：按钮上的字（「对」「记下」）够不着它。 */
export const SPEAKING_MIN_CHARS = 6;

/** 注释整段抹成空白（保留长度，位置不变），因为注释是写给读代码的人的，不渲染给牌桌上那个人。 */
const blankComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

/**
 * pd 08:22 那两半里的第一半：**那句话是什么。**函数体或常量里含给人看的整句中文的符号。
 *
 * frontend 09:27：归属按**顶层声明**算，导出与否都算——非导出的函数紧跟在一个导出常量下面时，它那几句会被记在
 * 常量头上（`honestyLine` 的 6 句记在了 `nobodyElse` 上）。只认行首、不缩进的声明：函数体里的局部 `const`
 * 不是谁碰得到的符号，算进来会得到一堆 `a`、`line`、`rest`——那是另一种「名单看着很全」。
 */
export function speaking(sources: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const src0 of Object.values(sources)) {
    const src = src0.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const decls = [...src.matchAll(/^(?:export\s+)?(?:const|function)\s+(\w+)/gm)];
    for (let d = 0; d < decls.length; d++) {
      const from = decls[d].index!;
      const to = d + 1 < decls.length ? decls[d + 1].index! : src.length;
      const strings = [...src.slice(from, to).matchAll(/[`"']((?:[^`"'\\]|\\.)*)[`"']/g)].map((x) => x[1]);
      if (strings.some((t) => CJK.test(t) && [...t].length >= SPEAKING_MIN_CHARS)) out.add(decls[d][1]);
    }
  }
  return [...out].sort();
}

/**
 * pd 08:22 那两半里的第二半：**哪句话出现在哪儿。**
 *
 * 它从登记推出来，不从名字数出来：读 `HUMAN_FIELDS` 里那些人可见字段的，或在 `SAYINGS` 登记过的话之间做选择的，
 * 都是在决定人看到什么。qa 08:54 用 `inFlightGroups` 证明按名字数这一类按定义数不出来——那个函数体里一个中文
 * 字面量都没有，代码是 `task?.shows ?? x.title`。
 */
export function deciding(sources: Record<string, string>): string[] {
  const froms = new Set(SAYINGS.map((x) => x.from.split(".")[0]));
  const out = new Set<string>();
  for (const src0 of Object.values(sources)) {
    const src = blankComments(src0);
    for (const m of src.matchAll(/export (?:const|function) (\w+)/g)) {
      if ((REGISTRY_SYMBOLS as readonly string[]).includes(m[1])) continue;
      const next = src.indexOf("\nexport ", m.index! + 1);
      const body = src.slice(m.index!, next < 0 ? src.length : next);
      if (!/=>|function/.test(body.slice(0, 200))) continue;   // 只看函数：常量表引用一个名字不算「决定」
      const byField = HUMAN_FIELDS.some((x) => new RegExp(`\\.${x}\\b`).test(body));
      const bySaying = [...froms].some((x) => x !== m[1] && new RegExp(`\\b${x}\\b`).test(body));
      if (byField || bySaying) out.add(m[1]);
    }
  }
  return [...out].sort();
}

/** 此刻 core 里会说人话、或决定人看到什么的每一个符号。两个方向的并，字典序——名单该长什么样，就由这里说了算。 */
export function measureKeySymbols(sources: Record<string, string>): string[] {
  return [...new Set([...speaking(sources), ...deciding(sources)])].sort();
}

/** 名单在 `events.ts` 里的写法：**一行一个**，所以两个人各加一个名字落在不同的行上，git 自己就合得了。 */
export function renderKeySymbols(names: string[]): string {
  return names.map((n) => `  ${JSON.stringify(n)},`).join("\n");
}

/** `events.ts` 的源码里，把 KEY_SYMBOLS 那一块换成 `names`。找不到那一块就返回 null，绝不写出一个坏文件。 */
export function withKeySymbols(eventsSrc: string, names: string[]): string | null {
  const m = /export const KEY_SYMBOLS = \[\n[\s\S]*?\n\] as const;/.exec(eventsSrc);
  if (!m) return null;
  return eventsSrc.slice(0, m.index) + `export const KEY_SYMBOLS = [\n${renderKeySymbols(names)}\n] as const;` + eventsSrc.slice(m.index + m[0].length);
}
