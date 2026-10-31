/**
 * t-325：**「在生产上跑着」要比树，不要只问祖先。**
 *
 * 这个项目的回滚约定是 t-223 定的「向前提交、内容退回」：回滚产物是一个**新**提交，内容与旧那一版逐字相同，
 * 历史只进不退。于是 `--is-ancestor` 在回滚之后对被退掉的那几件**永远答「含」**——而待上线清单、release 那张卡
 * 的分母、pm 的发车判断都读这条事实。pm 08:23 的真样本：生产 `30aa368` 与第 20 批 `d57acbc` 的树几乎一样，
 * 而 t-219 的证据 `278dca0` 改过的 `main.ts` 与生产树差 29 行——它此刻却被列在 `contained` 里。
 *
 * 判据 2 要两格各自自证、不许一格盖两条，所以下面每一格都带着它的反面：**同一份夹具里，一件该在、一件不该在**。
 */
import { describe, it, expect } from "vitest";
import { containment, contentBase } from "../src/release.js";
import type { Board } from "@ateam/core";

/** 第 20 批、以及回滚到它的那个新提交（树与它逐字相同）；`late` 是第 20 批之后才落的内容。 */
const D20 = "d57acbc", ROLL = "30aa368", NEXT = "f00df00";
const TREE = { [D20]: "tree-20", [ROLL]: "tree-20", [NEXT]: "tree-21" } as Record<string, string>;
const treeOf = (sha: string) => TREE[sha] ?? null;

/** 历史只进不退：`late` 是 ROLL 的祖先（它曾经上过线），但不是 D20 的祖先。 */
const isAncestor = (a: string, d: string): boolean | null =>
  a === "early" ? true
  : a === "late" ? (d === D20 ? false : true)
  : null;

const board = (prod: string, deploys: string[]): Board => ({
  release: { deployed_sha: prod, candidates: [{ task: "t-early", evidence_sha: "early" }, { task: "t-late", evidence_sha: "late" }] },
  live: { deploys },
  readings: [{ valid: true, surface: "project", key: "absorb.form", value: "git-ancestor" }],
} as unknown as Board);

describe("t-325 判据 1、2 · 回滚在生效时，被退掉的那几件落 not_contained", () => {
  it("**回滚在生效**：生产的树等于第 20 批 ⇒ 第 20 批之后才落的那一件不在生产上，而更早那一件照旧在", () => {
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf })!;
    expect(m.contained, "内容真在生产树里的那一件").toEqual(["t-early"]);
    expect(m.not_contained, "祖先在、而内容被向前回滚掉的那一件——此前它被列在 contained 里").toEqual(["t-late"]);
    expect(m.method, "method 要说得出它拿哪个 sha 当基准（判据 3）").toContain(D20);
  });

  it("**对照（没有回滚在生效）**：生产的树只等于它自己 ⇒ 同一件 `late` 照旧算在生产上", () => {
    const m = containment(board(NEXT, [D20, ROLL, NEXT]), isAncestor, { treeOf })!;
    expect(m.contained.sort(), "新那一版里两件都在——所以上一格的 not_contained 不是「总是说不在」").toEqual(["t-early", "t-late"]);
    expect(m.not_contained).toEqual([]);
    expect(m.method, "没有回滚在生效时，这一句一个字没改（它本来就是诚实的）").toBe("git-ancestor（ateam release 用 git merge-base --is-ancestor 逐件测）");
  });

  it("基准那一问先走，而它自己说得出答案是哪一种（判据 5：写成代码里的一个分叉）", () => {
    expect(contentBase(board(ROLL, [D20, ROLL]), ROLL, treeOf)).toEqual({ sha: D20, rolled_back: true });
    expect(contentBase(board(NEXT, [D20, ROLL, NEXT]), NEXT, treeOf)).toEqual({ sha: NEXT, rolled_back: false });
  });

  it("**拿不到基准就一件都不答**：没有 treeOf、树解不出、或板上没有上线名单，三种都是说不出", () => {
    const noTree = containment(board(ROLL, [D20, ROLL]), isAncestor)!;
    expect(noTree.unmeasured.sort()).toEqual(["t-early", "t-late"]);
    expect(noTree.contained, "退回只问祖先，就是退回这张单要修的缺陷").toEqual([]);
    expect(noTree.method).toContain("cannot tell");
    const blindTree = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: () => null })!;
    expect(blindTree.unmeasured.sort()).toEqual(["t-early", "t-late"]);
    const noList = containment(board(ROLL, []), isAncestor, { treeOf })!;
    expect(noList.unmeasured.sort(), "瘦身板上没有上线名单：拿不到基准，不猜").toEqual(["t-early", "t-late"]);
  });
});

