/**
 * t-223：**回滚这条路今天没铺**——20 次上线、0 次回滚，release 17:25 第一次去走就撞墙：把旧 sha 推回生产被拒，
 * non-fast-forward。不是配置问题，`release --deploy` 用的那个 push 本来就是 fast-forward only。
 *
 * 走法是 release 的乙：**造一个内容（树）与那一版逐字相同的新提交，父是当前生产头，然后照常快进。** 历史只进
 * 不退，`deployed.sha` 与分支历史始终对得上。强推能过，但那会让「什么时候部署过什么」不可靠——拿 O6 换省事。
 *
 * 而闸要**认得**它，不靠 `--anyway`：「树与某个上过线的版本逐字相同」是 git 答得出的类别，不是谁开的例外
 * （一道每次都被越过的闸等于没有——release 的原话）。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, type NewEvent, type Board } from "@ateam/core";
import { rollback, rollbackTarget, plan, ROLLBACK_RULE, type Git } from "../src/release.js";

const HUMAN = "human";
const sha = (c: string) => c.repeat(7) + "1".repeat(33);
const OLD = sha("a"), NEW = sha("b"), MADE = sha("d"), STRANGER = sha("e");
// 树：OLD 与 MADE 同一棵（回滚就是把内容搬回去），其余各自不同
// MADE 与 OLD 同一棵树：回滚就是把内容搬回去。STRANGER 谁的树都不是。
const trees: Record<string, string> = { [OLD]: "tree-old", [NEW]: "tree-new", [MADE]: "tree-old", [STRANGER]: "tree-x" };
const line = [OLD, NEW, MADE, STRANGER];

function fakeGit(over: Partial<Git> = {}): Git & { pushes: string[]; made: string[] } {
  const pushes: string[] = [], made: string[] = [];
  return {
    pushes, made,
    isAncestor: (a, d) => (line.includes(a) && line.includes(d) ? line.indexOf(a) <= line.indexOf(d) : null),
    revList: (from, to) => (line.includes(from) && line.includes(to) ? line.slice(line.indexOf(from) + 1, line.indexOf(to) + 1).reverse() : null),
    remoteTip: () => NEW,
    resolve: (s) => line.find((x) => x.startsWith(s)) ?? null,
    push: (s, branch) => { pushes.push(`${s}->${branch}`); },
    treeOf: (s) => trees[line.find((x) => x.startsWith(s)) ?? ""] ?? null,
    commitTree: (tree, parent, message) => { made.push(`${tree} on ${parent.slice(0, 7)}: ${message}`); return MADE; },
    ...over,
  } as Git & { pushes: string[]; made: string[] };
}

/** 两批上过线：OLD（第 19 批，已被盖过）与 NEW（第 20 批，此刻在跑）。 */
async function world() {
  const store = new MemoryStore();
  let t = 0;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date(60_000 * ++t) });
  await emit({ kind: "reading", actor: "pm", key: "deploy.enabled", surface: "project", value: true });
  await emit({ kind: "reading", actor: "pm", key: "pm:能力", surface: "node", value: { push: "production" }, method: "join" });
  await emit({ kind: "reading", actor: "pm", key: "deployed.sha", surface: "production", value: OLD, writes: ["production:deployed.sha"] });
  await emit({ kind: "reading", actor: "pm", key: "deployed.sha", surface: "production", value: NEW, writes: ["production:deployed.sha"] });
  const log: string[] = [];
  const b = async () => board(reduce(await store.read()), HUMAN);
  const deps = (git: Git, me = "pm", cred = true) => ({
    git, me, hasCredential: cred,
    reading: async (key: string, value: unknown, extra: { surface: string; writes?: string[]; method?: string }) => { await emit({ kind: "reading", actor: me, key, value, surface: extra.surface, writes: extra.writes, method: extra.method }); },
    note: async (body: string) => { await emit({ kind: "note", actor: me, body }); },
    print: (l: string) => log.push(l),
  });
  return { store, emit, b, log, deps };
}

describe("t-223 判据 1 · 回滚的目标是「我们上过的某一版」，可核，不是例外", () => {
  it("当过生产头的认得出，没当过的认不出——这就是那个可核的类别", async () => {
    const b = await (await world()).b();
    expect(rollbackTarget(b, OLD), "第 19 批上过线").toBeTruthy();
    expect(rollbackTarget(b, NEW), "第 20 批此刻在跑").toBeTruthy();
    expect(rollbackTarget(b, STRANGER), "没上过线的，回不回去无从谈起").toBeNull();
  });

  it("目标没当过生产头 ⇒ 拒绝，点出规则名，什么都不推", async () => {
    const w = await world();
    const g = fakeGit();
    const out = await rollback(await w.b(), STRANGER, w.deps(g));
    expect(out).toBe("refused");
    expect(g.pushes, "一条都不推").toEqual([]);
    expect(w.log.join("\n")).toContain(ROLLBACK_RULE);
    expect(w.log.join("\n")).toContain("没当过生产头");
  });
});

