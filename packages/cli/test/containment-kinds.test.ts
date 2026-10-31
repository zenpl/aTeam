/**
 * t-219：`containment()` 把三种「说不出」混成一种，于是「还没上线」被说小。
 *
 * 真样本现成：15:05 那条包含事实里 unmeasured 是 t-150 与 t-183，**两个 sha 在整个仓库 506 条可达提交里一条
 * 都对不上**（qa 16:31 在一棵 fetch 了全部 8 个远端分支的完整克隆里量的）——那是**证据无效**（写错、占位），
 * 不是「量不出」。而 qa 16:31 同时更正了它自己的第一版建议：**不许把这一类判成 not_contained**，那会让它进
 * 「已验没上线，谁来推」，而它推不了——那个提交不存在。**把「还没上线」说大与说小一样坏。**
 */
import { describe, it, expect } from "vitest";
import { containment } from "../src/release.js";
import type { Board } from "@ateam/core";

// t-325 往这份夹具里补了两样，而**本份用例的断言一条没动**：`live.deploys` 与一个常量 `treeOf`。
// 理由：`containment()` 此后先问「生产那个树等不等于某一次上过线的版本的树」，拿不到基准就整桶说不出
// （退回只问祖先，就是退回 t-325 要修的缺陷）。这里让生产头自己就是那个基准——**也就是「没有回滚在生效」
// 那一种**，而 t-219 这一份量的正是那种情形下三类「说不出」怎么分。
const board = (candidates: { task: string; evidence_sha?: string }[]): Board => ({
  release: { deployed_sha: "dep", candidates },
  live: { deploys: ["dep"] },
  readings: [{ valid: true, surface: "project", key: "absorb.form", value: "git-ancestor" }],
} as unknown as Board);
const treeOf = () => "same-tree";

// 只有 "in" 这个 sha 在上线里；"out" 在仓库里但不在上线里；"ghost" 仓库里根本没有
const isAncestor = (a: string) => (a === "in" ? true : a === "out" ? false : null);
const has = (sha: string) => sha !== "ghost";

describe("t-219 判据 1 · 三种「说不出」分开", () => {
  it("① 完整克隆里那个 sha 根本不存在 ⇒ 证据无效，不是量不出", () => {
    const m = containment(board([{ task: "t-183", evidence_sha: "ghost" }]), isAncestor, { has, treeOf, shallow: () => false })!;
    expect(m.bad_evidence).toEqual(["t-183"]);
    expect(m.unmeasured).toEqual([]);
  });

  it("② 浅克隆 ⇒ 真的说不出，仍是 unmeasured", () => {
    const m = containment(board([{ task: "t-183", evidence_sha: "ghost" }]), isAncestor, { has, treeOf, shallow: () => true })!;
    expect(m.unmeasured).toEqual(["t-183"]);
    expect(m.bad_evidence).toEqual([]);
  });

  it("③ 这件根本没写证据 sha ⇒ 又是一种，与前两种都不同", () => {
    const m = containment(board([{ task: "t-9" }]), isAncestor, { has, treeOf, shallow: () => false })!;
    expect(m.no_evidence).toEqual(["t-9"]);
    expect(m.unmeasured).toEqual([]);
    expect(m.bad_evidence).toEqual([]);
  });

  it("说不出是哪一种时（没人告诉它 shallow）⇒ 老实归 unmeasured，不猜（判据 4）", () => {
    const m = containment(board([{ task: "t-183", evidence_sha: "ghost" }]), isAncestor, { has, treeOf })!;
    expect(m.unmeasured).toEqual(["t-183"]);
    expect(m.bad_evidence).toEqual([]);
  });
});

