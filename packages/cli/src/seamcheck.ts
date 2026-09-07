/**
 * t-037: a resolved seam says "later merges earlier". Before `task done` goes out, check locally that the evidence
 * sha really contains the other side's evidence sha. A warning only: the log records what you claim; git knows the truth.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, boardTask, namesSha, ABSORB_PREFIX, ABSORB_FORM_KEY, noOutputSeam, cannotSeeOutput, noRealOverlap, realOverlapIs, type Board, type ClientEvent } from "@ateam/core";

/** true/false from git; null when git or either object is unavailable (not a repo, sha not fetched). */
export type IsAncestor = (ancestor: string, descendant: string) => boolean | null;

export function gitIsAncestor(cwd = process.cwd()): IsAncestor {
  return (ancestor, descendant) => {
    const r = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
    if (r.error) return null;           // no git
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null;                         // 128: not a repository, or an unknown object
  };
}

/** What the project says absorption looks like (fact project:absorb.form), or null when it never said. */
export function absorbFormOf(b: Board): string | null {
  const v = b.readings.find((r) => r.valid && r.surface === "project" && r.key === ABSORB_FORM_KEY)?.value;
  return typeof v === "string" ? v : null;
}

export type Absorb = { verdict: "yes" | "no" | "unknown"; basis: string };

/**
 * t-074: the one judgment both checks use. Did `mine` (the later side's evidence) absorb `theirs` (the earlier side's sha)?
 * git-ancestor: git decides; when it cannot (object missing, no git), unknown. named-sha: the evidence names the sha.
 * No form declared: unknown. A verdict of unknown never passes silently — the caller says why it fell back.
 */
export function judgeAbsorb(b: Board, evidence: string | undefined, theirs: string, isAncestor: IsAncestor): Absorb {
  const form = absorbFormOf(b);
  const mine = evidenceSha(evidence);
  const named = namesSha(evidence ?? "", theirs);
  if (form === "git-ancestor") {
    if (!mine) return { verdict: "unknown", basis: "证据里没有 sha，git 无从判断" };
    const r = isAncestor(theirs, mine);
    if (r === true) return { verdict: "yes", basis: `后者 ${mine.slice(0, 7)} 含前者 ${theirs.slice(0, 7)}（git-ancestor）` };
    if (r === false) return { verdict: "no", basis: `git 说 ${mine.slice(0, 7)} 不含 ${theirs.slice(0, 7)}（merge-base --is-ancestor 为否）` };
    return { verdict: "unknown", basis: `本地 git 没有 ${theirs.slice(0, 7)} 或 ${mine.slice(0, 7)}（先 git fetch 对方分支）` };
  }
  if (form === "named-sha") return named ? { verdict: "yes", basis: `后者证据写明含前者 ${theirs.slice(0, 7)}（named-sha）` } : { verdict: "no", basis: `证据没有写明含 ${theirs.slice(0, 7)}（named-sha）` };
  return { verdict: "unknown", basis: "项目没有声明 absorb.form，无法判定吸收" };
}

/** What `task done` found it could not verify (t-074): the doer's CLI writes these into a note so the fallback is on record. */
export interface SeamCheck { errors: string[]; unverified: string[]; absorbs: ClientEvent[] }

/**
 * t-067 + t-073 + t-074, one pass over the seams that touch `id` before its done goes out.
 * - stacked with me as the later side (t-067): absorption must hold. yes: fine; no: refused with what git said; unknown: today's rule
 *   (the evidence must name the sha) and the fallback is recorded, never silent.
 * - both sides done and the seam still open (t-073): a yes writes the resolution the rule wrote; no or unknown leaves it to a person.
 */
