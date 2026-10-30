/**
 * t-185：**一道「扫描某些文件」的闸，它的范围要算出来，不许手写名单。**
 *
 * 今晚同一个形状出现了三次：t-143 的扫描器整份文件失明；t-180 那条 ago 梯子的 roots 只写了两个目录、还不进
 * 子目录；`SECOND_HOME_FROZEN` 只盯手写的三个文件——qa 10:01 用注入证过：往名单外的任何一个文件里加一句人可见的
 * 中文，三道闸全绿。名单外还有 16 个文件、158 句，**其中包括发到人手机上的失联告警**。
 *
 * 名单本身不是疏忽，是这类闸的固有毛病：**一份名单与它描述的东西分开维护，必然漂移**（今晚第五次，前四次是
 * t-108 的秒数、t-148 的命令、t-173 的开关、t-170 的 KEY_SYMBOLS）。所以这里只给一个走法：从仓库的布局出发
 * 走到每一个源码文件，谁都不用记得把新文件加进哪份名单。
 *
 * 这个模块碰文件系统，所以它不参与 core 那些纯函数的推演——它是给闸用的，闸本来就要读源码。
 */
import { readdirSync, statSync } from "node:fs";

/** 不走进去的目录：产物与依赖里没有人写的话。 */
const SKIP = new Set(["node_modules", "dist", ".git", "coverage"]);

/**
 * `root` 底下所有的源码文件，递归，路径相对 `root` 的父级前缀 `prefix` 拼出来（默认就是 `root` 自己）。
 * 只要 `.ts`，不要测试文件——测试里的中文是给读代码的人看的，不渲染给牌桌上那个人。
 */