describe("t-219 判据 4 · 不许把说不出的说成确定的", () => {
  it("**三种都不许进 not_contained**——那会让它们进「已验没上线，谁来推」，而它们推不了", () => {
    const m = containment(board([
      { task: "ghost-sha", evidence_sha: "ghost" },
      { task: "none" },
      { task: "really-out", evidence_sha: "out" },
    ]), isAncestor, { has, treeOf, shallow: () => false })!;
    expect(m.not_contained).toEqual(["really-out"]);      // 只有真的量出来不在的那件
    expect(m.bad_evidence).toEqual(["ghost-sha"]);
    expect(m.no_evidence).toEqual(["none"]);
  });

  it("量得出来的两种一字未改：在里面 / 不在里面", () => {
    const m = containment(board([{ task: "a", evidence_sha: "in" }, { task: "b", evidence_sha: "out" }]), isAncestor, { has, treeOf, shallow: () => false })!;
    expect(m.contained).toEqual(["a"]);
    expect(m.not_contained).toEqual(["b"]);
  });

  it("五个桶加起来等于候选总数——一件都不许丢（t-203 那笔账）", () => {
    const cs = [{ task: "a", evidence_sha: "in" }, { task: "b", evidence_sha: "out" }, { task: "c", evidence_sha: "ghost" }, { task: "d" }];
    const m = containment(board(cs), isAncestor, { has, treeOf, shallow: () => false })!;
    expect(m.contained.length + m.not_contained.length + m.unmeasured.length + m.bad_evidence.length + m.no_evidence.length).toBe(cs.length);
  });
});

/**
 * t-219 判据 4 的第二层，**是我自己撞出来的**：我为了复现一个发车闸的问题，在自己的检出里跑了 `ateam release`
 * ——它顺手写事实，而我这棵树没有上线那个 sha 的对象。于是 127 件里 125 件判不出、`contained` 写成 0，
 * 而牌桌那句分母就是从它算出来的。**「不许把说不出的说成确定的」还差一层：一棵解不出上线 sha 的树，
 * 根本不该写这条事实。**
 */
describe("t-219 · 量不了的时候，连事实都不写", () => {
  it("这棵树没有上线那个 sha ⇒ 一个候选也不测，返回 null（于是没有事实被写下去）", () => {
    const m = containment(board([{ task: "a", evidence_sha: "in" }, { task: "b", evidence_sha: "out" }]), isAncestor,
      { has: (sha) => sha !== "dep", shallow: () => false });
    expect(m, "解不出上线 sha 却照样量了：那份「事实」全是 0 与量不出，还会盖掉别人从完整树量的那一份").toBeNull();
  });

  it("上线那个 sha 在 ⇒ 照常测（不许因为这道前提把整条路关掉）", () => {
    const m = containment(board([{ task: "a", evidence_sha: "in" }]), isAncestor, { has, treeOf, shallow: () => false })!;
    expect(m.contained).toEqual(["a"]);
  });

  // **t-325 改了这一格的断言，而它是这张单要的那个改变本身，不是附带损伤。**
  // 原来它量的是「老调用方（不给 `has`）行为一字未改」。而 t-325 之后，**一个给不出树的调用方不再测得出
  // 包含关系**——它只能说「说不出」，因为退回只问祖先就是退回这张单要修的缺陷（回滚是向前提交的项目里，
  // `--is-ancestor` 对被退掉的那几件永远答「含」）。
  // 仓库里这样的调用方此刻只有一个（`main.ts` 那一处，本件已经把 `treeOf` 接上去了）；这一格留下来，
  // 是为了让下一个新调用方忘了给树时**当场看见它什么都没量**，而不是看见一份看起来正常的名单。
  it("给不出树的调用方 ⇒ 一件都不答（说不出），而不是退回只问祖先", () => {
    const m = containment(board([{ task: "a", evidence_sha: "in" }]), isAncestor)!;
    expect(m.contained, "不许答「在里面」——那正是缺陷").toEqual([]);
    expect(m.not_contained).toEqual([]);
    expect(m.unmeasured, "它落在说不出那一桶里").toEqual(["a"]);
    expect(m.method, "而 method 要说得出它为什么没量").toContain("cannot tell");
  });
});