export function seamCheck(b: Board, id: string, evidence: string | undefined, isAncestor: IsAncestor): SeamCheck {
  const out: SeamCheck = { errors: [], unverified: [], absorbs: [] };
  for (const seam of b.seams) {
    if (seam.resolved || seam.absorbed || !seam.tasks.includes(id)) continue;
    const otherId = seam.tasks.find((t) => t !== id)!;
    const other = boardTask(b, otherId);
    if (!other || !["done", "failed", "verified"].includes(other.status)) continue;
    const theirs = other.evidence_sha ?? evidenceSha(other.evidence);
    if (!theirs) continue;
    const a = judgeAbsorb(b, evidence, theirs, isAncestor);
    if (seam.stacked?.on === id) {
      // t-160 判据 5、7：**git 说「真的含」的时候，把结论落回日志。**
      //
      // 以前这一支只做三件事：判「不含」就拦、判「不知道」就要求证据写明 sha、判「含」就**什么都不做**——
      // 于是在 git-ancestor 这种形态下，自动吸收那条分支（reduce.ts 里只对 named-sha 生效）永远轮不到，
      // 接缝一直开着，最后由人一条条手工裁。qa 10:16 量出来的：今晚 pm 裁的每一条都是这一行的账。
      //
      // 判仍然在有仓库的这一头做（判据 6）：服务端没有仓库，判不了祖先关系，也不许退回文本匹配（t-074）。
      // 这里落下的是**结论**，不是证据——resolution 里写明依据是 git-ancestor 以及两个 sha。
      if (a.verdict === "yes") out.absorbs.push({ kind: "task", op: "seam", tasks: [seam.tasks[0], seam.tasks[1]], resolution: `${ABSORB_PREFIX}${a.basis}` });
      else if (a.verdict === "no") out.errors.push(`${seam.id}：证据声称含 ${theirs.slice(0, 7)}（${otherId} 的证据 sha），但 ${evidenceSha(evidence)?.slice(0, 7) ?? "你的证据"} 并不包含它：${a.basis}。先真的合并，或 --no-seam-check 并在证据里说明为什么`);
      else if (a.verdict === "unknown") {
        if (!namesSha(evidence ?? "", theirs)) out.errors.push(`${seam.id}：${id} 是在 ${otherId} done 之后 claim 的，接缝按规则自动放行，但你要合并它。请在 --evidence 里写明合并了 ${theirs.slice(0, 7)}（${otherId} 的证据 sha），或 --no-seam-check`);
        else out.unverified.push(`${seam.id}：无法验证 ${id} 是否真的含 ${theirs.slice(0, 7)}（${a.basis}），按证据所写放行，由 ${id} 的 owner 保证属实`);
      }
    } else if (seam.open && a.verdict === "yes") {
      out.absorbs.push({ kind: "task", op: "seam", tasks: [seam.tasks[0], seam.tasks[1]], resolution: `${ABSORB_PREFIX}${a.basis}` });
    }
  }
  return out;
}

/** t-067 (kept for callers and tests): the refusals of `seamCheck`. */
export function seamErrors(b: Board, id: string, evidence: string | undefined, isAncestor: IsAncestor = () => null, warn: (line: string) => void = () => {}): string[] {
  const r = seamCheck(b, id, evidence, isAncestor);
  for (const u of r.unverified) warn(u);
  return r.errors;
}

/** t-073 (kept for callers and tests): the resolutions `seamCheck` writes by itself. */
export function absorbEvents(b: Board, id: string, evidence: string | undefined, isAncestor: IsAncestor): ClientEvent[] {
  return seamCheck(b, id, evidence, isAncestor).absorbs;
}

/** Warnings for `task done <id> --evidence ...`, one per resolved seam whose other side (already done) is not merged in. */
export function seamWarnings(b: Board, id: string, evidence: string | undefined, isAncestor: IsAncestor): string[] {
  const mine = evidenceSha(evidence);
  if (!mine) return [];
  const out: string[] = [];
  for (const seam of b.seams) {
    if (!seam.tasks.includes(id) || !(seam.resolved || seam.stacked?.on === id)) continue; // resolved, or released by the rule with me as the later side
    const otherId = seam.tasks.find((t) => t !== id)!;
    const other = boardTask(b, otherId);
    if (!other || (other.status !== "done" && other.status !== "verified")) continue;
    const theirs = other.evidence_sha ?? evidenceSha(other.evidence);
    if (!theirs || theirs === mine) continue;
    const contained = isAncestor(theirs, mine);
    if (contained === false) out.push(`${seam.id} 的解决方案要求你先合并 ${theirs}（${otherId} 的证据），当前证据 ${mine} 不含它`);
  }
  return out;
}