/**
 * t-325 判据⑥⑦⑧：**除许可的段之外逐字相同，也算「应用内容相同」——而许可的单位是一处差异落在哪一段。**
 *
 * 今天的真形状：生产头与第 20 批只差 `fly.toml` 里 `[[vm]]` 的一行（`memory` 256mb → 1gb，我自己量过：
 * `git diff --name-only` 只有 `fly.toml`、`--shortstat` 是 1 file / 1 insertion / 1 deletion，而两个树对象**不同**）。
 * 所以逐字相等那一条今天不成立，而按段判它成立。
 *
 * 判据⑧ 点名要钉**危险那一侧**：把许可从「段」改回「整个文件按路径豁免」，必须有一格红，
 * 而且红的方式是「`[build]` 的 dockerfile 变了却仍判相等」——也就是「把没在跑的代码报成在跑」那条路。
 * 下面第二格就是它，所以它断言的是 `null`（说不出），而不是某个基准。
 */
describe("t-325 判据⑥⑧ · 除许可的段之外相同算相同，而 [build] 变了不算", () => {
  /** 每个 sha 各一棵树：**逐字相等那一条今天不成立**（生产那份 fly.toml 比第 20 批多一行改动），
   *  所以下面几格走的是「按段判」那一条路。 */
  const differentTrees = (sha: string) => `tree-of-${sha}`;
  const FLY_VM = ['app = "ateam"', "", "[build]", '  dockerfile = "Dockerfile"', "", "[[vm]]", '  memory = "1gb"'].join("\n");
  /** 只差 `[[vm]]` 那一行（第 7 行）。 */
  const onlyVm = () => [{ file: "fly.toml", content: FLY_VM, lines: [7] }];
  /** 差的是 `[build]` 的 dockerfile（第 4 行）——它能改镜像。 */
  const buildChanged = () => [{ file: "fly.toml", content: FLY_VM, lines: [4] }];

  it("**只有 `[[vm]]` 变** ⇒ 第 20 批算基准，而 method 说出比了哪两棵树、排除了哪一段、依据是哪一档", () => {
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: differentTrees, diffSegments: onlyVm })!;
    expect(m.not_contained, "第 20 批之后才落的那一件此刻不在生产上").toEqual(["t-late"]);
    expect(m.contained).toEqual(["t-early"]);
    expect(m.method).toContain(D20);
    expect(m.method).toContain("fly.toml [[vm]]");
    expect(m.method, "依据那一档要说出来，而且是 frontend 自己摆的那个限度").toContain("read the config semantics");
  });

  /**
   * **判据⑧ 那一格，而我把它与 pm 11:09 写的方向差在哪也写在这里**（我随后 tell 了 pm，没有自己改判据）。
   *
   * pm 要钉的是「`[build]` 的 dockerfile 变了却仍判树相等」。而按段判之后，`[build]` 变了的后果是
   * **那个更早的版本不算基准**——于是基准落回生产头自己，两件都算在生产上。方向因此与 pm 描述的相反：
   * 按**路径**豁免整个 `fly.toml` 时，那个更早的版本反而会被当成基准（下面断言的就是这两种结果不同）。
   * **所以这一格钉的是「段与路径给出不同的答案」，而注入把段改回路径时它当场红。**
   */
  it("**`[build]` 的 dockerfile 变了** ⇒ 那个更早的版本不算基准（按路径豁免会把它算成基准，方向相反）", () => {
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: differentTrees, diffSegments: buildChanged })!;
    expect(m.not_contained, "不许把 t-late 说成不在生产上——`[build]` 不同不是「内容相同」的证明").toEqual([]);
    expect(m.contained.sort()).toEqual(["t-early", "t-late"]);
    expect(m.method, "基准是生产头自己，所以这一句一个字没改").toBe("git-ancestor（ateam release 用 git merge-base --is-ancestor 逐件测）");
  });

  it("**git 答不上来差异** ⇒ 整桶说不出：排除不了回滚，就不许当成「没有回滚」", () => {
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: differentTrees, diffSegments: () => null })!;
    expect(m.unmeasured.sort(), "宁可不答").toEqual(["t-early", "t-late"]);
    expect(m.contained).toEqual([]);
    expect(m.method).toContain("cannot tell");
  });
});
