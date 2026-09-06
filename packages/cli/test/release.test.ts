/**
 * t-052: the team pushes production itself, only when everything the sha carries is verified on repo.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent, type Board } from "@ateam/core";
import { deploy, deploySetting, plan, type Git } from "../src/release.js";

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
  };
  return g;
};

async function world(enable: unknown = true) {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  if (enable !== null) await emit({ kind: "reading", actor: "pm", key: "deploy.enabled", surface: "project", value: enable });
  const ship = async (id: string, sha: string, verify = true) => {
    await emit({ kind: "task", op: "create", actor: "pm", task: id, title: id, criteria: ["x"] });
    await emit({ kind: "task", op: "claim", actor: "dev", task: id, touches: [id] });
    await emit({ kind: "task", op: "done", actor: "dev", task: id, evidence: `${sha.slice(0, 7)} 完成` });
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
    expect(w.log.join("\n")).toMatch(/不推 ccccccc：\n {2}- t-2 的证据 bbbbbbb 在这个 sha 里，但还没在 repo 验过（done）/);
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
    expect(w.log.at(-1)).toContain("没有推送凭据");
    expect(await deploy(b, "fffffff", w.deps(fakeGit()))).toBe("refused"); // unknown locally
    const off = await world(null);
    expect(await deploy(await off.b(), A, off.deps(fakeGit()))).toBe("skipped");
    expect(off.log).toEqual(["这个项目没有开启团队部署（事实 project:deploy.enabled），什么都没做。"]);
  });
});