export function sourceFiles(root: string, prefix = root): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries.sort()) {
    if (SKIP.has(e)) continue;
    const p = `${root}/${e}`;
    const rel = `${prefix}/${e}`;
    let dir: boolean;
    try { dir = statSync(p).isDirectory(); } catch { continue; }
    if (dir) out.push(...sourceFiles(p, rel));
    else if (e.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(e) && !e.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** core 自己的源码在哪儿。人可见的话的**唯一的家**就是这里，其余任何地方都是第二个家。 */
export const CORE_SRC = "packages/core/src";

/**
 * 这个文件算不算「人可见的话的第二个家」。
 *
 * 定义是**位置**，不是一份名单：`packages/<任何一个包>/src/` 底下的源码，除了 core 自己的。所以新加一个文件、
 * 新加一个包，它当场就在范围里；`SECOND_HOME_FROZEN` 那个只减不增的数因此是真的，而不是「我们记得去数的那几个」。
 */
export function isSecondHome(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  if (!/^packages\/[^/]+\/src\/.+\.ts$/.test(p)) return false;
  if (/\.(test|spec)\.ts$/.test(p) || p.endsWith(".d.ts")) return false;
  return !p.startsWith(`${CORE_SRC}/`);
}

/**
 * t-213：**表面名不许以裸字面量出现在「表面位置」上。**
 *
 * 此刻的形状：`HUMAN_SURFACE` 定义在 events.ts，而产品代码里读它的地方是 0 处（qa 在 t-132 上证过）——
 * 边界完全由散在各处的 `r.surface === "production"` 承担。名单只有一个元素时它漂不了；**多一个表面的那一刻，
 * 那些地方就是那么多个能各说各话的地方**，而且改一处漏一处没有任何东西会红。
 *
 * 这道闸只认**表面位置**，不认字面量本身：同一个 "production" 还可能是一个推送等级（PUSH_LEVELS）或一个分支名
 * （release 推到哪条分支），把那些一起收拢是错的。所以配的是 `surface` 这个字段名周围的写法，而不是那五个字。
 * **例外因此是构造出来的，不是判出来的**（与 PASSTHROUGH_IS_NOT_A_LITERAL 同一路子）：`export const
 * HUMAN_SURFACE = "production"` 这样的声明本来就不长这个样，用不着任何「这一处放过」的名单。
 */
export const SURFACE_NAMES = ["repo", "staging", "production"] as const;

/**
 * 这个文件算不算「产品源码」：`packages/<任何一个包>/src/` 底下的 .ts，测试与声明文件除外。**与 isSecondHome
 * 的差别只有一处：core 也算**——表面名散在 core 里和散在别处一样糟。范围同样是走出来的，不是名单：t-185 的账
 * （手写名单外 16 个文件 158 句，三道闸全绿）今晚已经付过一次，这里不再付第二次。
 */
export function isProductSource(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  if (!/^packages\/[^/]+\/src\/.+\.ts$/.test(p)) return false;
  return !/\.(test|spec)\.ts$/.test(p) && !p.endsWith(".d.ts");
}

const SURFACE_POSITIONS: RegExp[] = [
  // r.surface === "production" / surface !== "repo" / { surface: "production" }
  /\bsurface\s*(?:===|!==|==|:)\s*"(?:repo|staging|production)"/g,
  // "production" === r.surface（反着写的比较）
  /"(?:repo|staging|production)"\s*(?:===|!==|==)\s*[\w.]*\bsurface\b/g,
  // verified_on.includes("production")：按表面名比对的另一种写法
  /\bverified_on\b[^\n;]*"(?:repo|staging|production)"/g,
];

/**
 * 注释按空格抹掉（保留换行，行号才不会错位）。**闸读的是代码，不是注释**：一句解释这道闸的话里写着
 * `r.surface === "production"`，那不是一处判表面的代码——上面那段说明本身就会被自己抓住，第一版真的抓了 6 次。
 * 抹掉而不是跳过整行，是因为同一行上可能一半是代码一半是注释。
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** 源码里每一处「表面位置上的裸表面名」，按行号。空数组表示这份源码里一处都没有。 */
export function bareSurfaceLiterals(src: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  stripComments(src).split("\n").forEach((line, i) => {
    for (const re of SURFACE_POSITIONS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) out.push({ line: i + 1, text: m[0].trim() });
    }
  });
  return out;
}

/**
 * t-213 判据 2：**这道闸看不见什么，说在明处。** 三条都不是理论上的，每一条在 surface-name.test.ts 里都有一个
 * 会红的用例钉着——若哪天它们被收进来了，那些用例会告诉下一个人闸的范围变宽了，而不是让人以为一直如此。
 */
export const SURFACE_GATE_BLIND_SPOTS = [
  "经变量绕一手：`const s = \"production\"; if (r.surface === s)`——比较的两边都不是字面量，配不到。",
  "字段名不叫 surface：`verify(\"qa\", \"t-1\", \"repo\", true)` 这样按位置传的表面名，闸看不出第三个参数是个表面。",
  "默认值写法：`opts.surface ?? \"repo\"`——引号前面不是 surface 那个字段名，而它确实是一个表面位置。",
] as const;

/**
 * t-301：**不许把一个本项目的任务 id 写死在平台代码里——不分它写成常量还是实参。**
 *
 * 出处与边界是 qa 09:37 验 t-290 时量出来的，比「闸有缺口」说得准：那道闸按**形状**挡住「常量」那一种
 * （`const ACTED_RULE_TASK = "t-147"`），而写成实参（`ruleLiveAt(s, "t-147")`）闸绿；真正没有人挡住的是
 * **在别处新写死一个别的本项目 id**——它既不是常量形状，也不改任何已有行为，所以没有任何东西会红。
 *
 * 为什么一个写死的 id 是洞（t-290 付过的账）：第二个租户的日志里永远不会有一批含着 `t-147`，于是起算点恒算
 * 不出来，`owedFull` 据此「一条都不进旁桶」，**他们的全部历史落进活欠账**。一个写死的本项目 id，在别人的租户上
 * 是一个**静默失效的开关**。
 *
 * 所以这里不按名单、也不按文件名判，**按结构判**：任何整个值就是一个任务 id 的字符串字面量都算，除掉两种——
 * 注释里的例子（`stripComments` 抹掉），以及**落在标识符含 `sample` 的值里**的那些。
 */

/** 从 `at` 处开始的那一个「值」占到哪里（不含）。开头是 `{`/`[`/`(` 就配对到闭合，否则到同层的 `,`/`;`/换行。 */
function valueEnd(src: string, at: number): number {
  const open = "{[(", close = "}])";
  let i = at;
  while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
  const first = open.indexOf(src[i] ?? "");
  const stack: string[] = [];
  let quote: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    const o = open.indexOf(c);
    if (o >= 0) { stack.push(close[o]); continue; }
    if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length && first >= 0) return i + 1;      // 配对闭合，值到这儿结束
      continue;
    }
    if (!stack.length && first < 0 && (c === "," || c === ";" || c === "\n")) return i;
  }
  return src.length;
}

