/**
 * t-105, project layer. pd 00:09 的边界：平台只规定「done 的 touches 是最终值」，怎么算由项目档案说。本项目有 git，
 * 从分支相对 claim 起点的 diff 算；没有 diff 的介质退回手工修订，那条退化路径是一等公民，不是「以后再说」。
 */
import { describe, it, expect } from "vitest";
import { revise, baseAt, changedFiles, type Git } from "../src/touches.js";

const DECLARED = ["packages/cli/src/watch.ts", "packages/cli/src/heartbeat.ts", "packages/cli/src/index.ts", "packages/cli/src/format.ts"];
const ACTUAL = ["packages/cli/src/deaf.ts", "packages/cli/src/lock.ts", "packages/cli/src/main.ts", "packages/cli/test/deaf.test.ts"];

describe("t-105 · what a task actually touched, measured", () => {
  it("今天 dev 那次四个文件全猜错：算出来的取代声明的，两边的差都看得见", () => {
    const r = revise(DECLARED, ACTUAL, [], "相对 claim 起点 3654136");
    expect(r.measured).toBe(true);
    expect(r.touches).toEqual(ACTUAL);                                  // 最终值是事实，不是并集
    const text = r.lines.join("\n");
    expect(text).toContain("相对 claim 起点 3654136");
    expect(text).toContain("claim 时没声明、实际改了：packages/cli/src/deaf.ts、packages/cli/src/lock.ts、packages/cli/src/main.ts、packages/cli/test/deaf.test.ts");
    expect(text).toContain("claim 时声明了、实际没改：packages/cli/src/watch.ts、packages/cli/src/heartbeat.ts、packages/cli/src/index.ts、packages/cli/src/format.ts");
  });

  it("diff 看不见的东西不会被算掉：符号、字段、接口名保留，人补的也进去", () => {
    const declared = ["packages/core/src/rules.ts", "packages/core/src/rules.ts#whoCanVerify", "GET /health", "deployed.sha"];
    const r = revise(declared, ["packages/core/src/rules.ts", "packages/core/src/board.ts"], ["packages/core/src/board.ts#projectRoles"], "相对 claim 起点 abc1234");
    expect(r.touches).toEqual([
      "packages/core/src/rules.ts", "packages/core/src/board.ts",
      "packages/core/src/rules.ts#whoCanVerify", "GET /health", "deployed.sha",
      "packages/core/src/board.ts#projectRoles",
    ]);
    expect(r.lines.join("\n")).toContain("diff 看不见、保留声明的：packages/core/src/rules.ts#whoCanVerify、GET /health、deployed.sha");
    expect(r.lines.join("\n")).toContain("你补的：packages/core/src/board.ts#projectRoles");
  });

  it("算出来的与声明一致时也说一句，人不必自己比对", () => {
    const r = revise(["a.ts", "b.ts"], ["b.ts", "a.ts"], [], "相对 claim 起点 abc1234");
    expect(r.touches).toEqual(["b.ts", "a.ts"]);
    expect(r.lines.join("\n")).toContain("与 claim 时声明的一致");
  });

  it("量不出来的介质：人写的就是事实，覆盖 claim 时那份（pd 00:23 定的说法）", () => {
    const r = revise(["docs/第三章.md", "docs/第五章.md"], null, ["docs/第三章.md", "docs/第四章.md"], "这个项目没有 git");
    expect(r.measured).toBe(false);
    expect(r.touches).toEqual(["docs/第三章.md", "docs/第四章.md"]);      // 覆盖，不是并集
    const text = r.lines.join("\n");
    expect(text).toContain("触点没法量（这个项目没有 git）");
    expect(text).toContain("按你写的实际碰到的算，覆盖 claim 时那份：docs/第三章.md、docs/第四章.md");
    expect(text).toContain("claim 时声明了、这次没写：docs/第五章.md");
    // 什么都不写时，沿用声明的那份，而且说出来——那是一个选择，不是遗漏
    const kept = revise(["docs/第三章.md"], null, [], "没记下 claim 起点");
    expect(kept.touches).toEqual(["docs/第三章.md"]);
    expect(kept.lines.join("\n")).toContain("你没写 --touches，沿用 claim 时声明的那份");
  });

  it("空白与重复不进最终值", () => {
    const r = revise([" a.ts ", "a.ts", ""], [" a.ts", "b.ts", "  "], ["b.ts", " c#x "], "x");
    expect(r.touches).toEqual(["a.ts", "b.ts", "c#x"]);
  });
});

/**
 * qa 00:29 验 t-105 时找到的两处：跟着这条规则自己给出的出路走一遍，触点就不再是事实了。
 * ① 出路第一步是「再 claim 一次把触点并进来」，而 claim 每次都重写量点，此后 diff 恒为空；
 * ② 量出 0 个文件时 CLI 说「改成 0 个」、落库却是声明的七条——说的和记的对不上。
 */
