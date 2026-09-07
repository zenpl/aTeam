/**
 * t-052: the team pushes production itself. `ateam release --deploy <sha>` checks that everything the sha carries
 * is verified on repo and free of open seams, pushes it to the production branch with a credential that lives only
 * in the environment, and records the fact production:deployed.sha. Pure planning + injected git, so it is testable.
 */
import { spawnSync } from "node:child_process";
import { evidenceSha, orphanReason, unknownSpanReason, DEPLOYED_TASKS_KEY, HUMAN_SURFACE, REPO_SURFACE, type Board, type PushLevel, type ClientEvent } from "@ateam/core";
import { absorbFormOf } from "./seamcheck.js";

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

/** t-209：`from` 之后、`to` 之前的提交（不含 from、含 to），新到旧。null = 问不出来（没有 git，或哪个 sha 本地没有）。 */
export type RevList = (from: string, to: string) => string[] | null;

/** t-209：一件任务声称的那一段产出。`base` 缺席时区间不可知——那不是「没有产出」，是「说不清」。 */
export interface Span { task: string; base?: string; evidence: string }

export interface Plan {
  ok: boolean; reasons: string[]; included: string[];
  /** t-093: the tasks this push would add that are not verified, by id. */ unverified: string[];
  /**
   * t-209：这一批里**没有任何一件任务声称自己产出**的提交。
   *
   * `null` 表示问不出来（没有 git、算不出提交表、或没有生产头可比）——**与空数组不是一回事**：空是「问过了，一条都没有」，
   * null 是「没问出来」。这个区别就是 t-203 那件事的教训，同一个形状的第二次。
   */
  orphans: string[] | null;
  /**
   * t-209 判据 7：**区间算不出来的那几件任务**，按 id 列出来。
   *
   * 一件任务的产出是区间 `(base, evidence]`，而 `base` 是 `done` 记下的这一轮起点——**这条规矩之前落的 done 没有它**。
   * 缺了它就说不清那件任务盖住了哪几条提交，于是那几条也说不清是不是孤儿。**明说算不出，不许猜**：
   * 这一格不并进 `orphans`（那是诬告），也不并进「已覆盖」（那是把它们变没）。这正是 t-203 第三桶那件事的第三次。
   */
  unknown_span: string[];
}
/** t-093: the rule a refusal names (M4). */
export const DEPLOY_RULE = "deploy-unverified";