describe("t-223 判据 2 · 历史只进不退：造一条内容相同的新提交，再快进", () => {
  it("回滚到上一版：树取自那一版、父是当前生产头，推的是新提交而不是旧 sha", async () => {
    const w = await world();
    const g = fakeGit();
    const out = await rollback(await w.b(), OLD, w.deps(g));
    expect(out).toBe("rolled");
    expect(g.made, "内容是旧那版的树，父是此刻的生产头").toEqual([`tree-old on ${NEW.slice(0, 7)}: 回滚到 ${OLD.slice(0, 7)}（第 1 批）：内容与那一版逐字相同，历史只进不退。`]);
    expect(g.pushes, "推的是新造的那条，不是把旧 sha 塞回去（那正是被 non-fast-forward 拒掉的做法）").toEqual([`${MADE}->production`]);
  });

  it("推完之后 deployed.sha 记的是新提交，而方法里说得出它的内容回到了哪一版", async () => {
    const w = await world();
    await rollback(await w.b(), OLD, w.deps(fakeGit()));
    const b = await w.b();
    expect(b.live?.deployed_sha).toBe(MADE);
    // 方法写在事件上（牌桌的读数投影不带它）：那句话是「这条事实是怎么来的」，回滚要在里面说得出回到了哪一版
    const ev = (await w.store.read()).events.find((e) => e.kind === "reading" && (e as { value?: unknown }).value === MADE) as { method?: string };
    expect(ev.method).toContain("--rollback");
    expect(ev.method).toContain(OLD.slice(0, 7));
  });

  it("生产已经在那一版 ⇒ 没有可回的，不造提交也不推", async () => {
    const w = await world();
    const g = fakeGit();
    const out = await rollback(await w.b(), NEW, w.deps(g));
    expect(out).toBe("already");
    expect([g.pushes, g.made]).toEqual([[], []]);
  });

  it("没有凭据 ⇒ 拒绝，说清缺的是凭据不是许可", async () => {
    const w = await world();
    const g = fakeGit();
    expect(await rollback(await w.b(), OLD, w.deps(g, "pm", false))).toBe("refused");
    expect(g.pushes).toEqual([]);
  });

  it("推失败 ⇒ 记一条说明失败原因的 note，并答 failed", async () => {
    const w = await world();
    const g = fakeGit({ push: () => { throw new Error("! [rejected] production -> production (non-fast-forward)"); } });
    expect(await rollback(await w.b(), OLD, w.deps(g))).toBe("failed");
    const notes = (await w.b()).tasks ? (await w.store.read()).events.filter((e) => e.kind === "note") : [];
    expect(notes.map((n) => (n as { body: string }).body).join("\n")).toContain("回滚失败");
  });
});

describe("t-223 判据 1（闸这一侧）· 回滚提交没有任务盖着，但有账可查", () => {
  const withCommit = (b: Board) => b;   // 这一批里那条提交就是 MADE：树与第 19 批的 OLD 一样

  it("闸认得它：不进 orphans，单独报一行，且不拦车", async () => {
    const w = await world();
    const b = withCommit(await w.b());
    const g = fakeGit();
    const p = plan(b, MADE, g.isAncestor, NEW, g.revList, g.treeOf!.bind(g));
    expect(p.rollbacks, "内容与上过线的某一版逐字相同").toEqual([MADE]);
    expect(p.orphans, "所以它不是无主提交").toEqual([]);
    expect(p.reasons.join("\n")).toContain("是回滚");
    expect(p.ok).toBe(true);
  });

  it("反过来：树与谁都不一样的那条提交，照旧被点名为无主", async () => {
    const w = await world();
    const b = await w.b();
    const g = fakeGit();
    const p = plan(b, STRANGER, g.isAncestor, NEW, g.revList, g.treeOf!.bind(g));
    expect(p.rollbacks, "这一批里那条回滚仍然认得出").toEqual([MADE]);
    expect(p.orphans, "而 STRANGER 的树谁都不是，照旧点名").toEqual([STRANGER]);
    expect(p.ok).toBe(false);
  });

  it("没有 treeOf（老的调用方）⇒ 行为不变，回滚提交仍算无主——这道认领只在问得出树时成立", async () => {
    const w = await world();
    const g = fakeGit();
    const p = plan(await w.b(), MADE, g.isAncestor, NEW, g.revList);
    expect(p.rollbacks).toEqual([]);
    expect(p.orphans, "问不出树就认不出回滚——这道认领不凭猜").toEqual([MADE]);
  });
});