describe("t-105 · 走一遍出路之后，触点还得是事实（qa 00:29）", () => {
  it("量出 0 个改动时不悄悄抹掉声明，也不谎称改成了 0 条", () => {
    const r = revise(["a/x.ts", "a/y.ts"], [], [], "相对 claim 起点 4247d7d");
    expect(r.touches).toBeUndefined();                                  // 什么都不发，声明原样留着
    const text = r.lines.join("\n");
    expect(text).toContain("量出 0 个改动文件（相对 claim 起点 4247d7d）：先不改触点，沿用 claim 时声明的 2 条");
    expect(text).toContain("--touches");                                // 说出两条出路
    expect(text).not.toContain("改成 0 个文件");                         // 不再说一句与记录不符的话
  });

  it("量出 0 个但人自己写了实际碰到的：以人写的为准", () => {
    const r = revise(["a/x.ts"], [], ["a/z.ts"], "相对 claim 起点 4247d7d");
    expect(r.touches).toEqual(["a/z.ts"]);
  });

  it("真的什么都没碰、声明也是空的：照常走，不特殊对待", () => {
    expect(revise([], [], [], "x").touches).toEqual([]);
  });
});

/**
 * A diff measures a branch, not a task. One branch carrying three tasks in a row measures all three every time, and
 * no amount of measuring tells them apart — so when the person knows and the measurement cannot, they say so.
 */
describe("t-105 · --touches-only：我写的这几条就是全部", () => {
  it("replaces everything, says what the declaration had that this does not, and never claims to have measured", () => {
    const r = revise(["a/x.ts", "a/y.ts", "GET /health"], ["a/x.ts", "b/other-task.ts"], ["a/x.ts", "a/x.ts#f"], "相对 claim 起点 abc1234", true);
    expect(r.touches).toEqual(["a/x.ts", "a/x.ts#f"]);          // 量出来的 b/other-task.ts 不作数
    expect(r.measured).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("触点按你写的这 2 条算，量出来的不作数（--touches-only）");
    expect(text).toContain("claim 时声明了、这次没写：a/y.ts、GET /health");
  });
});

/**
 * t-135: the measuring point of a round. t-112 was claimed at 00:52 and reopened at 03:58; in between its owner
 * shipped five other tasks over eight commits, and `done` charged all thirty-two of those files to it and refused on
 * two seams that did not exist. The only way through was editing the recorded sha by hand — which is not a gate, it is
 * a gate people learn to walk around.
 */
describe("t-135 · a reopened round is measured from where the round started", () => {
  const CLAIM = "c0cadad", ROUND2 = "14342b5", ROUND3 = "e1d5a22";

  it("the first claim records; widening the same claim does not move it", () => {
    expect(baseAt("claim", CLAIM, null)).toBe(CLAIM);        // nothing recorded yet: this is the start
    expect(baseAt("claim", ROUND2, CLAIM)).toBe(CLAIM);      // claiming again widens the declaration, it is not a new round
    expect(baseAt("claim", ROUND3, CLAIM)).toBe(CLAIM);      // however many times
  });

  it("a reopen moves it, and every reopen after that moves it again", () => {
    expect(baseAt("reopen", ROUND2, CLAIM)).toBe(ROUND2);
    expect(baseAt("reopen", ROUND3, ROUND2)).toBe(ROUND3);
    expect(baseAt("reopen", ROUND3, null)).toBe(ROUND3);     // reopened without a record (claimed before this existed)
  });

  it("no git, no record: the manual path takes over rather than a wrong measurement", () => {
    expect(baseAt("claim", null, null)).toBeNull();
    expect(baseAt("reopen", null, CLAIM)).toBeNull();        // an old record is left alone, never replaced by a guess
  });

  it("dev's case, end to end: what the round touched, not what the branch did all night", () => {
    // the eight commits between claim and reopen touched these; this round touched two of them
    const between = ["packages/core/src/board.ts", "packages/core/src/store.ts", "packages/core/src/reduce.ts", "packages/server/src/app.ts", "packages/cli/src/main.ts"];
    const thisRound = ["packages/core/src/rules.ts", "packages/core/test/pass-only-gates.test.ts"];
    const declared = ["packages/core/src/rules.ts"];
    // before: measured from the first claim, everything the branch did is charged to this task
    const before = revise(declared, [...between, ...thisRound], [], `相对 claim 起点 ${CLAIM.slice(0, 7)}`);
    expect(before.touches).toEqual([...between, ...thisRound]);
    expect(before.lines.join("\n")).toContain("packages/core/src/board.ts");   // five files this round never opened
    // after: the round is measured from its own start
    const after = revise(declared, thisRound, [], `相对 claim 起点 ${ROUND2.slice(0, 7)}`);
    expect(after.touches).toEqual(thisRound);
    for (const f of between) expect(after.lines.join("\n")).not.toContain(f);
    expect(after.lines.join("\n")).toContain("claim 时没声明、实际改了：packages/core/test/pass-only-gates.test.ts");
  });
});

