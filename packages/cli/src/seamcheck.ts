/**
 * t-037: a resolved seam says "later merges earlier". Before `task done` goes out, check locally that the evidence
 * sha really contains the other side's evidence sha. A warning only: the log records what you claim; git knows the truth.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, boardTask, type Board } from "@ateam/core";

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

/** Warnings for `task done <id> --evidence ...`, one per resolved seam whose other side (already done) is not merged in. */
export function seamWarnings(b: Board, id: string, evidence: string | undefined, isAncestor: IsAncestor): string[] {
  const mine = evidenceSha(evidence);
  if (!mine) return [];
  const out: string[] = [];
  for (const seam of b.seams) {
    if (!seam.resolved || !seam.tasks.includes(id)) continue;
    const otherId = seam.tasks.find((t) => t !== id)!;
    const other = boardTask(b, otherId);
    if (!other || (other.status !== "done" && other.status !== "verified")) continue;
    const theirs = evidenceSha(other.evidence);
    if (!theirs || theirs === mine) continue;
    const contained = isAncestor(theirs, mine);
    if (contained === false) out.push(`${seam.id} 的解决方案要求你先合并 ${theirs}（${otherId} 的证据），当前证据 ${mine} 不含它`);
  }
  return out;
}
