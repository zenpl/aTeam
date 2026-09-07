/**
 * t-037: a resolved seam says "later merges earlier". Before `task done` goes out, check locally that the evidence
 * sha really contains the other side's evidence sha. A warning only: the log records what you claim; git knows the truth.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, boardTask, namesSha, ABSORB_PREFIX, ABSORB_FORM_KEY, type Board, type ClientEvent } from "@ateam/core";

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
      if (a.verdict === "no") out.errors.push(`${seam.id}：证据声称含 ${theirs.slice(0, 7)}（${otherId} 的证据 sha），但 ${evidenceSha(evidence)?.slice(0, 7) ?? "你的证据"} 并不包含它：${a.basis}。先真的合并，或 --no-seam-check 并在证据里说明为什么`);
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