/** What the sha carries, and whether it may ship: every task whose evidence is inside it must be verified on repo with no open seam. */
export function plan(b: Board, sha: string, isAncestor: IsAncestor, deployed?: string | null, revList?: RevList): Plan {
  const reasons: string[] = [];
  const included: string[] = [];
  const unverified: string[] = [];
  const spans: Span[] = [];
  const tasks = Object.values(b.tasks).flat();
  for (const t of tasks) {
    if (t.status === "withdrawn" || t.status === "open") continue;
    const s = t.evidence_sha ?? evidenceSha(t.evidence);
    if (!s) continue;
    const inside = isAncestor(s, sha);
    if (inside !== true) continue;
    // t-093: only what this push *adds* — a task already inside the running sha is not this push's to answer for
    if (deployed && isAncestor(s, deployed) === true) continue;
    included.push(t.id);
    spans.push({ task: t.id, base: t.base_sha, evidence: s });
    const passedRepo = (t.surfaces ?? []).some((r) => r.surface === REPO_SURFACE && r.pass);
    if (t.status !== "verified") { unverified.push(t.id); reasons.push(`${t.id}（${t.status}${passedRepo ? "，repo 验过但整件还没 verified" : ""}）：证据 ${s.slice(0, 7)} 在这个 sha 里，但这件不是 verified`); }
    else if (!passedRepo && !(t.surfaces ?? []).some((r) => r.surface === HUMAN_SURFACE && r.pass)) reasons.push(`${t.id} 的证据 ${s.slice(0, 7)} 在这个 sha 里，但还没在 repo 验过（${t.status}）`);
    for (const seam of b.seams) if (seam.open && seam.tasks.includes(t.id)) reasons.push(`${t.id} 有未解决的接缝 ${seam.id}`);
  }
  // t-209：**这道闸原来只数任务，于是不是任务的东西它看不见。**
  //
  // 上面那个循环问的是「每件任务的证据 sha 在不在这个 sha 里」。反过来那一问从来没人问过：**这一批里有哪些提交
  // 不属于任何一件任务的证据链？** 真样本是我自己的 9ac8cee（补 t-206 那道闸自己的两处盲区）——它在 b537a31
  // 之后、不在 a134fcc 里，qa 14:05 量到没有任何任务盖着它，也就没有任何判决盖着它，而它照样会跟着上生产。
  //
  // 这是 t-203 同一个形状的第二例：**分母漏了一类**。那次漏的是「量不出」那一桶，这次漏的是「不是任务的提交」——
  // 两次都是「算不到的东西等于不存在」。
  //
  // 算法：`deployed..sha` 里的每一个提交，减去从任何一个已算进来的证据 sha 可达的那些。剩下的就是没人盖着的。
  const { orphans, unknown_span } = orphanCommits(sha, deployed, spans, revList);
  if (orphans?.length) reasons.push(orphanReason(orphans));
  // t-209 判据 7：**「说不清」要说出来，但它不拦车。**
  //
  // 拦不拦这一条我想了两遍。此刻**每一件老任务都没有起点**（这个字段从这一件才开始记），所以一旦让它拦，
  // 这道闸今天会挡住每一次发车——而一道挡住一切的闸，下一步就是被整个关掉。今晚我已经修过三次那个形状
  // （t-151 死掉的出路、--no-seam-check 两次），不能在这里亲手造第四次。
  //
  // 也不能反过来把它咽下去：那就成了「算不到的东西等于不存在」，正是这件任务要修的那件事。
  // 所以它进 `reasons`（发车前照样印在人眼前）、进 `unknown_span`（能被别处读），**但不改 `ok`**。
  // 真孤儿——有名有姓、确实没人认领的那些——照旧拦。
  const blocking = [...reasons];
  if (unknown_span.length) reasons.push(unknownSpanReason(unknown_span));
  return { ok: blocking.length === 0, reasons: [...new Set(reasons)], included, unverified: [...new Set(unverified)], orphans, unknown_span };
}

/**
 * t-209：这一批里没有任何一件任务声称自己产出的提交。
 *
 * **「被盖住」是区间，不是可达性。** 上一版算的是「从任何一个证据 sha 出发可达」，qa 14:29 在真仓库上证伪了它：
 * 那些证据 sha 都在同一条线性分支上，所以**任何一条孤儿提交，只要有人在它之上再落一件任务的证据，它就永远消失**。
 * 它量到的正是这件任务自己的样本——头 = 9ac8cee 时点名它，头 = 50ed4ab 之后再也不点名。而真实发车时目标 sha
 * 通常就是最新那件任务的证据 sha，于是这道闸只看得见「排在所有证据之后、还挂在头上」的那几条。
 *
 * 现在按 pm 判据 6 的口径：一条提交被盖住，当且仅当它落在某件任务的 `(base, evidence]` 之间——`base` 是那件活
 * claim 时戳下的起点，`done` 从 t-209 起把它记进事件。**那一段才是那件任务声称的产出，也才是判决覆盖过的范围。**
 *
 * 三个答案分得开（判据 7，也是 t-203 第三桶那件事的第三次）：
 * · `orphans` 有名字：没有任何一件任务的区间盖住它们；
 * · `unknown_span`：这几件任务没记起点，**说不清它们盖住了哪几条**——不诬告、也不当作已覆盖；
 * · `orphans === null`：整个问不出来（没有 git、没有生产头、哪一段 git 答不上）。
 */
