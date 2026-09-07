/**
 * t-143：**人可见的每一句话，在 core 有唯一的一处出处。**
 *
 * pd 05:50 的位置规则，和 pd 08:55 补的那半：i18n.ts 也算第二处——同一句话要同时服务牌桌与命令行，而两处唯一
 * 共有的是 core，**集中不等于唯一**。今晚已经因为「一句话住在两个地方」出过四个缺陷（t-126、t-133、t-142、
 * t-146），每一次都是其中一处改了、另一处没跟上。
 *
 * 这里不做一次性搬家（pd 08:55）：存量冻成一个**只减不增**的数，新增一律进 core。搬家按需发生——碰到哪一句
 * 就搬哪一句，改一句搬一句。所以这份东西的价值不在它今天覆盖了多少，而在**那个数不会再变大**。
 */

/**
 * 人可见的话此刻还住在 core 之外的地方。每一处都是一次「同一句话的第二个家」。
 *
 * 说明书（`packages/core/manual/*.md`）不在这里：它是模板，整份都是给人读的字，数它的「中文字面量」没有意义；
 * 它与 core 的重复由另一条闸守着（t-179：core 里任何一句人可见的话在说明书里逐字出现第二份就红）。
 */
export const SECOND_HOMES = [
  "packages/server/src/i18n.ts",
  "packages/cli/src/format.ts",
  "packages/server/src/html.ts",
] as const;

/**
 * 冻结的存量：上面那几处此刻还剩多少条人可见的中文字面量。**这个数是算出来的，不是数出来的**（判据 8）——
 * build.test.ts 里那条闸用同一段扫法重新算一遍，比这个数大就红。
 *
 * 今晚 KEY_SYMBOLS 手写漏了将近一半（21→41），而在改成算出来之前没有任何迹象表明它不全。所以这个数每次变小，
 * 都要有人把它改小，**改小是搬迁的记账动作，不是可选项**：它只许变小，变大就是闸失效（判据 10）。
 */
// t-180 搬走 4 句：页面那份 ago 梯子的四档（「刚刚」「N 分钟前」「N 小时前」「N 天前」）现在在 core 一处。
// t-144 再搬走 2 句：html.ts 那个 `aria-label="邀请链接"` ⇒ INVITE_URL_LABEL，以及「例如 {值}」⇒ exampleLine。
// html.ts 到此为 0——**它是第一个搬空的**，而它本来就只剩两句：页面早就走 UI.* 了，真正的存量在 i18n.ts 与 format.ts。
export const SECOND_HOME_FROZEN: number = 205;
/**
 * 各处的分布，留着是为了让下一个人一眼看出搬走的是哪一处。冻结时是 i18n.ts 173、format.ts 36、html.ts 2；
 * t-180 把页面那份 ago 梯子的四档搬进 core，i18n.ts 173 → 169。这几个数用 `humanSentences` 量出来再填，不手写。
 */
export const SECOND_HOME_AT_FREEZE = { "packages/server/src/i18n.ts": 169, "packages/cli/src/format.ts": 36, "packages/server/src/html.ts": 0 } as const;

/**
 * 一条人可见的话在 core 里的登记。
 *
 * `key` 唯一；`where` 说它出现在哪儿（挖层、卡、命令行……），因为 pd 05:50 那条规则要的是「每个状态指名它的
 * key 与位置」——一句话没有位置，就没人知道改它会动到谁眼前的什么。
 */
export interface Saying {
  key: string;
  /** 它出现在哪儿。给要改它的人看的，也给检查用：一句没有位置的话不该被渲染成话。 */
  where: readonly ("board" | "card" | "cli" | "page" | "manual" | "reject")[];
  /** 这一句现在的出处：core 里的符号名。搬迁完成后，这里就是它唯一的家。 */
  from: string;
}

/**
 * 已经登记的话。**这份表只增不改**：一个 key 一旦存在，它指的就永远是同一句话（id 永远不改，同 CLAUDE.md）。
 *
 * 它今天不全，而且不假装全——`SECOND_HOME_FROZEN` 那个数就是「还有多少句没进来」的诚实计量。
 */