/**
 * t-191：**对方 claim 了却还没写代码时，那条接缝无从判定重叠——不该挡住前者的验收。**
 *
 * 今夜四次同形状（t-143+t-180、t-180+t-179、t-144+t-185、t-160+t-189），每次都是 qa 一次自查、pm 一次裁定、
 * 两条 tell。t-160 修的是**时序**那一半（在它 done 之后才 claim 的不挡）；剩下的这一半是**产出**：对方在它
 * done 之前就 claim 了，但自那以后一个提交都没有——两个声明之间没有重叠可判，因为其中一边还只是声明。
 *
 * 判在有仓库的那一头（同 t-160 判据 6）：服务端没有仓库，看不见提交，而**不许拿「它还没 done」当代理**——
 * 一个人可以写了一整天代码还没交活，那是最该挡住的那一种，不是这一条要放行的那一种。
 *
 * 怎么看「有没有提交」：在对方 claim 的那一刻之后，仓库里（所有 ref）有没有任何提交碰过它声明的那些路径。
 * 不限分支：对方推到自己的分支上，本地不一定知道那是哪一支，但 `--all` 覆盖得到已 fetch 的每一支。
 * **看不见就当有**（`unknown`）：git 不在、路径给不出、没 fetch 过对方的分支——这几种情况下说「它没写代码」
 * 是在猜，而猜错的方向是放行一次真碰车。
 */
export type Output = "some" | "none" | "unknown";

/**
 * 从某一刻起，仓库里有没有**别人的**提交碰过这些路径。`exclude` 是「我这一侧」的那个 ref——从它可达的提交
 * 不算。null = 判不了（没有 git，或路径为空）。
 */
export type CommitsSince = (sinceIso: string, paths: string[], exclude: string) => boolean | null;