export function orphanCommits(sha: string, deployed: string | null | undefined, spans: Span[], revList?: RevList): { orphans: string[] | null; unknown_span: string[] } {
  const unknown_span = spans.filter((x) => !x.base).map((x) => x.task);
  // t-209 判据 7：**只要有一件任务的区间不可知，整个「谁是孤儿」就不可知。**
  //
  // 我第一版只把那几件任务报进 unknown_span，孤儿照算——跑出来才看见它的后果：那几件任务的提交没有区间盖着，
  // 于是**它们全被算成孤儿**。那正是我在上一段注释里说要避免的诬告，而我一边写下它一边做了它。
  // 说不清哪几条属于那几件，就说不清剩下的是不是没人认领的——所以这里答 null，并把「为什么算不出」交给
  // unknown_span 说。**不猜，也不诬告。**
  if (unknown_span.length) return { orphans: null, unknown_span };
  if (!revList || !deployed) return { orphans: null, unknown_span };
  const all = revList(deployed, sha);
  if (all === null) return { orphans: null, unknown_span };
  const covered = new Set<string>();
  for (const x of spans) {
    if (!x.base) continue;                 // 区间不可知：它不盖住任何东西，也不因此让谁变成孤儿——单独报在 unknown_span
    const seg = revList(x.base, x.evidence);
    if (seg === null) return { orphans: null, unknown_span };   // 有一段问不出来，整个答案就不可信
    for (const c of seg) covered.add(c);
  }
  return { orphans: all.filter((c) => !covered.has(c)), unknown_span };
}

/**
 * t-078: which candidates' code the deployed sha already contains, measured with git. Only under the git-ancestor form
 * (project:absorb.form); any other form, or no deployed sha, is nothing to measure. Candidates git cannot place
 * (object missing locally, no evidence sha) are neither contained nor not: the board lists them as unknown.
 */
export function containment(b: Board, isAncestor: IsAncestor): { sha: string; contained: string[]; not_contained: string[]; unmeasured: string[]; method: string } | null {
  const sha = b.release?.deployed_sha;
  if (!sha || absorbFormOf(b) !== "git-ancestor") return null;
  const out = { sha, contained: [] as string[], not_contained: [] as string[], unmeasured: [] as string[], method: "git-ancestor（ateam release 用 git merge-base --is-ancestor 逐件测）" };
  for (const c of b.release.candidates ?? []) {
    const r = c.evidence_sha ? isAncestor(c.evidence_sha, sha) : null;
    (r === true ? out.contained : r === false ? out.not_contained : out.unmeasured).push(c.task);
  }
  return out;
}

/** The reading `ateam release` records when what git measured differs from the fact on the board; null when nothing changed. */
export function containmentFact(b: Board, measured: ReturnType<typeof containment>): ClientEvent | null {
  if (!measured) return null;
  // t-203：**这条事实原来只写两桶，第三桶算出来了却没写下去。** `containment()` 一直分三类（上面那个函数的注释
  // 里写着「neither contained nor not: the board lists them as unknown」），而这里只把 contained 与 not_contained
  // 落进日志——于是 unmeasured 那一桶在日志上不存在。
  //
  // 代价是真的：生产上写下的是 112 + 4，而当时共 201 件；**缺的 85 件里有 63 件的 verified_on 含 production**。
  // 读的人分不清「没上」与「量不出」，qa 据此报过两个数（42 件、109 件），两次都栽在这一处——它拿 contained
  // 当「生产上有什么」的全集，而那份名单缺了一桶。
  //
  // 三桶一个不少地写下去，比较也比三桶（少了这一条，unmeasured 变了不会触发新事实，那一桶就永远停在旧值）。
  const current = b.readings.find((r) => r.valid && r.surface === HUMAN_SURFACE && r.key === DEPLOYED_TASKS_KEY)?.value as { sha?: string; contained?: string[]; not_contained?: string[]; unmeasured?: string[] } | undefined;
  const same = (a?: string[], b?: string[]) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
  if (current && current.sha === measured.sha && same(current.contained, measured.contained) && same(current.not_contained, measured.not_contained) && same(current.unmeasured, measured.unmeasured)) return null;
  return { kind: "reading", surface: HUMAN_SURFACE, key: DEPLOYED_TASKS_KEY, value: { sha: measured.sha, contained: measured.contained, not_contained: measured.not_contained, unmeasured: measured.unmeasured, method: measured.method }, depends_on: ["production:deployed.sha"], method: measured.method } as ClientEvent;
}