export const SAYINGS: readonly Saying[] = [
  { key: "batch.deployed", where: ["page", "cli"], from: "BATCH_LINES.deployed" },
  { key: "batch.shipped", where: ["page", "cli"], from: "BATCH_LINES.shipped" },
  { key: "batch.stale", where: ["page", "cli"], from: "BATCH_LINES.stale" },
  { key: "batch.rollback", where: ["page", "cli"], from: "BATCH_LINES.rollback" },
  { key: "batch.unknown", where: ["page", "cli"], from: "BATCH_LINES.unknown" },
  { key: "batch.none", where: ["page"], from: "BATCH_LINES.none" },
  { key: "reach.unread", where: ["page", "cli"], from: "REACH_WORDS.unread" },
  { key: "reach.read", where: ["page", "cli"], from: "REACH_WORDS.read" },
  { key: "reach.acted", where: ["page", "cli"], from: "REACH_WORDS.acted" },
  { key: "reach.rule", where: ["manual"], from: "REACH_RULE" },
  { key: "impact.none", where: ["reject", "manual"], from: "NO_HUMAN_IMPACT" },
  { key: "gate.shows.blind", where: ["board"], from: "SHOWS_GATE_BLIND" },
  { key: "reading.said", where: ["page", "cli"], from: "sayReading" },
  { key: "missing.card", where: ["card"], from: "missingCard" },
  { key: "owed.by_presence", where: ["board", "cli"], from: "overdueByPresence" },
  { key: "seam.same_file", where: ["board", "cli"], from: "SEAM_SAME_FILE" },
  { key: "seam.light", where: ["board", "cli"], from: "lightSeamLine" },
  { key: "who.also_here", where: ["cli"], from: "alsoHere" },
  { key: "who.nobody", where: ["cli"], from: "nobodyElse" },
  { key: "invite.url_label", where: ["page"], from: "INVITE_URL_LABEL" },
  { key: "token.example", where: ["page"], from: "exampleLine" },
];

