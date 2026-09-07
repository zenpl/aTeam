/**
 * t-052: the team pushes production itself, only when everything the sha carries is verified on repo.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent, type Board } from "@ateam/core";
import { deploy, deploySetting, plan, gitReason, containment, containmentFact, type Git } from "../src/release.js";

const HUMAN = "human";
const A = "aaaaaaa" + "1".repeat(33), B = "bbbbbbb" + "1".repeat(33), C = "ccccccc" + "1".repeat(33); // 40-char shas
// history: A -> B -> C ; X is unrelated
const X = "0000000" + "2".repeat(33);
const lineage: Record<string, string[]> = { [A]: [A], [B]: [A, B], [C]: [A, B, C], [X]: [X] };
const fakeGit = (opts: { tip?: string | null; pushFails?: string } = {}) => {
  const pushes: string[] = [];
  const g: Git & { pushes: string[] } = {
    pushes,
    isAncestor: (a, d) => lineage[d] ? lineage[d].some((s) => s.startsWith(a) || a.startsWith(s)) : null,
    remoteTip: () => opts.tip ?? null,
    push: (sha, branch) => { if (opts.pushFails) throw new Error(opts.pushFails); pushes.push(`${sha}->${branch}`); },
    resolve: (sha) => Object.keys(lineage).find((k) => k.startsWith(sha)) ?? null,
    // t-209：`from..to` 里的提交 = to 的祖先里去掉 from 的祖先。null 表示问不出来。
    revList: (from, to) => {
      if (!lineage[to] || !lineage[from]) return null;
      const had = new Set(lineage[from]);
      return lineage[to].filter((x) => !had.has(x)).reverse();
    },
  };
  return g;
};

async function world(enable: unknown = true) {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  if (enable !== null) await emit({ kind: "reading", actor: "pm", key: "deploy.enabled", surface: "project", value: enable });
  await emit({ kind: "reading", actor: "pm", key: "pm:能力", surface: "node", value: { push: "production" }, method: "join" }); // t-058: pm said it may push production
  const ship = async (id: string, sha: string, verify = true) => {
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] , no_human_impact: true});
    await emit({ kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    await emit({ kind: "task", op: "done", actor: "dev", task: id, evidence: `${sha.slice(0, 7)} 完成` , no_human_impact: true});
    if (verify) await emit({ kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true });
  };
  const b = async () => board(reduce(await store.read()), HUMAN);
  const log: string[] = [];
  const deps = (git: Git, me = "pm", cred = true) => ({
    git, me, hasCredential: cred,
    reading: async (key: string, value: unknown, extra: { surface: string; writes?: string[]; method?: string }) => { await emit({ kind: "reading", actor: me, key, value, surface: extra.surface, writes: extra.writes, method: extra.method }); },
    note: async (body: string) => { await emit({ kind: "note", actor: me, body }); },
    print: (l: string) => log.push(l),
  });
  return { store, emit, ship, b, log, deps };
}

describe("t-052 · deploy setting", () => {
  it("absent or false: not enabled; true: production by pm; an object names branch and roles", () => {
    const mk = (readings: Board["readings"]) => ({ readings } as unknown as Board);
    expect(deploySetting(mk([]))).toBeNull();
    expect(deploySetting(mk([{ valid: true, surface: "project", key: "deploy.enabled", value: false } as never]))).toBeNull();
    expect(deploySetting(mk([{ valid: true, surface: "project", key: "deploy.enabled", value: true } as never]))).toEqual({ branch: "production", by: ["pm"] });
    expect(deploySetting(mk([{ valid: true, surface: "project", key: "deploy.enabled", value: { branch: "main", by: ["pm", "dev"] } } as never]))).toEqual({ branch: "main", by: ["pm", "dev"] });
    expect(deploySetting(mk([{ valid: false, surface: "project", key: "deploy.enabled", value: true } as never]))).toBeNull();
  });
});

describe("t-052 · ateam release --deploy", () => {
  it("refuses when a task inside the sha is not verified on repo or has an open seam; nothing is pushed or recorded", async () => {
    const w = await world();
    await w.ship("t-1", A);
    await w.ship("t-2", B, false); // done, not verified
    const git = fakeGit();
    expect(await deploy(await w.b(), C, w.deps(git))).toBe("refused");
    expect(w.log.join("\n")).toMatch(/REFUSED \(deploy-unverified\): 不推 ccccccc[^\n]*\n {2}- t-2（done[^\n]*证据 bbbbbbb 在这个 sha 里/); // t-093 reworded the refusal and named its rule
    expect(git.pushes).toEqual([]);
    expect((await w.b()).live.deployed_sha).toBeNull();
    const p = plan(await w.b(), B, git.isAncestor);
    expect(p.included).toEqual(["t-1", "t-2"]);
  });

  it("pushes when everything inside is verified, records deployed.sha with --writes and who pushed; the same sha again is idempotent", async () => {
    const w = await world();
    await w.ship("t-1", A);
    await w.ship("t-2", B);
    const git = fakeGit();
    expect(await deploy(await w.b(), "bbbbbbb", w.deps(git))).toBe("pushed");
    expect(git.pushes).toEqual([`${B}->production`]);
    let b = await w.b();
    expect(b.live).toMatchObject({ deployed_sha: B, deployed_by: "pm" });
    expect(b.release.candidates.map((c) => c.task)).toEqual(["t-1", "t-2"]); // still awaiting production verification
    expect(w.log.at(-1)).toContain("已推 bbbbbbb 到 production（包含 t-1、t-2）");
    // again: the remote is already there; no second push, no second reading
    const again = fakeGit({ tip: B });
    const readingsBefore = b.readings.length;
    expect(await deploy(b, B, w.deps(again))).toBe("already");
    expect(again.pushes).toEqual([]);
    expect((await w.b()).readings.length).toBe(readingsBefore);
  });

  it("a failed push leaves a note and no deployed.sha; a role that may not deploy, or no credential, is refused; not enabled is skipped", async () => {
    const w = await world();
    await w.ship("t-1", A);
    const bad = fakeGit({ pushFails: "! [rejected] non-fast-forward" });
    expect(await deploy(await w.b(), A, w.deps(bad))).toBe("failed");
    const b = await w.b();
    expect(b.live.deployed_sha).toBeNull();
    expect((await w.store.read()).events.filter((e) => e.kind === "note").map((e) => (e as { body: string }).body)).toEqual([expect.stringMatching(/^部署失败：pm 推 aaaaaaa 到 production 未成功：! \[rejected\] non-fast-forward/)]);
    expect(await deploy(b, A, w.deps(fakeGit(), "dev"))).toBe("refused");
    expect(w.log.at(-1)).toBe("只有 pm 可以推 production，你是 dev。");
    expect(await deploy(b, A, w.deps(fakeGit(), "pm", false))).toBe("refused");
    expect(w.log.at(-1)).toContain("缺的是凭据");
    expect(await deploy(b, "fffffff", w.deps(fakeGit()))).toBe("refused"); // unknown locally
    const off = await world(null);
    expect(await deploy(await off.b(), A, off.deps(fakeGit()))).toBe("skipped");
    expect(off.log).toEqual(["这个项目没有开启团队部署（事实 project:deploy.enabled），什么都没做。"]);
  });
});

describe("t-058 · release --deploy checks what the pusher said it may push", () => {
  it("a pusher whose capability fact is missing or below production is refused for lack of permission, before anything is pushed; no credential is refused for lack of credential", async () => {
    const w = await world();
    await w.ship("t-1", A);
    for (const push of ["none", "own-branch", "integration"]) {
      await w.emit({ kind: "reading", actor: "pm", key: "pm:能力", surface: "node", value: { push } });
      const git = fakeGit();
      expect(await deploy(await w.b(), A, w.deps(git))).toBe("refused");
      expect(w.log.at(-1)).toBe(`不推：你（pm）加入时声明的推送能力是 ${push}，推 production 要 production。缺的是许可：human 许可后，用 ateam join --me pm --push production 重新声明。`);
      expect(git.pushes).toEqual([]);
    }
    // a fact that is not an object, or a push nobody knows, counts as none
    await w.emit({ kind: "reading", actor: "pm", key: "pm:能力", surface: "node", value: ["写仓库"] });
    expect((await w.b()).presence.find((p) => p.actor === "pm")!.push).toBe("none");
    expect(await deploy(await w.b(), A, w.deps(fakeGit()))).toBe("refused");
    expect(w.log.at(-1)).toContain("推送能力是 none");
    await w.emit({ kind: "reading", actor: "pm", key: "pm:能力", surface: "node", value: { push: "production", can: ["有网"] } });
    expect((await w.b()).presence.find((p) => p.actor === "pm")!.push).toBe("production");
    expect(await deploy(await w.b(), A, w.deps(fakeGit(), "pm", false))).toBe("refused");
    expect(w.log.at(-1)).toBe("不推：环境里没有推送凭据（ATEAM_DEPLOY_TOKEN）。缺的是凭据，不是许可。");
    const git = fakeGit();
    expect(await deploy(await w.b(), A, w.deps(git))).toBe("pushed");
    expect(git.pushes).toEqual([`${A}->production`]);
  });
});

describe("qa 21:22 · the failure note carries git's reason, not its hints", () => {
  it("picks the rejected/error/fatal lines; falls back to the last three", () => {
    const stderr = "To github.com:x/y.git\n ! [rejected]        a57793b -> production (non-fast-forward)\nerror: failed to push some refs to 'github.com:x/y.git'\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. If you want to integrate the remote changes, use 'git pull'\nhint: before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.";
    expect(gitReason(stderr)).toBe("! [rejected]        a57793b -> production (non-fast-forward) error: failed to push some refs to 'github.com:x/y.git'");
    expect(gitReason("a\nb\nc\nd")).toBe("b c d");
    // the other three qa saw on a real git (21:31): bad credentials, a repository that is not there, no network
    expect(gitReason("fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403")).toBe("fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403");
    expect(gitReason("fatal: '/nonexistent/repo.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.")).toBe("fatal: '/nonexistent/repo.git' does not appear to be a git repository fatal: Could not read from remote repository.");
    expect(gitReason("fatal: unable to access 'https://github.com/x/y.git/': CONNECT tunnel failed, response 403")).toBe("fatal: unable to access 'https://github.com/x/y.git/': CONNECT tunnel failed, response 403");
    // branch protection says four things; the note keeps the first three (criterion 1: at most three lines)
    const protectedBranch = "remote: error: GH006: Protected branch update failed for refs/heads/production.\nremote: error: Required status check \"ci\" is expected.\nTo github.com:x/y.git\n ! [remote rejected] c029f47 -> production (protected branch hook declined)\nerror: failed to push some refs to 'github.com:x/y.git'";
    expect(gitReason(protectedBranch)).toBe("remote: error: GH006: Protected branch update failed for refs/heads/production. remote: error: Required status check \"ci\" is expected. ! [remote rejected] c029f47 -> production (protected branch hook declined)");
  });
});

describe("t-078 · ateam release measures containment with git and shows three groups", () => {
  it("only under git-ancestor and a known deployed sha; contained / not / unmeasured; the fact is written once and not rewritten unchanged", async () => {
    const w = await world();
    await w.emit({ kind: "reading", actor: "pm", key: "absorb.form", surface: "project", value: "git-ancestor" });
    await w.ship("t-1", A);
    await w.ship("t-2", X);
    let b = await w.b();
    expect(containment(b, fakeGit().isAncestor)).toBeNull(); // no deployed sha yet: nothing to measure
    await w.emit({ kind: "reading", actor: "pm", key: "deployed.sha", surface: "production", value: B, method: "ateam release --deploy 推到 production", depends_on: ["production:deployed.sha"] });
    b = await w.b();
    const measured = containment(b, fakeGit().isAncestor)!;
    expect(measured.sha).toBe(B);
    expect(measured.contained).toEqual(["t-1"]); // A is an ancestor of B
    expect(measured.not_contained).toEqual(["t-2"]); // X is unrelated
    expect(measured.unmeasured).toEqual([]);
    const fact = containmentFact(b, measured)!;
    expect(fact).toMatchObject({ kind: "reading", surface: "production", key: "deployed.tasks", depends_on: ["production:deployed.sha"] });
    await w.emit({ ...(fact as { key: string; value: unknown; surface: string }), actor: "pm" } as never);
    expect(containmentFact(await w.b(), measured)).toBeNull(); // nothing changed: no second reading
    // git that cannot tell leaves the task unmeasured, and the board will call it unknown
    const blind = containment(await w.b(), () => null)!;
    expect(blind.unmeasured.sort()).toEqual(["t-1", "t-2"]);
    expect(blind.contained).toEqual([]);
    // t-203 判据 1：三桶一个不少地写进事实——unmeasured 算出来了，就得落进日志
    const blindFact = containmentFact(await w.b(), blind)! as unknown as { value: Record<string, unknown> };
    expect(blindFact.value.unmeasured, "第三桶算出来了却没写下去，正是那 85 件无声消失的形状").toEqual(["t-1", "t-2"]);
    expect(blindFact.value).toMatchObject({ contained: [], not_contained: [] });
    // 比较也比三桶：**只有 unmeasured 变了**，也要写一条新事实——否则那一桶永远停在旧值。
    //
    // qa 13:51 证过我上一版这条是空的：它拿刚落的那条（contained ["t-1"]）去比一个 contained 为空的，
    // 判断在第一桶就分出来了，**永远走不到第三桶那一步**——删掉比较第三桶的那半句，cli 一条都不红。
    // 所以先把 blind 那条真的落下去，再造一个**只有第三桶不同**的：其余逐字相同，差别只在 unmeasured。
    await w.emit({ ...(blindFact as unknown as { key: string; value: unknown; surface: string }), actor: "pm" } as never);
    expect(containmentFact(await w.b(), blind), "逐字相同却又写一条新事实").toBeNull();
    const onlyThird = { ...blind, unmeasured: ["t-1"] };
    expect(containmentFact(await w.b(), onlyThird), "只有第三桶变了，却不写新事实——那一桶会永远停在旧值").not.toBeNull();

    // another absorb form: not our business to measure
    const other = await world();
    await other.emit({ kind: "reading", actor: "pm", key: "absorb.form", surface: "project", value: "named-sha" });
    await other.emit({ kind: "reading", actor: "pm", key: "deployed.sha", surface: "production", value: B, method: "m", depends_on: ["production:deployed.sha"] });
    expect(containment(await other.b(), fakeGit().isAncestor)).toBeNull();
  });
});

describe("t-093 · the deploy entry refuses a sha that adds unverified work", () => {
  const world93 = async () => {
    const w = await world();
    await w.emit({ kind: "reading", actor: "pm", key: "pm:能力", surface: "node", value: { push: "production" } });
    return w;
  };
  /** ship(id, sha, how): verified | done (repo-verified, not the whole task) | failed */
  const ship = async (w: Awaited<ReturnType<typeof world93>>, id: string, sha: string, how: "verified" | "done" | "failed") => {
    await w.emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] , no_human_impact: true});
    await w.emit({ kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    await w.emit({ kind: "task", op: "done", actor: "dev", task: id, evidence: `${sha.slice(0, 7)} 完成` , no_human_impact: true});
    if (how === "verified") await w.emit({ kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: true });
    if (how === "failed") await w.emit({ kind: "task", op: "verify", actor: "qa", task: id, surface: "repo", pass: false, evidence: "差一条" });
  };

  it("all verified: it pushes; one done-but-unverified or failed: refused, naming the rule, the tasks and the sha-vs-branch trap", async () => {
    const w = await world93();
    await ship(w, "t-1", A, "verified");
    const git = fakeGit();
    expect(await deploy(await w.b(), A, w.deps(git))).toBe("pushed");
    expect(git.pushes).toEqual([`${A}->production`]);
    // B adds a task nobody verified
    await ship(w, "t-2", B, "done");
    const git2 = fakeGit();
    expect(await deploy(await w.b(), B, w.deps(git2))).toBe("refused");
    expect(git2.pushes).toEqual([]);
    const said = w.log.join("\n");
    expect(said).toContain("REFUSED (deploy-unverified)");
    expect(said).toContain("t-2");
    expect(said).toContain("推的是这个 sha，不是分支名");
    expect(said).toContain('--anyway "<为什么现在必须推>"');
    // a failed one is refused the same way
    const f = await world93();
    await ship(f, "t-9", A, "failed");
    expect(await deploy(await f.b(), A, f.deps(fakeGit()))).toBe("refused");
    expect(f.log.join("\n")).toContain("REFUSED (deploy-unverified)");
  });

  it("--anyway with a reason pushes and writes what was skipped and why; what is already live is not this push's problem", async () => {
    const w = await world93();
    await ship(w, "t-1", A, "verified");
    await ship(w, "t-2", B, "done");
    const git = fakeGit();
    const deps = { ...w.deps(git), anyway: "生产在报错，这一版含修复，t-2 明早补验" };
    expect(await deploy(await w.b(), B, deps)).toBe("pushed");
    expect(git.pushes).toEqual([`${B}->production`]);
    const notes = (await w.store.read()).events.filter((e) => e.kind === "note").map((e) => (e as { body: string }).body);
    const trace = notes.find((n) => n.startsWith("越过未验收推生产"))!;
    expect(trace).toContain("pm 推 bbbbbbb");
    expect(trace).toContain("跳过 t-2");
    expect(trace).toContain("理由：生产在报错，这一版含修复，t-2 明早补验");
    // now production runs B: pushing C, which adds nothing unverified, is fine even though t-2 is still unverified
    await w.emit({ kind: "reading", actor: "pm", key: "deployed.sha", surface: "production", value: B, method: "ateam release --deploy 推到 production", depends_on: ["production:deployed.sha"] });
    await ship(w, "t-3", C, "verified");
    const git3 = fakeGit();
    expect(await deploy(await w.b(), C, w.deps(git3))).toBe("pushed");
    expect(git3.pushes).toEqual([`${C}->production`]);
  });
});