export interface Git {
  isAncestor: IsAncestor;
  /** The remote's current tip of `branch`, or null when it does not exist. */
  remoteTip(branch: string): string | null;
  /** Push `sha` to `branch` on the remote (fast-forward only). Throws with git's message on failure. */
  push(sha: string, branch: string): void;
  /** Resolve a short sha to the full one, or null when unknown locally. */
  resolve(sha: string): string | null;
  /** t-209: the commits `from` does not have and `to` does, newest first. null when git cannot say. */
  revList: RevList;
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
    // t-209：`from..to` 里的提交。答不上来就答 null——「问不出来」与「一条都没有」是两件事。
    revList: (from, to) => { const r = run(["rev-list", `${from}..${to}`]); return r.status === 0 ? r.stdout.split("\n").map((x) => x.trim()).filter(Boolean) : null; },
    push: (sha, branch) => { const r = run(["push", remote(), `${sha}:refs/heads/${branch}`]); if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/x-access-token:[^@]+@/g, "x-access-token:***@")); },
    resolve: (sha) => { const r = run(["rev-parse", "--verify", `${sha}^{commit}`]); return r.status === 0 ? r.stdout.trim() : null; },
  };
}

/**
 * The lines of a git failure that say why (t-072): the "! [rejected]" / "error:" / "fatal:" / "remote: error" ones, at most
 * three, since git puts its hints after them and the note is one line for a person. None of those: the last three lines.
 */
export const GIT_REASON_LINES = 3;
export function gitReason(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const why = lines.filter((l) => /^(! \[|error:|fatal:|remote: error)/.test(l));
  return (why.length ? why.slice(0, GIT_REASON_LINES) : lines.slice(-GIT_REASON_LINES)).join(" ");
}

export interface DeployDeps {
  git: Git;
  me: string;
  hasCredential: boolean;
  /** t-093: a reason for pushing past unverified tasks; without it, they refuse the push. */
  anyway?: string;
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
  const p = plan(b, sha, deps.git.isAncestor, b.live?.deployed_sha ?? null, deps.git.revList);
  if (!p.ok && !deps.anyway) {
    // t-093 (M4): a refusal names its rule, lists what is not verified, and says what would happen with a branch name
    deps.print(`REFUSED (${DEPLOY_RULE}): 不推 ${sha.slice(0, 7)}，它比生产多出的提交里有还没验收的东西：`);
    for (const r of p.reasons) deps.print(`  - ${r}`);
    deps.print(`  推的是这个 sha，不是分支名：分支头随时可能前进到还没验收的提交上。要越过，写清理由：ateam release --deploy ${sha.slice(0, 7)} --anyway "<为什么现在必须推>"`);
    return "refused";
  }
  if (!p.ok && deps.anyway) {
    // t-093: going past is allowed, and leaves a trace: who, why, and exactly what was skipped
    await deps.note(`越过未验收推生产：${deps.me} 推 ${sha.slice(0, 7)}，跳过 ${p.unverified.join("、") || "（无具体任务）"}。理由：${deps.anyway}`);
    deps.print(`越过 ${p.unverified.length} 件未验收（已记进日志）：${p.unverified.join("、")}`);
  }
  const tip = deps.git.remoteTip(setting.branch);
  const already = tip !== null && (tip === sha || sha.startsWith(tip) || tip.startsWith(sha));
  const current = b.live?.deployed_sha ?? null;
  if (already) {
    deps.print(`${setting.branch} 已经在 ${sha.slice(0, 7)}，不再推。`);
    if (!current || !(current === sha || sha.startsWith(current) || current.startsWith(sha))) await deps.reading("deployed.sha", sha, { surface: HUMAN_SURFACE, writes: ["production:deployed.sha"], method: `ateam release --deploy：${setting.branch} 已在此 sha` });
    return "already";
  }
  try {
    deps.git.push(sha, setting.branch);
  } catch (err) {
    const why = (err as Error).message;
    await deps.note(`部署失败：${deps.me} 推 ${sha.slice(0, 7)} 到 ${setting.branch} 未成功：${gitReason(why)}`);
    deps.print(`推送失败：${why}`);
    return "failed";
  }
  deps.print(`已推 ${sha.slice(0, 7)} 到 ${setting.branch}（包含 ${p.included.length ? p.included.join("、") : "无候选任务"}）。`);
  await deps.reading("deployed.sha", sha, { surface: HUMAN_SURFACE, writes: ["production:deployed.sha"], method: `ateam release --deploy 推到 ${setting.branch}，由 CI 部署；含 ${p.included.join("、") || "无候选任务"}` });
  return "pushed";
}
