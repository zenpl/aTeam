import { readFileSync } from "node:fs";
/**
 * t-105 (T4): touches declared at claim are a guess; touches at done are a fact. This is the *project* layer — this
 * project keeps its work in git, so the fact comes from the branch's own diff. The platform knows none of that: it
 * only reads the final list off the done event (see the `done` op in core). A medium with no diff falls back to the
 * person revising the list by hand, and that path is a first-class one, not a "later".
 */
export interface Diff {
  /** The sha this branch was at when the task was claimed, if we recorded it. */
  base(task: string): string | null;
  /** Files changed between `base` and the working tree now, or null when git cannot say. */
  changed(base: string): string[] | null;
  /** The current commit, to record as a base at claim time. Null when there is no git here. */
  head(): string | null;
}

export interface Revision {
  /** What goes on the done event. `undefined` says nothing, and the claim declaration stands. */
  touches: string[] | undefined;
  /** Lines for the person: what the diff added, what it dropped, and where the value came from. */
  lines: string[];
  /** True when the list came from the diff; false when the person supplied it (no git, no base, or --touches only). */
  measured: boolean;
}

/** Run a git command and return its stdout, or null when git could not answer. */
export type Git = (args: string[]) => string | null;

/**
 * t-138: which files *this task* changed, on a branch that also carries other people's work.
 *
 * `git diff base..HEAD` cannot tell "I wrote this" from "I merged this", and merging is not an exception here — the
 * seam rules require it, and on a busy night everyone is doing it. t-136 was claimed at 7be4d67, merged frontend's
 * c441b39 on the way, and came out claiming sixteen files and one seam that was not its own. So the diff is replaced
 * by three questions, each answered from its own place:
 *
 *   my own commits      `git log --first-parent --no-merges` over the range: what I committed on this branch, with
 *                       everything a merge dragged in left out.
 *   what a merge itself  a merge's combined diff (`diff-tree -c`) lists only the files that differ from *every*
 *   changed             parent — which is exactly the conflict resolution, the part of a merge I really did write.
 *   not committed yet   the working tree against HEAD, plus untracked files.
 *
 * **Where it is wrong, said out loud (pm, t-138 判据 1).** Every filter has a blind spot and this one has three.
 * ① Work I do on another branch and merge in looks like somebody else's and is not counted. ② Someone else's commit
 * landing on my first-parent chain — a cherry-pick, or another agent pushing to my branch — counts as mine. ③ An
 * "evil merge" edit that happens to leave a file identical to one parent is invisible to the combined diff.
 *
 * Filtering by commit author would have none of those blind spots and is not available: every agent in this repo
 * commits as the same git author (`Claude <noreply@anthropic.com>`; `git log --format=%an` says so), so an author
 * filter here separates nothing at all. That is not a weaker option, it is no option.
 */