/**
 * 每一个「标识符含 `sample` 的值」占的那几段，按字符下标。两种起点都算，因为两种都是「某个叫 sample… 的东西
 * 的值」：① `sample: {...}` / `const sampleX = [...]`（赋值与属性）；② `function sampleBuilder(...) {...}`
 * （函数名也是标识符，它的体就是它的值——`core/src/fixture.ts` 那份样本日志整个落在这一种里）。
 *
 * **为什么是「含 sample」而不是等于 `sample`**：pm 08:48 先定的是命名规则，而我 09:0x 量出它会拆掉
 * `fixture.ts:29` 那条不变量（声明与样本写在同一处，所以加一条声明就自动多一条样本，不会漂移）；
 * pm 据此把判据改成按结构，并写明那条不变量比它那条命名规则值钱。
 */
export function sampleExtents(src: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const add = (name: string, from: number) => {
    if (/sample/i.test(name)) out.push({ from, to: valueEnd(src, from) });
  };
  for (const m of src.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*[:=](?![=>])\s*/g)) add(m[1], m.index! + m[0].length);
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]*)?(?=\{)/g)) add(m[1], m.index! + m[0].length);
  return out;
}

/** 整个值就是一个任务 id 的字符串字面量：`"t-147"`、`'t-9'`。前后多一个字都不算（`"t-1 done"` 不是一个 id）。 */
const TASK_ID_LITERAL = /(["'])(t-\d+)\1/g;

/**
 * 这份源码里每一处写死的本项目任务 id，按行号。**注释与样本之外一处都不放过**：常量、实参、数组元素、
 * 对象属性值，写在哪儿都算——判据要的正是「不分常量还是实参」。
 */
export function taskIdLiterals(src: string): { line: number; id: string }[] {
  // `stripComments` 等长替换（注释变空格、换行保留），所以下标与行号都还对得上原文。
  const code = stripComments(src);
  const skip = sampleExtents(code);
  const out: { line: number; id: string }[] = [];
  for (const m of code.matchAll(TASK_ID_LITERAL)) {
    const at = m.index!;
    if (skip.some((s) => at >= s.from && at < s.to)) continue;
    out.push({ line: code.slice(0, at).split("\n").length, id: m[2] });
  }
  return out;
}

/**
 * **这道闸看不见什么，说在明处**——而那份清单住在它的用例里（`packages/core/test/no-hardcoded-task-id.test.ts`
 * 的 `TASK_ID_GATE_BLIND_SPOTS`），不在这儿。
 *
 * pd 15:45 的决策（C 当默认）：**这不是让作者自判「我这句不算给人看的」，是让冻结那道闸自己的口径回答**
 * ——它的范围是 `sourceFiles(SECOND_HOMES_ROOT).filter(isProductSource)`，用例不在里面。**一个靠位置回答的
 * 问题，比一个靠声明回答的问题可靠**，而那正是这道闸自己立足的原则，所以同一条也该用在它自己的盲点清单上。
 *
 * pd 同时给了一个出口（清单留在产品源码里、计入基线、不等它过目），说的是「搬进用例不值得」的情形。
 * **我没有走那个出口**：它给的前提是「`scan.ts` 就是闸的实现，搬清单要连断言一起搬」，而断言本来就在用例里
 * （`scan.ts` 一个断言都没有），所以这里搬的只是一个常量。前提在我这件上不成立，就按默认走。
 */