/** t-143 判据 1：一个 key 只登记一次——重复的 key 意味着两句话共用一个名字，改一个会动到另一个。 */
export function duplicateKeys(): string[] {
  const keys = SAYINGS.map((x) => x.key);
  return [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
}

/**
 * t-178：**人可见的数据字段。** 一个函数读了它们并据以选择输出，它就在决定「人看到哪句话」。
 *
 * pd 08:22 的口径有两半：那句话是什么、哪句话出现在哪儿。第二半按名字数不出来——qa 08:54 证明过：
 * `inFlightGroups` 决定在途每一行印「这件干了什么」还是任务标题，**一个中文字面量都没有**。
 *
 * 所以第二半从**登记**推出来，不从名字数出来：这里登记人可见的字段，`SAYINGS` 登记人可见的话，
 * 读前者或在后者之间做选择的函数，就是在决定人看到什么。**加一个字段进来，认得出的范围随之变大**——
 * 这正是 t-143 建这张表的用处。
 */
export const HUMAN_FIELDS = ["shows", "title"] as const;

/**
 * t-178：core 里装着给人看的话的那几个文件——**那道闸扫的就是这几个**（build.test.ts），一处声明两处读。
 *
 * 我试过把它们也当成「碰了就算人可见」（像渲染文件那样），**改完就撤回了**，两个理由都是跑出来才知道的：
 * ① qa 已经验过「app.ts + reduce.ts」是一种纯内部形状、必须过；把 reduce.ts 算进来，那条当场红——**改一条
 *    已经被验过的行为，得先说服判它的人，不能顺手带过**。
 * ② 更糟的是它会重新打开一个刚堵上的洞：这几个文件一旦享有具名出路，`events.ts#BATCH_LINES` 就又能用
 *    `--internal-only` 解释掉了，而那正是 qa 08:46 判不过我的那一条。
 *
 * 所以留下的口径是符号级：`board.ts#inFlightGroups` 算，光写 `board.ts` 不算。**残留的缺口我说在明处**：
 * `done` 量出来的触点是路径、符号要人自己写，所以只声明路径的人仍然过得去。要不要收，归 pm。
 */
export const SENTENCE_FILES = [
  "packages/core/src/board.ts",
  "packages/core/src/events.ts",
  "packages/core/src/reduce.ts",
  "packages/core/src/allocation.ts",
  "packages/core/src/sayings.ts",
] as const;

/** t-178：这几张表本身只是名字的清单，引用一个名字不算「决定」——不排除它们，它们会把自己算进去。 */
export const REGISTRY_SYMBOLS = ["KEY_SYMBOLS", "SAYINGS", "SECOND_HOMES", "LITERAL_CHECK_BLIND_SPOTS", "HUMAN_FIELDS", "REGISTRY_SYMBOLS"] as const;

/**
 * t-143 判据 3：**这条检查唯一的例外，是构造性的，不是判出来的。**
 *
 * 从日志原样带出的内容——note 正文、证据、任务标题、人自己写的那些字——在渲染方的源码里**按构造就不是字面量**：
 * 它们是运行时经变量流进来的。所以这条检查只看渲染文件自己源码里的字符串字面量，例外自动成立，不需要任何
 * 「这一处放过」的分支——而一条靠人看的例外，要么误伤要么被绕。
 */
export const PASSTHROUGH_IS_NOT_A_LITERAL =
  "从日志带出来的字（note 正文、证据、任务标题）是运行时经变量流进来的，不是渲染方源码里的字面量，所以这条检查看不到它们——例外是构造出来的，不是判出来的。";

/**
 * t-143 判据 4：**这条检查看不见什么，说在明处。**
 *
 * 三个都不是理论上的：① 与 ② 今晚都真出现过（t-162 那 11 处就是从常量拼出来的句子），③ 是这条检查按定义
 * 只认中文的直接后果。
 */
export const LITERAL_CHECK_BLIND_SPOTS = [
  "拼出来的中文：`「共」 + n + 「件」` 这种，每一片都短到不像一句话，合起来才是。",
  "从常量组装的句子：片段在 core、拼装在渲染方——片段合规，成品仍然住在第二处。",
  "英文的人可见文案：这条检查只认中文，英文的人可见字它一个都抓不到。",
  "往一条已有的模板串里再插一段中文：字面量数不动，而人多读到一句。数中文段（i18n.ts 会是 197 而不是 173）能抓住它；换不换档由 pm 定。",
] as const;

/**
 * t-143 判据 8：**数句子，不数条目。** frontend 09:06 用五种读法证明它和我数的不是同一个东西，并指出了那条轴：
 * `UI.taskStatus` 是**一个条目、八句话**。按条目数，今天往它里面加第九种状态的说法，人会多读到一句，而那个数
 * 一动不动——**一个漏掉新增的数，冻住之后每一期都在报一个越来越假的数，而没有人会发现**。
 *
 * 口径是**每一处含中文的字符串字面量算一句**——frontend 09:06 的读法 A，也是 pm 09:07 定的基线（i18n.ts 173）。
 * 它满足 frontend 交来的那两条：往已有条目里加一句（多一条字面量）⇒ 变大；改 key 名、把一行拆成两行 ⇒ 不动。
 *
 * 我试过更细的一档（数字面量里每一段连续中文，i18n.ts 会是 197）。它多抓一种增长：**在一条已有的模板串里再插
 * 一段中文**，字面量数不动而人多读到一句。但我没有采用——frontend 刚用五种读法把口径对齐到这一层，我再自行换
 * 一档，等于把它刚收拾完的混乱重开一次。那一种增长记进下面的盲点清单，要换档由 pm 定，不由我一个人换。
 *
 * 这里手写一个扫描器而不是用正则：正则数不对带 `${}` 的模板串与转义引号，我第一次报的 154 / 20 就是这么来的，
 * 五种读法里没有一种能复现它——**一个谁也复现不出的数，冻它没有意义**。
 */
export function humanSentences(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // 注释整段跳过：注释写给读代码的人，不渲染给牌桌上那个人
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    // 正则字面量整段跳过。不跳它，`/[&<>"']/g` 里那个引号会被当成字符串开头，**从那里往后整份文件都数不到**
    // ——html.ts 第 954 行正是这一处，我第一版报的 1 与 2 都是这样丢出来的。判断 `/` 是正则还是除号，用它前面
    // 最后一个非空字符：那些位置后面不可能是除号。
    if (c === "/") {
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      if (k < 0 || "(,=:[!&|?{};+-*%^~".includes(src[k]) || /\breturn$|\bcase$|\btypeof$/.test(src.slice(Math.max(0, k - 7), k + 1))) {
        i++;
        let cls = false;
        while (i < n) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === "[") cls = true;
          else if (src[i] === "]") cls = false;
          else if (src[i] === "/" && !cls) { i++; break; }
          else if (src[i] === "\n") break;   // 不是正则，是别的：让外层继续
          i++;
        }
        continue;
      }
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let text = "";
      i++;
      while (i < n) {
        if (src[i] === "\\") { text += src[i + 1] ?? ""; i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // 模板串里的 ${...} 是代码不是字——但**它里面还可以有字面量**（`${x ? "在听" : "缺人"}` 这种），
        // 那两句照样是人会读到的话。所以这一段递归再扫一遍，不是整块丢掉：丢掉它，format.ts 就少数三句。
        if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
          const from = i + 2;
          let depth = 1; i += 2;
          while (i < n && depth) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
          out.push(...humanSentences(src.slice(from, i - 1)));
          continue;
        }
        text += src[i++];
      }
      if (/[一-龥]/.test(text)) out.push(text);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * t-179：**说明书里不许有 core 那些句子的第二份。**
 *
 * 今晚这已经是第三次逐句去钉了：t-141 钉「你欠什么」那一段、t-145 钉 watch 的秒数、现在是第 6 步那一段。三次
 * 都是同一条毛病——一句话有两份、分开手工维护，于是改了行为忘了说明书，说明书就在教旧话，而**没有任何东西会红**。
 * 逐句钉的做法本身就带着这条毛病：下一句被抄进去时，没人记得再钉一次。所以这里把它换成一个通用的量法。
 *
 * 量的是**说明书的源文件**，不是填好的说明书：`{{reach_rule}}` / `{{shows_rule}}` 填进去的那份是**唯一出处的正确
 * 用法**，不是拷贝；源文件里只有占位符，所以正确的做法自动不被算成拷贝，不需要写例外。
 *
 * 只比中文散文，不比命令名与开关：`ateam task claim <id> --touches` 在两边一模一样是**应该的**（命令名就是那个
 * 名字，项目规矩也说命令名照原样）。所以先从 core 的句子里切出纯中文（含中文标点）的段落，再在其中找与说明书
 * 重合的最长一段——重合到 `MANUAL_COPY_MIN` 个字，就当它是抄的。
 */
export const MANUAL_FILES = ["common.md", "invite.md", "welcome.md"] as const;
/** 重合多少个中文字算抄。8 个字以下多半是「人现在能看到什么」这类共用的参数名，不是一句话。 */
export const MANUAL_COPY_MIN = 8;

export interface ManualCopy {
  /** core 里哪个文件的句子 */
  from: string;
  /** 说明书里的哪一份（相对 manual/ 的路径） */
  manual: string;
  /** 重合的那一段字 */
  text: string;
}

/** `s` 里与 `text` 重合的最长一段（按字符数）。两边都很短，直接扫。 */
function longestShared(s: string, text: string): string {
  const a = [...s];
  let best = "";
  for (let i = 0; i < a.length; i++) {
    let j = i + best.length;
    while (j < a.length) {
      const c = a.slice(i, j + 1).join("");
      if (!text.includes(c)) break;
      best = c;
      j++;
    }
  }
  return best;
}

/** 一句话里纯中文（含中文标点）的那些段落。命令名、开关、占位符都会把一段切断，所以它们不参与比对。 */
const PROSE = /[一-龥「」『』，。；：、？！…（）《》]+/g;

/**
 * core 的这些源码里，有哪些句子被逐字抄进了说明书。`cores` 与 `manuals` 都是「名字 → 源码」，由调用方读进来，
 * 所以这个函数本身不碰文件系统，测试能拿构造的输入证明它红得对、绿得对。
 */
export function manualCopies(cores: Record<string, string>, manuals: Record<string, string>, min = MANUAL_COPY_MIN): ManualCopy[] {
  const out: ManualCopy[] = [];
  const seen = new Set<string>();
  for (const [from, src] of Object.entries(cores)) {
    for (const s of new Set(humanSentences(src))) {
      for (const run of s.match(PROSE) ?? []) {
        for (const [manual, text] of Object.entries(manuals)) {
          const shared = longestShared(run, text);
          if ([...shared].length < min) continue;
          const k = `${from} ${manual} ${shared}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ from, manual, text: shared });
        }
      }
    }
  }
  return out.sort((a, b) => [...b.text].length - [...a.text].length || a.from.localeCompare(b.from));
}

/**
 * 此刻还剩多少份这样的拷贝。**只减不增**，和 `SECOND_HOME_FROZEN` 同一个棘轮：比这个数多就红（有人又抄了一句），
 * 比这个数少也红（搬走了却没把这个数改小，下一个人会以为还欠这么多）。
 *
 * 为什么不是 0：今晚清了第 6 步与第 3.5 步（t-179 判据 1）。其余几处分布在 welcome.md 与角色说明书里，措辞归 pd，
 * 不该由我顺手改；**但从这一刻起，新抄一句会当场红**，这正是判据 2 要的——不再一句一句地钉。剩下的清单由
 * `manualCopies()` 现算，不另存一份名单：一份名单与它描述的东西分开维护，正是这件任务的由来。
 */
export const MANUAL_COPIES_FROZEN: number = 10;
