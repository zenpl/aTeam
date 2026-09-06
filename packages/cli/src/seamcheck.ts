/**
 * t-037: a resolved seam says "later merges earlier". Before `task done` goes out, check locally that the evidence
 * sha really contains the other side's evidence sha. A warning only: the log records what you claim; git knows the truth.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, boardTask, ABSORB_PREFIX, ABSORB_FORM_KEY, type Board, type ClientEvent } from "@ateam/core";

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

/**
 * t-067: a seam the rule released by itself (this task claimed after the other side was done) has no resolution
 * written by anyone, so the evidence has to say it: the later side names the merged sha of the earlier side, or done
 * is refused. Returns one message per stacked seam whose earlier side's sha is missing from the evidence.
 */
export function seamErrors(b: Board, id: string, evidence: string | undefined): string[] {
  const out: string[] = [];
  for (const seam of b.seams) {
    if (seam.resolved || !seam.stacked || seam.stacked.on !== id) continue;
    const other = boardTask(b, seam.stacked.done);
    const theirs = other ? other.evidence_sha ?? evidenceSha(other.evidence) : null;
    if (!theirs) continue;
    const text = evidence ?? "";
    const named = text.includes(theirs) || (theirs.length >= 7 && text.includes(theirs.slice(0, 7))) || /[0-9a-f]{7,40}/g.test(text) && [...text.matchAll(/[0-9a-f]{7,40}/g)].some((m) => theirs.startsWith(m[0]) || m[0].startsWith(theirs));
    if (!named) out.push(`${seam.id}：${id} 是在 ${seam.stacked.done} done 之后 claim 的，接缝按规则自动放行，但你要合并它。请在 --evidence 里写明合并了 ${theirs.slice(0, 7)}（${seam.stacked.done} 的证据 sha），或 --no-seam-check`);
  }
  return out;
}

/**
 * t-073: seams this done resolves by itself. Only when the project declared the git-ancestor form: for every unresolved
 * seam whose other side stands done with a sha, and git says my evidence sha contains it, one seam resolution the rule
 * wrote (with the basis in it). Nothing when the form is unset or git cannot tell: the seam stays as it is.
 */
export function absorbEvents(b: Board, id: string, evidence: string | undefined, isAncestor: IsAncestor): ClientEvent[] {
  const form = b.readings.find((r) => r.valid && r.surface === "project" && r.key === ABSORB_FORM_KEY)?.value;
  if (form !== "git-ancestor") return [];
  const mine = evidenceSha(evidence);
  if (!mine) return [];
  const out: ClientEvent[] = [];
  for (const seam of b.seams) {
    if (seam.resolved || seam.absorbed || !seam.tasks.includes(id)) continue;
    const otherId = seam.tasks.find((t) => t !== id)!;
    const other = boardTask(b, otherId);
    if (!other || !["done", "failed", "verified"].includes(other.status)) continue;
    const theirs = other.evidence_sha ?? evidenceSha(other.evidence);
    if (!theirs || theirs === mine || isAncestor(theirs, mine) !== true) continue;
    out.push({ kind: "task", op: "seam", tasks: [seam.tasks[0], seam.tasks[1]], resolution: `${ABSORB_PREFIX}后者 ${mine.slice(0, 7)} 含前者 ${theirs.slice(0, 7)}（git-ancestor）` });
  }
  return out;
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
