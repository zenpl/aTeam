/**
 * t-052: the team pushes production itself. `ateam release --deploy <sha>` checks that everything the sha carries
 * is verified on repo and free of open seams, pushes it to the production branch with a credential that lives only
 * in the environment, and records the fact production:deployed.sha. Pure planning + injected git, so it is testable.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, type Board, type PushLevel } from "@ateam/core";

export const DEPLOY_KEY = "deploy.enabled";
export interface DeploySetting { branch: string; by: string[] }

/** The project's deploy declaration (fact project:deploy.enabled), or null when deploys are not enabled. */
export function deploySetting(b: Board): DeploySetting | null {
  const r = b.readings.find((x) => x.valid && x.surface === "project" && x.key === DEPLOY_KEY);
  if (!r) return null;
  const v = r.value as unknown;
  if (v === false || v === "false" || v === 0) return null;
  const o = (v && typeof v === "object" ? v : {}) as { branch?: unknown; by?: unknown };
  return {
    branch: typeof o.branch === "string" && o.branch ? o.branch : "production",
    by: Array.isArray(o.by) && o.by.length ? o.by.map(String) : ["pm"],
  };
}

export type IsAncestor = (ancestor: string, descendant: string) => boolean | null;

export interface Plan { ok: boolean; reasons: string[]; included: string[] }

/** What the sha carries, and whether it may ship: every task whose evidence is inside it must be verified on repo with no open seam. */
export function plan(b: Board, sha: string, isAncestor: IsAncestor): Plan {
  const reasons: string[] = [];
  const included: string[] = [];
  const tasks = Object.values(b.tasks).flat();
  for (const t of tasks) {
    if (t.status === "withdrawn" || t.status === "open") continue;
    const s = evidenceSha(t.evidence);
    if (!s) continue;
    const inside = isAncestor(s, sha);
    if (inside !== true) continue;
    included.push(t.id);
    const passedRepo = (t.surfaces ?? []).some((r) => r.surface === "repo" && r.pass);
    if (t.status === "working") reasons.push(`${t.id} 的证据 ${s} 在这个 sha 里，但任务被重开后还没 done`);
    else if (!passedRepo && !(t.surfaces ?? []).some((r) => r.surface === "production" && r.pass)) reasons.push(`${t.id} 的证据 ${s} 在这个 sha 里，但还没在 repo 验过（${t.status}）`);
    for (const seam of b.seams) if (seam.open && seam.tasks.includes(t.id)) reasons.push(`${t.id} 有未解决的接缝 ${seam.id}`);
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], included };
}

export interface Git {
  isAncestor: IsAncestor;
  /** The remote's current tip of `branch`, or null when it does not exist. */
  remoteTip(branch: string): string | null;
  /** Push `sha` to `branch` on the remote (fast-forward only). Throws with git's message on failure. */
  push(sha: string, branch: string): void;
  /** Resolve a short sha to the full one, or null when unknown locally. */
  resolve(sha: string): string | null;
}

/** Real git in `cwd`, pushing over https with the token from the environment (never printed, never logged). */
export function realGit(cwd: string, token: string | undefined): Git {
  const run = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const remote = () => {
    const url = run(["remote", "get-url", "origin"]).stdout.trim();
    const m = /^git@github\.com:(.+?)(?:\.git)?$/.exec(url) ?? /^https:\/\/(?:[^@]+@)?github\.com\/(.+?)(?:\.git)?$/.exec(url);
    const path = m ? m[1] : null;
    if (!path) return url;
    return token ? `https://x-access-token:${token}@github.com/${path}.git` : `https://github.com/${path}.git`;
  };
  return {
    isAncestor: (a, d) => { const r = run(["merge-base", "--is-ancestor", a, d]); return r.status === 0 ? true : r.status === 1 ? false : null; },
    remoteTip: (branch) => { const r = run(["ls-remote", remote(), `refs/heads/${branch}`]); return r.status === 0 && r.stdout.trim() ? r.stdout.trim().split(/\s+/)[0] : null; },
    push: (sha, branch) => { const r = run(["push", remote(), `${sha}:refs/heads/${branch}`]); if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/x-access-token:[^@]+@/g, "x-access-token:***@")); },
    resolve: (sha) => { const r = run(["rev-parse", "--verify", `${sha}^{commit}`]); return r.status === 0 ? r.stdout.trim() : null; },
  };
}

