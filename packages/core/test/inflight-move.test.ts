/**
 * t-153：在途六组的组装从 packages/server/src/html.ts 搬到这里。搬迁本身用真日志比对过（证据里有），
 * 这份用例守的是搬完之后那六条规则还在——谁改了成员判定，这里会红。
 *
 * 一份夹具把六组同时填满，因为真日志今天只填得满四组：blocked 与 failed 都是 0，
 * 拿它比对搬前搬后，那两组是「两边都空」，比不出任何东西。空着的组不会喊。
 */
import { describe, it, expect } from "vitest";
import { MemoryStore, append, reduce, board, inFlightGroups, blockedWhy, type NewEvent } from "../src/index.js";

const HUMAN = "human";

async function sixGroups() {
  const store = new MemoryStore();
  let t = Date.now() - 3_600_000;
  const emit = (e: NewEvent) => append(store, e, { human: HUMAN, now: new Date((t += 60_000)) });
  const mk = (id: string, title: string) => emit({ kind: "task", op: "create", actor: "pm", task: id, title, criteria: ["能用"] });
  const claim = (id: string, who = "dev") => emit({ kind: "task", op: "claim", actor: who, task: id, touches: [`src/${id}.ts`] });
  const done = (id: string, sha: string) => emit({ kind: "task", op: "done", actor: "dev", task: id, evidence: `${sha}：做完了`, shows: `人能看到 ${id}` });

  await emit({ kind: "reading", actor: "pm", surface: "project", key: "roles", value: ["pm", "dev", "qa"] });
  await mk("t-o1", "没人开始的一件");
  await mk("t-w1", "正在做的一件"); await claim("t-w1");
  await mk("t-b1", "卡住的一件"); await claim("t-b1");
  await emit({ kind: "task", op: "block", actor: "pm", task: "t-b1", on: "等 pm 定（01M1TP818FWVXP1YQV31X092RR，packages/cli/src/config.ts）再说" });
  await mk("t-d1", "做完等验的一件"); await claim("t-d1"); await done("t-d1", "aaaaaaa1");
  await mk("t-f1", "验收未过的一件"); await claim("t-f1"); await done("t-f1", "bbbbbbb2");
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-f1", surface: "repo", pass: false, evidence: "没过" });
  await mk("t-v1", "仓库验过等上线的一件"); await claim("t-v1"); await done("t-v1", "ccccccc3");
  await emit({ kind: "task", op: "verify", actor: "qa", task: "t-v1", surface: "repo", pass: true, evidence: "过了" });
  await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.sha", value: "ddddddd4", method: "读 /health" });
  await emit({ kind: "reading", actor: "release", surface: "production", key: "deployed.tasks", value: { sha: "ddddddd4", contained: [], not_contained: ["t-v1"] }, method: "git-ancestor" });
  return board(reduce(await store.read()), HUMAN, new Date(t + 60_000));
}

const titles = (gs: ReturnType<typeof inFlightGroups>, key: string) => gs.find((g) => g.key === key)!.items.map((x) => x.title);