export function changedFiles(git: Git, base: string): string[] | null {
  const lines = (out: string | null) => (out ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
  const mine = git(["log", "--first-parent", "--no-merges", "--name-only", "--format=", `${base}..HEAD`]);
  if (mine === null) return null;                     // git cannot answer at all: the manual path takes over
  const out = new Set(lines(mine));
  for (const merge of lines(git(["rev-list", "--first-parent", "--merges", `${base}..HEAD`])))
    for (const f of lines(git(["diff-tree", "-c", "--name-only", "--no-commit-id", "-r", merge]))) out.add(f);
  for (const f of lines(git(["diff", "--name-only", "HEAD"]))) out.add(f);
  for (const f of lines(git(["ls-files", "--others", "--exclude-standard"]))) out.add(f);
  // .ateam/ is the tool's own bookkeeping (cursors, watch locks, claim bases): never a thing the task touched
  return [...out].filter((x) => !x.startsWith(".ateam/"));
}

/**
 * t-135: where the round being measured started. A first claim records the branch's head; **widening** a claim must
 * not move it (qa 00:29: re-basing there moves the measuring point to "now" and makes every later diff empty —
 * silently, on exactly the tasks that need this most). A **reopen** must move it: a new round is new work, and
 * measuring it from the first claim charges the task with everything its owner did in between.
 *
 * That is not hypothetical. t-112 was claimed at 00:52 and reopened at 03:58; in between its owner shipped five other
 * tasks over eight commits, and `done` attributed all thirty-two of those files to it and refused on two seams that
 * did not exist. The only way through was editing the recorded sha by hand, which is the shape of a gate people learn
 * to walk around rather than a gate.
 *
 * Returns the sha to record, or null to leave the record alone (no git here: the manual path takes over, as designed).
 */
export function baseAt(op: "claim" | "reopen", head: string | null, recorded: string | null): string | null {
  if (!head) return null;
  return op === "reopen" ? head : recorded ?? head;
}

/**
 * Is this entry something a diff could have measured? Only a path is: it has a directory separator, no `#symbol`
 * suffix and no spaces. Everything else — `deployed.sha`, `GET /health`, a bare symbol — the diff never saw, so the
 * revision keeps it rather than silently dropping the seams it carries.
 */
const isPath = (x: string) => x.includes("/") && !x.includes("#") && !/\s/.test(x);

/**
 * The final list. `declared` is what claim said, `changed` what the diff measured (null when it could not), `extra`
 * what the person added by hand. Measured paths replace the declared *paths*; everything the diff cannot see
 * (symbols, field names, `GET /health`) is kept, because dropping it would silently drop the seams it carries.
 */
export function revise(declared: string[], changed: string[] | null, extra: string[], why: string, only = false): Revision {
  if (only) {
    // The person is saying "this list is the fact". A diff measures a branch, not a task: one branch carrying three
    // tasks in a row measures all three every time, and no amount of measuring can tell them apart. When they know
    // and the measurement cannot, they say so and it stands.
    const mine = [...new Set(extra.map((x) => x.trim()).filter(Boolean))];
    const gone = [...new Set(declared.map((x) => x.trim()).filter(Boolean))].filter((x) => !mine.includes(x));
    return { touches: mine, measured: false,
      lines: [`触点按你写的这 ${mine.length} 条算，量出来的不作数（--touches-only）`, ...(gone.length ? [`  claim 时声明了、这次没写：${gone.join("、")}`] : [])] };
  }
  const clean = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  const dec = clean(declared), ext = clean(extra);
  if (changed === null) {
    // Nothing measured: what the person wrote *is* the fact, and it replaces the declaration (说明书第 7 步：覆盖
    // claim 时那份). Writing nothing means they are standing by the declaration, which is a choice, not a mistake.
    const touches = ext.length ? ext : dec;
    const lines = [`触点没法量（${why}）。${ext.length ? `按你写的实际碰到的算，覆盖 claim 时那份：${ext.join("、")}` : "你没写 --touches，沿用 claim 时声明的那份"}`];
    if (ext.length) {
      const gone = dec.filter((x) => !ext.includes(x));
      if (gone.length) lines.push(`  claim 时声明了、这次没写：${gone.join("、")}`);
    }
    return { touches, lines, measured: false };
  }
  const measured = clean(changed);
  if (!measured.length && dec.length && !ext.length) {
    // git looked and found nothing changed since the claim point. That may be true (nothing saved yet) or a sign the
    // base is wrong. Either way, wiping a declaration on the strength of it would delete real seams, so say what
    // happened and leave the declaration standing — printed and recorded agree (qa 00:29 caught them disagreeing).
    return { touches: undefined, lines: [`量出 0 个改动文件（${why}）：先不改触点，沿用 claim 时声明的 ${dec.length} 条。真的什么都没碰就不必管；碰了却没量到，先把改动落盘，或用 --touches 直接写实际碰到的`], measured: false };
  }
  const kept = dec.filter((x) => !isPath(x));                       // symbols and the like: the diff never saw them
  const touches = clean([...measured, ...kept, ...ext]);
  const added = measured.filter((x) => !dec.includes(x));
  const dropped = dec.filter((x) => isPath(x) && !measured.includes(x));
  const lines = [`触点按量出来的实际改动改成 ${measured.length} 个文件（${why}）`];
  if (added.length) lines.push(`  claim 时没声明、实际改了：${added.join("、")}`);
  if (dropped.length) lines.push(`  claim 时声明了、实际没改：${dropped.join("、")}`);
  if (kept.length) lines.push(`  diff 看不见、保留声明的：${kept.join("、")}`);
  if (ext.length) lines.push(`  你补的：${ext.join("、")}`);
  if (!added.length && !dropped.length) lines.push("  与 claim 时声明的一致");
  return { touches, lines, measured: true };
}

/**
 * t-183：**done 量出来的触点带到符号一级。**
 *
 * 判定早就是符号级的（t-170 的 `touchesHumanVisible` 读 `文件#符号`，t-113 的轻接缝也读它），可 `done` 量出来的
 * 只有路径——于是只声明路径的人照样过得去，符号级那一半形同虚设（我 09:42 自己指出来的那个缺口）。
 *
 * 怎么量：`git diff -U0` 给出改动落在新文件的哪几行，再把每一行归给包着它的**顶层声明**（行首、不缩进的
 * `const/function/class/interface/type`）。归属口径与 `keysyms.ts` 里那两段一致——导出与否都算，只认顶层：
 * 函数体里的局部 `const` 不是谁碰得到的符号。
 *
 * **算不出来时退回文件级、只提醒不拒绝**（判据 2，pd 08:22 的退路）。算不出的三种，说在明处：
 * ① 不是 `.ts`/`.tsx`：这段扫法只认得 TypeScript 的顶层声明；
 * ② 改动落在任何声明之外（import、顶层语句、文件头注释）——那时「哪个符号」这个问题本身没有答案；
 * ③ 文件被删掉，或 git 答不上来。
 * 三种都只补路径，不编一个符号名——**编出来的符号名比没有更糟**，t-170 判据 8 就是为它加的。
 */
export function changedSymbols(git: Git, base: string, file: string): string[] | null {
  if (!/\.tsx?$/.test(file)) return null;
  const now = git(["show", `HEAD:${file}`]) ?? git(["cat-file", "-p", `HEAD:${file}`]);
  const worktree = git(["diff", "-U0", "HEAD", "--", file]);
  const committed = git(["diff", "-U0", `${base}..HEAD`, "--", file]);
  if (committed === null && worktree === null) return null;
  const text = readOrNull(file) ?? now;
  if (text === null) return null;                      // 文件没了：谈不上「改了哪个符号」
  const decls = [...text.matchAll(/^(?:export\s+)?(?:const|function|class|interface|type|async function)\s+(\w+)/gm)];
  if (!decls.length) return null;
  const lineOf = (idx: number) => text.slice(0, idx).split("\n").length;
  // 一段声明管到哪儿：到**下一段声明自己那段注释开始之前**，不是到下一行声明。
  // 这一条是跑出来才发现的：我把这个函数追加在 revise 后面，它自己那段文档注释被算进了 revise 的范围，
  // 于是「我改了 revise」——而我一个字都没动它。与 frontend 09:27 在 speaking() 里抓到的是同一种错配。
  const lines = text.split("\n");
  const commentStart = (declLine: number) => {
    let i = declLine - 1;                                  // 1-based -> 0-based，从声明的上一行往回走
    while (i > 0 && /^\s*(\*|\/\*|\/\/)/.test(lines[i - 1])) i--;
    return i + 1;
  };
  const spans = decls.map((m, i) => ({
    name: m[1], from: lineOf(m.index!),
    to: i + 1 < decls.length ? commentStart(lineOf(decls[i + 1].index!)) - 1 : lines.length,
  }));
  const out = new Set<string>();
  let outside = false;
  // **走 diff 的正文，只数真正带 `+` 的那些行。**光读 @@ 头是不够的：`-U0` 之下 git 仍会把紧邻的上下文并进
  // 同一个 hunk（`@@ -133,3 +134,66 @@`），于是前面那个函数的尾巴被算成改过——我把这个函数追加在 revise
  // 后面时就中了这一发，`revise` 被报成改过，而我一个字都没动它。
  for (const diff of [committed, worktree]) {
    let line = 0;
    for (const raw of (diff ?? "").split("\n")) {
      const at = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (at) { line = Number(at[1]); continue; }
      if (!line) continue;                              // 还没进到任何一个 hunk：文件头那几行
      if (raw.startsWith("-")) continue;                // 纯删除：新文件里没有对应的行
      if (raw.startsWith("+")) {
        // 空行不改变任何符号。追加一段新代码时，前面那个空行会落在**上一个**函数的范围里——`revise` 就是这么
        // 被报成改过的，而我一个字都没动它。一个只多了空行的符号，说它「改了」是假的。
        if (!raw.slice(1).trim()) { line++; continue; }
        const span = spans.find((x) => line >= x.from && line <= x.to);
        if (span) out.add(`${file}#${span.name}`);
        else outside = true;                            // 改在所有声明之外：import、顶层语句、文件头
      }
      line++;                                           // `+` 与上下文行都占新文件的一行
    }
  }
  if (!out.size) return null;
  return outside ? [...out].sort() : [...out].sort();
}

/** 读工作区里的文件；读不到返回 null（被删掉了，或不在这个 checkout 里）。 */
function readOrNull(file: string): string | null {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}
