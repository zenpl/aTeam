/**
 * t-132（S3）· **在生产和仓库之间多一个 staging 表面。**
 *
 * 这一件只做判据 1 的前两样（部署目标、表面），第三样——**staging 与生产共用不共用同一条日志**——是产品判断，
 * 归 pd，必要时它问 human（判据 2，pm 03:25）。所以这里不许出现任何一个「我们选了哪一种」的断言。
 *
 * 判据 3 记着的那次教训：`repo` 上验的是新形态、生产上跑的是旧形态，**牌桌当时的样子没有任何一次验收对应它**。
 * 多一个表面就多一处能说假话的地方，所以下面两半各自被钉住：
 * ① 「验过」说得出是在**哪个**表面验的；
 * ② **在 staging 验过绝不等于在生产验过**（判据 4）——这条界线不因为多了一个表面就松。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MemoryStore, append, reduce, board, Rejected, SURFACES, HUMAN_SURFACE, surfaceResults, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);
const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

async function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  await put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] }, -300);
  await put({ kind: "task", actor: "pm", op: "create", task: "t-1", title: "题", criteria: ["能用"], no_human_impact: true }, -200);
  await put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["x"] }, -190);
  await put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "abc1234", no_human_impact: true }, -100);
  return { s, put };
}
const st = async (s: MemoryStore) => reduce(await s.read(), at(0));

describe("t-132 · staging 是一个表面，不是生产的别名", () => {
  it("判据 1②：staging 上落得下事实与验收，与别的表面一样", async () => {
    const w = await world();
    await w.put({ kind: "reading", actor: "qa", surface: "staging", key: "deployed.sha", value: "abc1234", method: "看 GET /health" }, -50);
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "staging", pass: true, evidence: "在 staging 上走了一遍" }, -40);
    const t = (await st(w.s)).tasks.get("t-1")!;
    expect(t.status).toBe("verified");
    expect(surfaceResults(t)).toEqual([{ surface: "staging", pass: true }]);
  });

  it("判据 3：「验过」说得出是在哪个表面验的——两个表面各验一次，两个都在", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: true }, -60);
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "staging", pass: true }, -50);
    const b = board(await st(w.s), HUMAN, at(0));
    const row = (b.tasks.verified ?? []).find((x) => x.id === "t-1")!;
    expect(row.verified_on, "在哪几个表面验过，一个不少地说出来").toEqual(["repo", "staging"]);
  });

  it("判据 4：在 staging 验过不等于在生产验过——牌桌上分得开", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "staging", pass: true }, -50);
    const b = board(await st(w.s), HUMAN, at(0));
    const row = (b.tasks.verified ?? []).find((x) => x.id === "t-1")!;
    expect(row.verified_on).toEqual(["staging"]);
    expect(row.verified_on).not.toContain(HUMAN_SURFACE);
    // 「人那边好了」那一栏只认 production：staging 上的 pass 一件都不进
    expect((b.live.verified_on_production ?? []).map((x) => x.id), "staging 上验过的活混进了「生产上验过」").toEqual([]);
  });

  it("判据 4 的另一半：生产上验过才算——同一件在生产上再验一次，两栏才对得上", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "staging", pass: true }, -50);
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "production", pass: true }, -40);
    const b = board(await st(w.s), HUMAN, at(0));
    expect((b.live.verified_on_production ?? []).map((x) => x.id)).toEqual(["t-1"]);
  });

  /**
   * **量出来的一条，不是我假设的**：表面之间对 pass 是相互独立的（上面几条），**对 fail 不是**——
   * 任何一个表面上的一次 fail 把整件活变回 `failed`，此后别的表面一律落不下验收，要等一次新的 done。
   *
   * 我原本写的这条用例断言的是「互不相干」，跑出来才知道不是。**多一个 staging，这条规矩的影响面就大一圈**：
   * 一次 staging 上的 fail 会挡住生产上的验收。这是对是错不是我能定的——它是「一件活在几个表面之间怎么算完成」
   * 的问题，归 pm 排、必要时归 pd。我只把行为钉在这里，并已另发一条问它。
   */
  it("表面对 pass 独立，对 fail 不独立：一次 fail 之后，别的表面也要等一次新的 done", async () => {
    const w = await world();
    await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "staging", pass: false, evidence: "staging 上第 2 条不成立" }, -50);
    const err = await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: true }, -40).catch((x) => x as Rejected);
    expect(err, "staging 上的一次 fail 挡住了 repo 上的验收").toBeInstanceOf(Rejected);
    expect(err.message).toContain("failed");
    // 新的一轮之后，别的表面又能判了——挡住的是「这一轮」，不是这个表面
    await w.put({ kind: "task", actor: "dev", op: "reopen", task: "t-1", reason: "staging 上那一条要重做" }, -35);
    await w.put({ kind: "task", actor: "dev", op: "claim", task: "t-1", touches: ["x"] }, -33);
    await w.put({ kind: "task", actor: "dev", op: "done", task: "t-1", evidence: "def5678", no_human_impact: true }, -30);
    const e = await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "repo", pass: true }, -20);
    expect(e.kind).toBe("task");
  });

  it("不写表面就落不下验收——形状那道闸先拦住它", async () => {
    const w = await world();
    const err = await w.put({ kind: "task", actor: "qa", op: "verify", task: "t-1", surface: "", pass: true } as unknown as NewEvent, -50).catch((x) => x as Rejected);
    expect(err).toBeInstanceOf(Rejected);
    expect(err.rule, "空表面被形状闸拦下，rules 里那句提示今天走不到").toBe("shape");
  });

  it("SURFACES 里有 staging，而且那句提示是从它生成的——加一个表面不会漏掉它", () => {
    expect([...SURFACES]).toContain("staging");
    expect(HUMAN_SURFACE, "人真的看得到的只有一个").toBe("production");
    // 提示那一句由 SURFACES.join 拼出来，不是手写的常量：源码里找得到这个拼法
    const rules = readFileSync(`${ROOT}/packages/core/src/rules.ts`, "utf8");
    expect(rules, "那句提示又被写死成一份手抄的名单").toContain("SURFACES.join(");
  });

  it("判据 1①：staging 有部署目标，而它此刻拒绝部署——缺的是 pd 那个决定，不是一行配置", () => {
    const cfg = readFileSync(`${ROOT}/fly.staging.toml`, "utf8");
    expect(cfg).toContain('app = "ateam-staging"');
    // 这一行是那个未决的判断本身。**用例不许断言它是 shared 还是 own**——判据 2 说了不许自行选一个。
    expect(cfg.match(/^# STAGING_LOG_DECISION: *(\S+)/m)?.[1], "有人替 pd 把这个决定填了").toBe("unset");
    const deploy = readFileSync(`${ROOT}/bin/deploy`, "utf8");
    expect(deploy).toContain("fly.staging.toml");
    expect(deploy, "拒绝时要把两条路都说出来，不是只说「不行」").toContain("共用");
  });
});