describe("t-153 · 六组的成员判定在 core 一处", () => {
  it("六组同时有人，每组装的是它该装的那一件", async () => {
    const gs = inFlightGroups(await sixGroups());
    expect(gs.map((g) => g.key)).toEqual(["working", "blocked", "done", "open", "failed", "verifiedElsewhere"]);
    expect(titles(gs, "working")).toEqual(["正在做的一件"]);   // 没写 shows 的落在标题那一支
    expect(titles(gs, "blocked")).toEqual(["卡住的一件"]);
    expect(titles(gs, "open")).toEqual(["没人开始的一件"]);
    expect(titles(gs, "failed")).toEqual(["人能看到 t-f1"]);   // t-163：有 shows 就说 shows
    expect(titles(gs, "done")).toEqual(["人能看到 t-d1"]);
    expect(titles(gs, "verifiedElsewhere")).toEqual(["人能看到 t-v1"]);
    expect(gs.map((g) => g.total)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it("卡住那一组带着它的原因，而那一句是这里说的，不是页面说的", async () => {
    const gs = inFlightGroups(await sixGroups());
    const [b1] = gs.find((g) => g.key === "blocked")!.items;
    expect(b1.blocked).toBe(true);
    expect(b1.why).toBe("等 pm 定再说");      // ULID 与路径成了「…」，只剩「…」的括号整个消失
    // 只有 blocked 那一组有 why 与 blocked 标记；别的组不带
    for (const g of gs.filter((x) => x.key !== "blocked")) for (const it of g.items) expect(it.why).toBeUndefined();
  });

  it("blockedWhy 遮的是机器的东西，留下的是人话", () => {
    expect(blockedWhy("see 01M1TP818FWVXP1YQV31X092RR and packages/cli/src/config.ts at ede0f06b9d08")).toBe("see … and … at …");
    expect(blockedWhy("等 pm 定（01M1TP818FWVXP1YQV31X092RR，packages/cli/src/config.ts）再说")).toBe("等 pm 定再说");
  });

  it("已经在生产上跑着、没人在生产验过的那些，六组一个都不装（pd 06:53 的没杠杆那一类）", async () => {
    const b = await sixGroups();
    const running = new Set((b.release.deployed_unverified ?? []).map((c) => c.task));
    const shown = new Set(inFlightGroups(b).flatMap((g) => g.items.map((x) => x.title)));
    for (const id of running) {
      const tk = Object.values(b.tasks).flat().find((x) => x.id === id);
      if (tk) expect(shown.has(tk.shows ?? tk.title)).toBe(false);
    }
  });
});

/**
 * t-163（pd 07:56）：六组一律「有 shows 就印 shows，没有就印标题」，不分组别。
 *
 * 搬迁前 working/blocked 两组印标题、另两组印 shows ?? title——那不是设计，是先做的那两组没跟上。
 * 这份用例守的是「不分组别」这四个字：同一件事在六组里读起来一样。
 */
describe("t-163 · 六组一律先说 shows", () => {
  it("有 shows 的组组都印 shows，没有的落回标题——同一组里两种来源也一致", async () => {
    const b = await sixGroups();
    // t-w1 与 t-b1 建的时候没写 shows；给它们补上，看那两组是不是跟着变
    const withShows = { ...b, tasks: Object.fromEntries(Object.entries(b.tasks).map(([k, list]) => [k, list.map((t) => (t.id === "t-w1" || t.id === "t-b1" ? { ...t, shows: `人能看到 ${t.id}` } : t))])) } as typeof b;
    const gs = inFlightGroups(withShows);
    expect(titles(gs, "working")).toEqual(["人能看到 t-w1"]);
    expect(titles(gs, "blocked")).toEqual(["人能看到 t-b1"]);
    expect(titles(gs, "done")).toEqual(["人能看到 t-d1"]);
    expect(titles(gs, "failed")).toEqual(["人能看到 t-f1"]);
    expect(titles(gs, "verifiedElsewhere")).toEqual(["人能看到 t-v1"]);
  });

  it("那些没写 shows 的仍然印标题——不许为了好看造一句话填上（判据 2）", async () => {
    const gs = inFlightGroups(await sixGroups());
    // 夹具里 t-o1/t-w1/t-b1 三件没有 shows，它们印的就是我们给任务起的名字
    expect(titles(gs, "open")).toEqual(["没人开始的一件"]);
    expect(titles(gs, "working")).toEqual(["正在做的一件"]);
    expect(titles(gs, "blocked")).toEqual(["卡住的一件"]);
  });

  it("一行只说一件事：印了 shows 就不再把标题也带上", async () => {
    const b = await sixGroups();
    const gs = inFlightGroups(b);
    const done = gs.find((g) => g.key === "done")!.items[0];
    expect(done.title).toBe("人能看到 t-d1");
    expect(done.title).not.toContain("做完等验的一件");
  });
});
