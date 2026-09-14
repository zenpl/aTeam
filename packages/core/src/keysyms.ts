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
import { SAYINGS, HUMAN_FIELDS, REGISTRY_SYMBOLS, literals } from "./sayings.js";

const CJK = /[一-龥]/;
/**
 * t-184：**这里原来还有半条「至少 6 个字符」，去掉了。**
 *
 * 去掉不是把 6 调小。长度当初防的是把 `"、"`、`"："` 这种标点当成话——但判定里那个 `CJK` 是 `[一-龥]`，中文标点
 * 根本不在这个区里（它们在 U+3000 段与全角段），**挡标点的一直是 CJK 那一条，长度是多余的**。而它多余之外还有
 * 害：按钮上的字天生就短。qa 09:52 说的「人在牌桌上唯一能动手的那一层」全在门槛底下——点「对」、点「记下」、
 * 点「先不做」，把「对」改成「确认」，人点的东西变了，而闸说没变。它拦得住改一句长解释，拦不住改一个按钮。
 *
 * frontend 10:01 更正过一次口径：那个 6 数的是**字面量的字符数**（汉字、空格、`${…}` 一起算），不是汉字数。
 * 所以「例如 ${value}」2 个汉字 11 字符、看得见，「邀请链接」4 字符、看不见——要调的本来就是长度这个参数。
 * 结论没变：调数字还是在猜，去掉是把当初那条理由交还给真正在守它的那个判定。
 *
 * 留下的口径就一条：**这段代码里有一个汉字字面量，它就是在说人话。**残留的风险说在明处：一条只用来匹配、
 * 不用来显示的中文字面量也会被算进来。此刻 core 里没有这种（`classifyFollowUp` 那三个词是它的返回值，是显示的；
 * 匹配用的 `CORRECTION_RE` 是正则字面量，这段扫法只读引号里的东西，按构造看不见它）。真出现了，修法是把它写成
 * 正则或登记进 SAYINGS，**不是把长度那半条请回来**。
 */
export const SPEAKING_MIN_CHARS = 1;

/** 注释整段抹成空白（保留长度，位置不变），因为注释是写给读代码的人的，不渲染给牌桌上那个人。 */
const blankComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

/**
 * pd 08:22 那两半里的第一半：**那句话是什么。**函数体或常量里含给人看的整句中文的符号。
 *
 * frontend 09:27：归属按**顶层声明**算，导出与否都算——非导出的函数紧跟在一个导出常量下面时，它那几句会被记在
 * 常量头上（`honestyLine` 的 6 句记在了 `nobodyElse` 上）。只认行首、不缩进的声明：函数体里的局部 `const`
 * 不是谁碰得到的符号，算进来会得到一堆 `a`、`line`、`rest`——那是另一种「名单看着很全」。
 */
/**
 * `min` 让同一段代码能用**另一把尺子**再量一遍——pd 10:34 那条规矩要的就是这个：换尺子时，两个数要由同一棵树、
 * 同一段代码算出来并排放着，否则「换了尺子」会藏住真增长。默认是此刻的口径。
 */
export function speaking(sources: Record<string, string>, min = SPEAKING_MIN_CHARS): string[] {
  const out = new Set<string>();
  for (const src0 of Object.values(sources)) {
    const src = src0.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const decls = [...src.matchAll(/^(?:export\s+)?(?:const|function)\s+(\w+)/gm)];
    for (let d = 0; d < decls.length; d++) {
      const from = decls[d].index!;
      const to = d + 1 < decls.length ? decls[d + 1].index! : src.length;
      // t-204：**按语言词法取字面量，不靠引号配对。** 上一版是一条配引号的正则，模板串里嵌一个引号就从那里
      // 开始错位：frontend 13:11 实测 `span` 那一段抽出 7 个片段、含汉字的 0 个，于是那几个人可见的词对这份
      // 名单是隐形的——而这个名单是「碰了它就不能说『不改变人看到的东西』」的依据。词法只有一处（sayings.ts
      // 的 `literals`），`humanSentences` 与这里共用它。
      const strings = literals(src.slice(from, to));
      if (strings.some((t) => CJK.test(t) && [...t].length >= min)) out.add(decls[d][1]);   // t-184: 默认门槛是 1，即「有一个汉字就算」
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
  const evidence = (body: string, self: string) =>
    HUMAN_FIELDS.some((x) => new RegExp(`\\.${x}\\b`).test(body)) ||
    [...froms].some((x) => x !== self && new RegExp(`\\b${x}\\b`).test(body));
  for (const src0 of Object.values(sources)) {
    const src = blankComments(src0);
    // t-264（pm 判据 8 裁 B）：**段边界认所有顶层声明，不只 `export`。**
    //
    // 旧版拿 `\nexport ` 当边界，于是夹在中间的非导出函数**整个折进上面那个 export 的身体里**。
    // frontend 09-07 09:27 报的就是这个形状，`speaking()` 那一半被 t-204 顺带修好了，这一半原样活了六天。
    const decls = [...src.matchAll(/^(?:export\s+)?(?:const|function)\s+(\w+)/gm)];
    const seg = decls.map((d, i) => ({
      name: d[1], exported: d[0].startsWith("export"),
      body: src.slice(d.index!, i + 1 < decls.length ? decls[i + 1].index! : src.length),
    }));
    for (const e of seg) {
      if (!e.exported || (REGISTRY_SYMBOLS as readonly string[]).includes(e.name)) continue;
      if (!/=>|function/.test(e.body.slice(0, 200))) continue;   // 只看函数：常量表引用一个名字不算「决定」
      // **只切段还不够，会往反方向错。** 四个错配的符号里 `manual` **真的调** `common()`，而 `manual` 生成的是
      // 角色手册那份人读的文档——只切段的话它会悄悄掉出闸外，那正是 pm 判据 7 里「静默放行」那个方向：
      // 没有人会来吵。所以**一个非导出 helper 的证据，算给正文里真的调用了它的那些导出**。
      const called = seg.filter((h) => !h.exported && new RegExp(`\\b${h.name}\\b`).test(e.body));
      if (evidence(e.body + called.map((h) => h.body).join("\n"), e.name)) out.add(e.name);
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