/**
 * t-138: `git diff base..HEAD` cannot tell "I wrote this" from "I merged this", and merging is not the exception —
 * the seam rules ask for it, and on a busy night everyone is doing it. t-136 was claimed at 7be4d67, merged
 * frontend's c441b39 on the way, and came out claiming sixteen files and one seam that was not its own. The only way
 * through was `--touches-only`, which is the escape hatch, not the answer: an algorithm you can only get past by
 * declaring the answer by hand teaches the next person to declare the answer by hand.
 *
 * All times relative to now; git is faked so these say what the commands mean, not what this checkout happens to hold.
 */
describe("t-138 · 合进来的不是我改的", () => {
  const MINE = ["packages/cli/src/deaf.ts", "packages/server/test/behind.test.ts"];
  const THEIRS = ["packages/server/src/html.ts", "packages/server/src/i18n.ts"];
  const RESOLVED = ["packages/server/src/app.ts"];

  /** A fake git for a branch that carries my two commits and one merge of somebody else's branch. */
  const git = (over: Record<string, string | null> = {}): Git => (args) => {
    const k = args[0] === "diff-tree" ? "diff-tree" : args.slice(0, 2).join(" ");
    if (k in over) return over[k];
    if (k === "log --first-parent") return MINE.join("\n");
    if (k === "rev-list --first-parent") return "merge1\n";
    if (k === "diff-tree") return RESOLVED.join("\n");
    if (k === "diff --name-only") return "";
    if (k === "ls-files --others") return "";
    return "";
  };

  it("my commits and my conflict resolutions count; what the merge dragged in does not", () => {
    const files = changedFiles(git(), "7be4d67")!;
    expect(files).toEqual([...MINE, ...RESOLVED]);
    for (const f of THEIRS) expect(files).not.toContain(f);
  });

  it("uncommitted work and new files are still mine", () => {
    const files = changedFiles(git({ "diff --name-only": "packages/cli/src/main.ts", "ls-files --others": "packages/cli/test/new.test.ts" }), "7be4d67")!;
    expect(files).toContain("packages/cli/src/main.ts");
    expect(files).toContain("packages/cli/test/new.test.ts");
  });

  it("the tool's own bookkeeping is never a thing the task touched", () => {
    const files = changedFiles(git({ "ls-files --others": ".ateam/base.t-138\n.ateam/cursor.dev" }), "7be4d67")!;
    expect(files.some((f) => f.startsWith(".ateam/"))).toBe(false);
  });

  it("git cannot answer at all: null, and the manual path takes over — never a wrong measurement", () => {
    expect(changedFiles(git({ "log --first-parent": null }), "7be4d67")).toBeNull();
    // a range with nothing of mine in it is an *answer*, not a failure: this task changed nothing yet
    expect(changedFiles(git({ "log --first-parent": "", "rev-list --first-parent": "", "diff-tree": "" }), "7be4d67")).toEqual([]);
  });

  it("a merge with nothing of its own adds nothing: only files differing from every parent are the merger's", () => {
    const files = changedFiles(git({ "diff-tree": "" }), "7be4d67")!;
    expect(files).toEqual(MINE);
  });

  it("t-136's own case: sixteen files become the seven that were really its round", () => {
    // the shape that produced the phantom seam: my commits, one merge of frontend's branch, one resolved file
    const mine136 = ["packages/cli/src/client.ts", "packages/cli/src/deaf.ts", "packages/cli/src/main.ts",
      "packages/cli/test/deaf.test.ts", "packages/server/src/app.ts", "packages/server/test/behind.test.ts",
      "packages/server/test/rendered.test.ts"];
    const theirs136 = ["packages/server/src/html.ts", "packages/server/src/i18n.ts", "packages/cli/src/format.ts",
      "packages/server/test/release-page.test.ts", "packages/core/test/slim-cost.test.ts"];
    const g: Git = (args) => {
      const k = args[0] === "diff-tree" ? "diff-tree" : args.slice(0, 2).join(" ");
      if (k === "log --first-parent") return mine136.join("\n");
      if (k === "rev-list --first-parent") return "fe6bbd3";
      if (k === "diff-tree") return "packages/server/src/app.ts";
      return "";
    };
    const files = changedFiles(g, "7be4d67")!;
    expect(files.sort()).toEqual([...mine136].sort());
    for (const f of theirs136) expect(files).not.toContain(f);
    expect(files).toHaveLength(7);
  });
});
