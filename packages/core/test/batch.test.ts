/**
 * t-129: a batch is a reading that expires by itself, and its expiry says which of two kinds it is.
 *
 * The night this came from: pm froze be9b232 while production was eae0b22. Production became 7f31808, and nothing in
 * the log went stale — so the same dead sha was repeated in an instruction and in the focus, three times, and pushing
 * it would have taken t-080 and half of t-079 back off production. Nothing said so. Two different things had gone
 * wrong at once and both looked identical: "the batch is old".
 *
 * All times relative to now.
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, batches, BATCH_LINES, deployedTasksFact, type NewEvent } from "../src/index.js";

const HUMAN = "human";
const T0 = Date.now();
const at = (mins: number) => new Date(T0 + mins * 60_000);
const OLD = "eae0b22e1c645274e3cebdd1b569c26326b98aaf";
const NEW = "7f31808ae1c645274e3cebdd1b569c26326b98ab";

function world() {
  const s = new MemoryStore();
  const put = (e: NewEvent, mins: number) => append(s, e, { human: HUMAN, now: at(mins) });
  const state = async (mins: number) => reduce(await s.read(), at(mins));
  return { s, put, state };
}
const deployed = (sha: string, mins: number, w: ReturnType<typeof world>) =>
  w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: sha, method: "ateam release --deploy", writes: ["production:deployed.sha"] }, mins);
const contains = (sha: string, contained: string[], not_contained: string[], mins: number, w: ReturnType<typeof world>) =>
  w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks", value: { sha, contained, not_contained, method: "git merge-base --is-ancestor 逐件" } }, mins);
const pack = (name: string, sha: string, base: string, list: string[], mins: number, w: ReturnType<typeof world>) =>
  w.put({ kind: "reading", actor: "release", surface: "repo", key: `batch.${name}`, value: { sha, base, contains: list }, method: "装配", depends_on: ["production:deployed.sha"] }, mins);
const seen = async (w: ReturnType<typeof world>, mins: number) => {
  const st = await w.state(mins);
  const b = board(st, HUMAN, at(mins));
  return { st, b, batch: (name: string) => b.batches.find((x) => x.name === name)! };
};

describe("t-129 · a batch expires by itself, and says which kind of expiry it is", () => {
  it("packed on where production is: nothing to say", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await contains(OLD, ["t-1"], ["t-2"], 1, w);
    await pack("8b", "be9b232", OLD, ["t-1", "t-2"], 2, w);
    const { batch } = await seen(w, 3);
    expect(batch("8b").state).toBe("current");
    expect(batch("8b").line).toBe("");
    expect(batch("8b").loses).toEqual([]);
  });

  it("production moved and the batch has everything it has: pack it again", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8b", "be9b232", OLD, ["t-1", "t-2", "t-3"], 1, w);
    await deployed(NEW, 2, w);
    await contains(NEW, ["t-1", "t-2"], ["t-3"], 3, w);
    const { st, batch } = await seen(w, 4);
    expect(batch("8b").state).toBe("stale");
    expect(batch("8b").loses).toEqual([]);
    expect(batch("8b").line).toBe(BATCH_LINES.stale(OLD));
    expect(batch("8b").line).toContain("重装一次就能把新验的一起带上");
    expect(batch("8b").line).not.toContain(NEW.slice(0, 7));   // pd 05:01: the reader needs 生产已经往前走了, not another sha
    // the reading itself went stale on its own, because it said what it depends on — nobody had to remember
    const r = [...st.readings.values()].find((x) => x.reading.key === "batch.8b")!;
    expect(r.valid).toBe(false);
    expect(r.invalidated_by).toBeTruthy();
  });

  it("production carries work the batch does not: pushing it would take that work back, by name", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8b", "be9b232", OLD, ["t-079b", "t-081"], 1, w);
    await deployed(NEW, 2, w);                                        // the hotfix went out on its own
    await contains(NEW, ["t-080", "t-079a", "t-081"], ["t-079b"], 3, w);
    const { batch } = await seen(w, 4);
    expect(batch("8b").state).toBe("rollback");
    expect(batch("8b").loses).toEqual(["t-080", "t-079a"]);            // the two the night really lost
    expect(batch("8b").line).toBe(BATCH_LINES.rollback(OLD, ["t-080", "t-079a"]));
    expect(batch("8b").line).toContain("重装，别推");   // pd 05:01: those four characters are the action, never dropped
    expect(batch("8b").line).toContain("t-080、t-079a");
  });

  it("no containment fact for the current head: it says it cannot tell, and why, rather than guessing", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8b", "be9b232", OLD, ["t-1"], 1, w);
    await deployed(NEW, 2, w);                                        // nobody has run `ateam release` against NEW
    const { b, batch } = await seen(w, 3);
    expect(batch("8b").state).toBe("unknown");
    expect(batch("8b").loses).toEqual([]);
    expect(batch("8b").line).toBe(BATCH_LINES.unknown(b.release.basis));
    expect(batch("8b").line).not.toContain("重装一次就能");            // never an answer it does not have
    expect(batch("8b").line).not.toContain("别推");
    // a fact measured against the *old* head is not a fact about this one
    await contains(OLD, ["t-1"], [], 4, w);
    expect((await seen(w, 5)).batch("8b").state).toBe("unknown");
  });

  it("several batches, newest first, each judged on its own base", async () => {
    const w = world();
    await deployed(OLD, 0, w);
    await pack("8a", "aaaaaaa", OLD, ["t-1"], 1, w);
    await pack("8b", "bbbbbbb", OLD, ["t-1", "t-2"], 2, w);
    await deployed(NEW, 3, w);
    await contains(NEW, ["t-1", "t-2"], ["t-3"], 4, w);
    await pack("8c", "ccccccc", NEW, ["t-1", "t-2", "t-3"], 5, w);
    const { b } = await seen(w, 6);
    expect(b.batches.map((x) => [x.name, x.state])).toEqual([["8c", "current"], ["8b", "stale"], ["8a", "rollback"]]);
    expect(b.batches.find((x) => x.name === "8a")!.loses).toEqual(["t-2"]);
  });

  it("judged on the same basis the release split uses: the two can never disagree", async () => {
    const w = world();
    await deployed(NEW, 0, w);
    await pack("8c", "ccccccc", OLD, ["t-1"], 1, w);
    const { st, b } = await seen(w, 2);
    expect(deployedTasksFact(st)).toBeNull();
    expect(b.batches[0].line).toContain(b.release.basis);              // one reason, said once
    expect(batches(st, b.release.deployed_sha, b.release.basis, deployedTasksFact(st))[0].state).toBe("unknown");
  });
});

/**
 * t-167：牌桌对**已经上了生产的那一批**说「推它会把 85 件退回去，重装，别推」。
 *
 * 根因不是判错了状态，是状态表里没有「它已经发生了」那一格（pd 08:13）：四态是按「这批将来会怎样」分的，而世界
 * 一定会走到「它已经推上去了」。一批上线的那一刻，它的 base 落后一格、它自己就翻成 rollback——**每一批上线都会
 * 开始说这句假话**。今晚牌桌上五行批次，五行全在说。
 *
 * 所以补的是格，而且是两格：就是现在生产上跑的那一版，和早先上过线、被后面盖过去的。
 */
