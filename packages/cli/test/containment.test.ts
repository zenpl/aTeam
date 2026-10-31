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
   * **判据⑩ 取代了⑥ 的字面，而这一格此前写错了——错的是我，pm 读代码核出来的（11:31）。**
   *
   * 我上一版在这里写的是「`[build]` 变了 ⇒ 那个更早的版本不算基准，于是落回生产头、两件都算在生产上」，
   * 并断言了那个结果。**而那正是一个洞**：回滚真的在生效时，这样做会把被回滚掉的那几件报成在生产上。
   * ⑩ 把它分成三种（挡住的是应用代码 ⇒ 接着看；是声明过的配置文件而段不许可 ⇒ 说不出；段读不出 ⇒ 说不出），
   * 所以这一格现在断言的是**说不出**。
   *
   * 判据⑨ 要的那个性质同时钉在这里：按路径豁免整个 `fly.toml` 时，更早那个版本**会**被当成基准
   * （于是把被回滚掉的报成不在、而更晚落的报成在），按段这一版**不会**——注入时这一格当场红。
   */
  it("**`[build]` 的 dockerfile 变了** ⇒ 排除不了回滚 ⇒ 整个基准说不出（判据⑩②）", () => {
    expect(contentBase(board(ROLL, [D20, ROLL]), ROLL, differentTrees, buildChanged), "不许落回生产头：那会把被回滚的报成在生产上").toBeNull();
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: differentTrees, diffSegments: buildChanged })!;
    expect(m.unmeasured.sort(), "宁可不答").toEqual(["t-early", "t-late"]);
    expect(m.contained).toEqual([]);
    expect(m.not_contained).toEqual([]);
    expect(m.method).toContain("cannot tell");
  });

  it("**日常那一种（判据⑩①）**：挡住的是应用代码 ⇒ 生产确实往前走了，接着看，基准落回生产头", () => {
    const appCode = () => [{ file: "packages/core/src/board.ts", content: "一行代码\n另一行", lines: [1] }];
    expect(contentBase(board(ROLL, [D20, ROLL]), ROLL, differentTrees, appCode)).toEqual({ sha: ROLL, rolled_back: false });
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: differentTrees, diffSegments: appCode })!;
    expect(m.contained.sort(), "行为与 t-325 之前一字不变").toEqual(["t-early", "t-late"]);
    expect(m.method).toBe("git-ancestor（ateam release 用 git merge-base --is-ancestor 逐件测）");
  });

  /**
   * **⑩③ 的字面我按「只对声明过的配置文件成立」收了一格，而这是我自己的用例逼出来的，不是我图方便。**
   *
   * 照字面（`blocked.section` 为 null 就说不出）会把⑩① 一起吞掉：应用代码文件里本来就没有 TOML 段头，
   * 所以每一次日常的「生产往前走了」都会变成「说不出」——⑥ 字面那个过强的毛病又回来一次。
   * 上面那一格（⑩①）先红，我才看见这件事；已 tell pm，没有自己改判据。
   */
  it("**段头读不出（判据⑩③）**：声明过的配置文件整文件增删 ⇒ 说不出；而应用代码没有段头是常态，不算说不出", () => {
    const wholeConfig = () => [{ file: "fly.toml", content: "", lines: [] }];
    expect(contentBase(board(ROLL, [D20, ROLL]), ROLL, differentTrees, wholeConfig), "配置文件整个被换掉：排除不了回滚").toBeNull();
    const wholeCode = () => [{ file: "packages/cli/src/main.ts", content: "", lines: [] }];
    expect(contentBase(board(ROLL, [D20, ROLL]), ROLL, differentTrees, wholeCode), "应用代码没有段头是常态，不该因此关掉整个能力").toEqual({ sha: ROLL, rolled_back: false });
  });

  it("**git 答不上来差异** ⇒ 整桶说不出：排除不了回滚，就不许当成「没有回滚」", () => {
    const m = containment(board(ROLL, [D20, ROLL]), isAncestor, { treeOf: differentTrees, diffSegments: () => null })!;
    expect(m.unmeasured.sort(), "宁可不答").toEqual(["t-early", "t-late"]);
    expect(m.contained).toEqual([]);
    expect(m.method).toContain("cannot tell");
  });
});