/**
 * t-209 · **发车闸只数任务，于是不是任务的东西它看不见。**
 *
 * 它一直只问一个方向：「每件任务的证据 sha 在不在这个 sha 里」。反过来那一问从来没人问过——**这一批里有哪些
 * 提交不属于任何一件任务的证据链？** 真样本是 9ac8cee（dev 补 t-206 那道闸自己的两处盲区）：在 b537a31 之后、
 * 不在 a134fcc 里，qa 14:05 量到**没有任何任务盖着它，也就没有任何判决盖着它**，而它照样会跟着上生产。
 *
 * 这是 t-203 同一个形状的第二例：分母漏了一类。那次漏的是「量不出」那一桶，这次漏的是「不是任务的提交」。
 */
describe("t-209 · 没有任务盖着的提交，发车前要被点名", () => {
  const orphanWorld = async () => {
    const store = new MemoryStore();
    let t = Date.now() - 3600_000;
    const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 1000)) });
    await emit({ kind: "reading", actor: "pm", surface: "project", key: "absorb.form", value: "git-ancestor" });
    await emit({ kind: "task", op: "create", actor: "pm", task: "t-1", title: "题", criteria: ["x"], no_human_impact: true });
    await emit({ kind: "task", op: "claim", actor: "dev", task: "t-1", touches: ["a"] });
    await emit({ kind: "task", op: "done", actor: "dev", task: "t-1", evidence: `${B} 完成`, no_human_impact: true });
    await emit({ kind: "task", op: "verify", actor: "qa", task: "t-1", surface: "repo", pass: true });
    return board(reduce(await store.read()), HUMAN);
  };

  it("判据 1、4 正例：目标 sha 比任何任务的证据都新，多出来的那条提交被点名", async () => {
    const b = await orphanWorld();
    // 生产在 A；这一批推到 C，而唯一一件任务的证据是 B——C 自己没有任何任务盖着
    const p = plan(b, C, fakeGit().isAncestor, A, fakeGit().revList);
    expect(p.orphans, "C 没有任何任务盖着它").toEqual([C]);
    expect(p.ok, "有孤儿提交就不该直接放行").toBe(false);
    expect(p.reasons.join("\n")).toContain("不属于任何一件任务的证据链");
    expect(p.reasons.join("\n"), "要说得出是哪一条").toContain(C.slice(0, 7));
  });

  it("判据 4 反例：把它并进任务的证据链之后，就不再被点名", async () => {
    const b = await orphanWorld();
    // 同一批，但任务的证据就是 C 本身：这一批里每一条提交都有任务盖着
    const withC = JSON.parse(JSON.stringify(b)) as Board;
    for (const t of Object.values(withC.tasks).flat()) if (t.id === "t-1") t.evidence_sha = C;
    const p = plan(withC, C, fakeGit().isAncestor, A, fakeGit().revList);
    expect(p.orphans, "证据链盖住了 B 与 C，一条孤儿都不该剩").toEqual([]);
    expect(p.reasons.join("\n")).not.toContain("不属于任何一件任务");
  });

  it("问不出来答 null，不是空数组——「没问出来」与「一条都没有」是两件事", async () => {
    const b = await orphanWorld();
    expect(plan(b, C, fakeGit().isAncestor, A).orphans, "没有 revList 就问不出来").toBeNull();
    expect(plan(b, C, fakeGit().isAncestor, null, fakeGit().revList).orphans, "没有生产头就没有「这一批」").toBeNull();
    // git 答不上来（那个 sha 本地根本没有）：同样是 null，不许当成「一条都没有」
    const unknown = "9999999" + "9".repeat(33);
    expect(plan(b, C, fakeGit().isAncestor, unknown, fakeGit().revList).orphans).toBeNull();
  });

  it("null 不构成拒绝：它只是说不出来，报警要有东西可指", async () => {
    const b = await orphanWorld();
    const p = plan(b, B, fakeGit().isAncestor, A);   // 没有 revList
    expect(p.orphans).toBeNull();
    expect(p.reasons.join("\n")).not.toContain("不属于任何一件任务");
  });
});
