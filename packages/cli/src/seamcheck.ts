/**
 * t-037: a resolved seam says "later merges earlier". Before `task done` goes out, check locally that the evidence
 * sha really contains the other side's evidence sha. A warning only: the log records what you claim; git knows the truth.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, boardTask, namesSha, ABSORB_PREFIX, ABSORB_FORM_KEY, noOutputSeam, cannotSeeOutput, type Board, type ClientEvent } from "@ateam/core";

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

/** 从某一刻起，仓库里有没有任何提交碰过这些路径。null = 判不了（没有 git，或路径为空）。 */
export type CommitsSince = (sinceIso: string, paths: string[]) => boolean | null;

export function gitCommitsSince(cwd = process.cwd()): CommitsSince {
  return (sinceIso, paths) => {
    if (!paths.length) return null;
    const r = spawnSync("git", ["log", "--all", "--oneline", `--since=${sinceIso}`, "--", ...paths], { cwd, encoding: "utf8" });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim().length > 0;
  };
}

/** 对方自 claim 以来有没有产出。声明里没有路径（只写了符号、章节）时判不了，返回 unknown。 */
export function outputSinceClaim(claimedAt: string | undefined, touches: string[], commitsSince: CommitsSince): Output {
  if (!claimedAt) return "unknown";
  // 只拿看得见的那部分去问 git：「文件#符号」取文件名，纯符号（不含 / 也不含 .）问不了 git
  const paths = [...new Set(touches.map((t) => t.split("#")[0].trim()).filter((t) => t && (t.includes("/") || t.includes("."))))];
  // 一条路径都问不出来（只声明了符号、章节，或什么都没声明）：**这里就答 unknown**，不把它交给 git 去答。
  // 交下去要靠调用方也把空数组当「判不了」，那是一条只写在别处的约定——测试替身第一次就把它踩塌了。
  if (!paths.length) return "unknown";
  const r = commitsSince(claimedAt, paths);
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
    const verdict = outputSinceClaim(other.claimed_at, other.touches ?? [], commitsSince);
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