export function gitCommitsSince(cwd = process.cwd()): CommitsSince {
  return (sinceIso, paths, exclude) => {
    if (!paths.length || !exclude) return null;
    // qa 12:01 判 fail 的那一处：**这里问错了问题。**上一版是 `git log --all -- <paths>`——没有作者、没有分支、
    // 没有排除我自己，于是它答的是「自那一刻起**任何人**有没有碰过那些路径」。而一条接缝之所以存在，恰恰是
    // 因为两边声明了同一批路径，所以「我自己在那些路径上的提交」不是边角情形，**它就是这个场景的常态**：
    // 我一提交，它就答「对方写代码了」，这条判定几乎永远放行不了。
    //
    // 该问的是「**对方**自认领以来有没有提交」。作者分不出来（这个仓库里每个 agent 都以同一个 git author 提交，
    // touches.ts 里记着这件事），分支名日志里也没有。分得出来的是**可达性**。
    //
    // **但排掉的那一侧不能是 `HEAD`**（qa 12:27 判 fail 的第二条，也是在真仓库上跑出来的）：这段判定跑在
    // `task verify --pass` 里，而落 pass 的只有 qa——**qa 的 HEAD 是 qa 自己的分支**，不是被验那件任务的分支。
    // 于是 `--not HEAD` 排掉的是 qa 自己那条线，被验任务的提交照样不可达、照样被算成「对方写了代码」。
    //
    // 排的必须是**被验那一侧自己记在日志里的那个 sha**（它的证据 sha）。谁跑这条命令都一样，因为它不来自
    // 谁的 checkout，来自日志。**残留的保守面说在明处**：别的分支上碰了同一批路径的提交仍会被算进来，
    // 于是这条判定不放行——保守的方向是继续挡着，那一侧我认。
    const r = spawnSync("git", ["log", "--all", "--not", exclude, "--oneline", `--since=${sinceIso}`, "--", ...paths], { cwd, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim().length > 0;
  };
}

/** 对方自 claim 以来有没有产出。声明里没有路径（只写了符号、章节）时判不了，返回 unknown。 */
export function outputSinceClaim(claimedAt: string | undefined, touches: string[], commitsSince: CommitsSince, mineSha?: string): Output {
  if (!claimedAt || !mineSha) return "unknown";
  // 只拿看得见的那部分去问 git：「文件#符号」取文件名，纯符号（不含 / 也不含 .）问不了 git
  const paths = [...new Set(touches.map((t) => t.split("#")[0].trim()).filter((t) => t && (t.includes("/") || t.includes("."))))];
  // 一条路径都问不出来（只声明了符号、章节，或什么都没声明）：**这里就答 unknown**，不把它交给 git 去答。
  // 交下去要靠调用方也把空数组当「判不了」，那是一条只写在别处的约定——测试替身第一次就把它踩塌了。
  if (!paths.length) return "unknown";
  const r = commitsSince(claimedAt, paths, mineSha);
  if (r === null) return "unknown";
  return r ? "some" : "none";
}

/**
 * t-191：验收之前跑一遍——**哪些开着的接缝，是因为对方 claim 了却还没写代码而无从判定的。**
 *
 * 返回要写回日志的 seam 事件。判定在这一头做，因为服务端没有仓库（同 t-160 判据 6）。三条边界：
 * ① 只看**还开着**的接缝：已解决、已吸收、已 stacked 的本来就不挡。
 * ② 只看对方**还在途**（working）的：对方已经交过活，那就有产出可判，回到正常的接缝判定。
 * ③ **看不见就当有**（`unknown` 不放行）：没 fetch 过对方的分支、声明里没有路径、git 不在——这几种情况下说
 *    「它没写代码」是在猜，而猜错的方向是放行一次真碰车。
 *
 * 判据 3 的另一半自动成立：这里不记「曾经无提交」，每次都现问 git。对方一有提交，下一次问就是 `some`，
 * 接缝回到正常判定——**没有永久豁免这回事**。
 */
export function unjudgeableSeams(b: Board, id: string, commitsSince: CommitsSince): { events: ClientEvent[]; notes: string[] } {
  const out: { events: ClientEvent[]; notes: string[] } = { events: [], notes: [] };
  for (const seam of b.seams) {
    if (!seam.open || !seam.tasks.includes(id)) continue;
    const otherId = seam.tasks.find((t) => t !== id)!;
    const other = boardTask(b, otherId);
    if (!other || other.status !== "working") continue;          // ② 对方交过活：有产出可判
    // 排掉的是**被验那一侧记在日志里的证据 sha**，不是谁的 HEAD——见 gitCommitsSince 的说明。
    const mineSha = boardTask(b, id)?.evidence_sha ?? evidenceSha(boardTask(b, id)?.evidence) ?? undefined;
    const verdict = outputSinceClaim(other.claimed_at, other.touches ?? [], commitsSince, mineSha);
    if (verdict === "some") continue;
    if (verdict === "unknown") {                                  // ③ 看不见就当有，但说出来
      out.notes.push(`${seam.id}：${cannotSeeOutput(otherId, other.claimed_at ?? "")}`);
      continue;
    }
    out.events.push({ kind: "task", op: "seam", tasks: [seam.tasks[0], seam.tasks[1]],
      resolution: noOutputSeam(otherId, other.claimed_at ?? "", id) });
  }
  return out;
}

/**
 * t-182：**闸拦对了，但报出来的文件不是两侧真正都改过的那些。**
 *
 * 今晚的实例（补记里三条之一）：t-139+t-140 报 `packages/cli/src/deaf.ts`——两侧都没碰它，它是祖先里改的；
 * 而真正撞的 `server/test/release-page.test.ts` 一个字没说。被拦下来的人照着那个名单去查，查的是一个两边都
 * 没碰过的文件。
 *
 * 根在这儿：接缝的 overlap 是两份**触点清单**的交集，而清单里没有「自共同祖先以来」这回事。我拿那两条真
 * 证据 sha 核过：`git merge-base c838dec 9867803` 就是 `c838dec` 自己——**9867803 早已包含 c838dec**，两边
 * 根本没有分叉，真交集是空的。清单却仍然相交，于是闸报出一份谁都没在撞的名单。
 *
 * 所以判定要问 git，不能只看清单（同 t-160 判据 6 的理由：服务端没有仓库，判定放在有仓库的这一头）。
 * 「看不见就当有」照旧：没 fetch 过对方的 sha、清单里没有路径、git 不在——都答 null，接缝照旧挡着。
 */
export type ChangedSince = (from: string, to: string) => string[] | null;

/** `from` 与 `to` 的共同祖先到 `to` 之间改过的文件。null = 判不了（没有 git，或哪个 sha 本地没有）。 */
export function gitChangedSince(cwd = process.cwd()): ChangedSince {
  return (from, to) => {
    const base = spawnSync("git", ["merge-base", from, to], { cwd, encoding: "utf8" });
    if (base.error || base.status !== 0) return null;
    const r = spawnSync("git", ["diff", "--name-only", `${base.stdout.trim()}..${to}`], { cwd, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return r.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
  };
}

/**
 * 两侧**自共同祖先以来真正都改过**的那些文件。null = 判不了。
 *
 * 一侧是另一侧的祖先时，后者那一边的 `merge-base..to` 覆盖了前者的全部改动，而前者那一边的 `merge-base..to`
 * 是空的——交集自然是空的，这正是今晚那三条的形状。
 */
export function realOverlap(mine: string, theirs: string, changed: ChangedSince): string[] | null {
  const a = changed(theirs, mine), b = changed(mine, theirs);
  if (a === null || b === null) return null;
  const set = new Set(a);
  return b.filter((x) => set.has(x)).sort();
}

/** t-182：一条接缝按三方比较真正撞在哪几个文件上，以及那份判定说得准不准。 */
export interface SeamTruth { seam: string; other: string; reported: string[]; real: string[] | null }

/**
 * t-182：每一条挡着 `id` 的接缝，按三方比较看它真正撞在哪儿。
 *
 * 只看**两侧都交过活**的（两边都有证据 sha）：一侧还在途时没有 sha 可比，那是 t-191 管的那一半（对方没写代码
 * 就无从判定）。两条各管一半，都不拿猜的当判定。
 */
export function seamTruths(b: Board, id: string, changed: ChangedSince): SeamTruth[] {
  const out: SeamTruth[] = [];
  for (const seam of b.seams) {
    if (!seam.open || !seam.tasks.includes(id)) continue;
    const otherId = seam.tasks.find((t) => t !== id)!;
    const mine = boardTask(b, id)?.evidence_sha ?? evidenceSha(boardTask(b, id)?.evidence);
    const theirs = boardTask(b, otherId)?.evidence_sha ?? evidenceSha(boardTask(b, otherId)?.evidence);
    if (!mine || !theirs) continue;
    out.push({ seam: seam.id, other: otherId, reported: seam.overlap ?? [], real: realOverlap(mine, theirs, changed) });
  }
  return out;
}

/** t-182：把三方比较的结论落回日志——真交集为空的接缝解掉；不空的把真名单说出来，让被拦的人查对地方。 */
export function seamTruthEvents(truths: SeamTruth[], id: string): { events: ClientEvent[]; notes: string[] } {
  const out: { events: ClientEvent[]; notes: string[] } = { events: [], notes: [] };
  for (const t of truths) {
    if (t.real === null) continue;                     // 判不了：照旧挡着，别的地方已经说过为什么
    if (t.real.length === 0) {
      out.events.push({ kind: "task", op: "seam", tasks: [id, t.other] as [string, string], resolution: noRealOverlap(t.other, t.reported) });
    } else if (t.real.join() !== [...t.reported].sort().join()) {
      out.notes.push(realOverlapIs(t.other, t.real, t.reported));   // 真撞，但名单报错了：把对的说出来
    }
  }
  return out;
}