describe("t-167 · 补的是格不是 if", () => {
  const A = "aaaaaaa1111111111111111111111111111aaaa";
  const B = "bbbbbbb2222222222222222222222222222bbbb";
  const C = "ccccccc3333333333333333333333333333cccc";

  /** 两次上线：先 A，再 B。三批：装成 A 的、装成 B 的、以及一个装在 B 上还没推的。 */
  const shipped = async () => {
    const w = world();
    await w.put({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa", "release"] }, -300);
    for (const [id, sha] of [["t-1", A], ["t-2", B]] as const) {
      await w.put({ kind: "task", actor: "pm", op: "create", task: id, title: `题 ${id}`, criteria: ["能用"] }, -200);
      await w.put({ kind: "task", actor: "dev", op: "claim", task: id, touches: [id] }, -199);
      await w.put({ kind: "task", actor: "dev", op: "done", task: id, evidence: `${sha.slice(0, 7)}：做完了`, no_human_impact: true }, -198);
      await w.put({ kind: "task", actor: "qa", op: "verify", task: id, surface: "repo", pass: true, evidence: "跑过了" }, -197);
    }
    await w.put({ kind: "reading", actor: "release", surface: "repo", key: "batch.甲", value: { sha: A, base: "0000000", contains: ["t-1"] }, method: "装配" }, -120);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: A, method: "deploy", writes: ["production:deployed.sha"] }, -110);
    await w.put({ kind: "reading", actor: "release", surface: "repo", key: "batch.乙", value: { sha: B, base: A, contains: ["t-2"] }, method: "装配" }, -100);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: B, method: "deploy", writes: ["production:deployed.sha"] }, -90);
    await w.put({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks", value: { sha: B, contained: ["t-1", "t-2"], not_contained: [], method: "git-ancestor" }, depends_on: ["production:deployed.sha"] }, -85);
    return w;
  };
  const rows = async (w: ReturnType<typeof world>, mins = 0) => {
    const s = await w.state(mins);
    const live = [...s.readings.values()].map((x) => x.reading).filter((r) => r.surface === "production" && r.key === "deployed.sha").pop()!;
    return Object.fromEntries(batches(s, live.value as string, null, deployedTasksFact(s)).map((x) => [x.name, x]));
  };

  it("就是现在生产上跑的那一版：说 pd 的那句，且不说「退回去」", async () => {
    const b = (await rows(await shipped()))["乙"];
    expect(b.state).toBe("deployed");
    expect(b.line).toBe(BATCH_LINES.deployed());
    expect(b.line).toBe("这一批已经在生产上跑着");   // pd 08:13 的字，一个字不改
    expect(b.line).not.toContain("退回去");
    expect(b.line).not.toContain("别推");
    expect(b.line).not.toContain("无需操作");        // pd：那是在回答一个人没问的问题
    expect(b.loses).toEqual([]);
  });

  it("早先上过线、被后面盖过去的：不再说「退回去」，并且有自己的一句话——沉默在一排会说话的行里像坏了", async () => {
    const b = (await rows(await shipped()))["甲"];
    expect(b.state).toBe("shipped");
    expect(b.line).toBe(BATCH_LINES.shipped());
    expect(b.line).toBe("这一批上过线，后来被更新的一版盖过。");   // pd 08:18 的字
    expect(b.line).not.toContain("已作废");                        // pd：它没作废，它发生过
    expect(b.line).not.toContain("退回去");
    expect(b.loses).toEqual([]);
  });

  it("上过线的都不再是上线候选：清单是「接下来要发生什么」", async () => {
    const r = await rows(await shipped());
    expect(r["乙"].pending).toBe(false);   // 就是现在生产上跑的
    expect(r["甲"].pending).toBe(false);   // 早先上过线的
    // 一批候选都没有时，那句话也在 core 一处，渲染方不印一片空白
    expect(Object.values(r).some((x) => x.pending)).toBe(false);
    expect(BATCH_LINES.allShipped()).toBe("装好的批次都上线了。");   // t-176：那句改名并拆开了
  });

  it("反例：真该说「退回去」的那一种，一个字都没被这次修改动过", async () => {
    const w = await shipped();
    // 丙：装在很旧的底上，不含已经在生产上的 t-2，而且从没上过线
    await w.put({ kind: "reading", actor: "release", surface: "repo", key: "batch.丙", value: { sha: C, base: "0000000", contains: ["t-1"] }, method: "装配" }, -80);
    const b = (await rows(w))["丙"];
    expect(b.state).toBe("rollback");
    expect(b.loses).toEqual(["t-2"]);
    expect(b.line).toBe(BATCH_LINES.rollback("0000000", ["t-2"]));
    expect(b.line).toContain("重装，别推");
  });

  it("装在当前生产头上、还没推的那一批，照旧不说话", async () => {
    const w = await shipped();
    await w.put({ kind: "reading", actor: "release", surface: "repo", key: "batch.丁", value: { sha: C, base: B, contains: ["t-1"] }, method: "装配" }, -80);
    expect((await rows(w))["丁"]).toMatchObject({ state: "current", line: "", pending: true });
  });

  it("「上过线没有」是从日志算出来的，不是谁声明的：没有那条 deploy 事实时它不会自称 shipped", async () => {
    const w = world();
    await w.put({ kind: "reading", actor: "release", surface: "repo", key: "batch.戊", value: { sha: A, base: "0000000", contains: ["t-1"] }, method: "装配" }, -60);
    const s = await w.state(0);
    const [only] = batches(s, B, null, deployedTasksFact(s));
    expect(only.state).not.toBe("shipped");   // 日志里没有任何一条说 A 上过生产
  });

  it("顺序不能换：一批推上去之后既是生产头、base 又落后一格，两个条件同时成立", async () => {
    const w = await shipped();
    const b = (await rows(w))["乙"];
    // 乙 的 base 是 A，而生产是 B——按旧口径它会落进 rollback。先问「它是不是就是生产」才不会说反。
    expect(b.base).toBe(A);
    expect(b.state).toBe("deployed");
  });
});
