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