export interface DeployDeps {
  git: Git;
  me: string;
  hasCredential: boolean;
  /** Record a fact or a note in the log. */
  reading(key: string, value: unknown, extra: { surface: string; writes?: string[]; method?: string }): Promise<void>;
  note(body: string): Promise<void>;
  print(line: string): void;
}

export type DeployOutcome = "skipped" | "refused" | "pushed" | "already" | "failed";

/** The whole `release --deploy <sha>` step. Returns what happened; the caller maps it to an exit code. */
export async function deploy(b: Board, shaArg: string, deps: DeployDeps): Promise<DeployOutcome> {
  const setting = deploySetting(b);
  if (!setting) { deps.print(`这个项目没有开启团队部署（事实 project:${DEPLOY_KEY}），什么都没做。`); return "skipped"; }
  if (!setting.by.includes(deps.me)) { deps.print(`只有 ${setting.by.join("/")} 可以推 ${setting.branch}，你是 ${deps.me}。`); return "refused"; }
  const level: PushLevel = b.presence?.find((p) => p.actor === deps.me)?.push ?? "none";
  if (level !== "production") {
    deps.print(`不推：你（${deps.me}）加入时声明的推送能力是 ${level}，推 ${setting.branch} 要 production。缺的是许可：human 许可后，用 ateam join --me ${deps.me} --push production 重新声明。`);
    return "refused";
  }
  if (!deps.hasCredential) { deps.print(`不推：环境里没有推送凭据（ATEAM_DEPLOY_TOKEN）。缺的是凭据，不是许可。`); return "refused"; }
  const sha = deps.git.resolve(shaArg);
  if (!sha) { deps.print(`本地没有提交 ${shaArg}；先 fetch。`); return "refused"; }
  const p = plan(b, sha, deps.git.isAncestor);
  if (!p.ok) { deps.print(`不推 ${sha.slice(0, 7)}：`); for (const r of p.reasons) deps.print(`  - ${r}`); return "refused"; }
  const tip = deps.git.remoteTip(setting.branch);
  const already = tip !== null && (tip === sha || sha.startsWith(tip) || tip.startsWith(sha));
  const current = b.live?.deployed_sha ?? null;
  if (already) {
    deps.print(`${setting.branch} 已经在 ${sha.slice(0, 7)}，不再推。`);
    if (!current || !(current === sha || sha.startsWith(current) || current.startsWith(sha))) await deps.reading("deployed.sha", sha, { surface: "production", writes: ["production:deployed.sha"], method: `ateam release --deploy：${setting.branch} 已在此 sha` });
    return "already";
  }
  try {
    deps.git.push(sha, setting.branch);
  } catch (err) {
    const why = (err as Error).message;
    await deps.note(`部署失败：${deps.me} 推 ${sha.slice(0, 7)} 到 ${setting.branch} 未成功：${why.split("\n").slice(-3).join(" ")}`);
    deps.print(`推送失败：${why}`);
    return "failed";
  }
  deps.print(`已推 ${sha.slice(0, 7)} 到 ${setting.branch}（包含 ${p.included.length ? p.included.join("、") : "无候选任务"}）。`);
  await deps.reading("deployed.sha", sha, { surface: "production", writes: ["production:deployed.sha"], method: `ateam release --deploy 推到 ${setting.branch}，由 CI 部署；含 ${p.included.join("、") || "无候选任务"}` });
  return "pushed";
}
