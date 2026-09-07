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

const board = (candidates: { task: string; evidence_sha?: string }[]): Board => ({
  release: { deployed_sha: "dep", candidates },
  readings: [{ valid: true, surface: "project", key: "absorb.form", value: "git-ancestor" }],
} as unknown as Board);

// 只有 "in" 这个 sha 在上线里；"out" 在仓库里但不在上线里；"ghost" 仓库里根本没有
const isAncestor = (a: string) => (a === "in" ? true : a === "out" ? false : null);
const has = (sha: string) => sha !== "ghost";

describe("t-219 判据 1 · 三种「说不出」分开", () => {
  it("① 完整克隆里那个 sha 根本不存在 ⇒ 证据无效，不是量不出", () => {
    const m = containment(board([{ task: "t-183", evidence_sha: "ghost" }]), isAncestor, { has, shallow: () => false })!;
    expect(m.bad_evidence).toEqual(["t-183"]);
    expect(m.unmeasured).toEqual([]);
  });

  it("② 浅克隆 ⇒ 真的说不出，仍是 unmeasured", () => {
    const m = containment(board([{ task: "t-183", evidence_sha: "ghost" }]), isAncestor, { has, shallow: () => true })!;
    expect(m.unmeasured).toEqual(["t-183"]);
    expect(m.bad_evidence).toEqual([]);
  });

  it("③ 这件根本没写证据 sha ⇒ 又是一种，与前两种都不同", () => {
    const m = containment(board([{ task: "t-9" }]), isAncestor, { has, shallow: () => false })!;
    expect(m.no_evidence).toEqual(["t-9"]);
    expect(m.unmeasured).toEqual([]);
    expect(m.bad_evidence).toEqual([]);
  });

  it("说不出是哪一种时（没人告诉它 shallow）⇒ 老实归 unmeasured，不猜（判据 4）", () => {
    const m = containment(board([{ task: "t-183", evidence_sha: "ghost" }]), isAncestor, { has })!;
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
    ]), isAncestor, { has, shallow: () => false })!;
    expect(m.not_contained).toEqual(["really-out"]);      // 只有真的量出来不在的那件
    expect(m.bad_evidence).toEqual(["ghost-sha"]);
    expect(m.no_evidence).toEqual(["none"]);
  });

  it("量得出来的两种一字未改：在里面 / 不在里面", () => {
    const m = containment(board([{ task: "a", evidence_sha: "in" }, { task: "b", evidence_sha: "out" }]), isAncestor, { has, shallow: () => false })!;
    expect(m.contained).toEqual(["a"]);
    expect(m.not_contained).toEqual(["b"]);
  });

  it("五个桶加起来等于候选总数——一件都不许丢（t-203 那笔账）", () => {
    const cs = [{ task: "a", evidence_sha: "in" }, { task: "b", evidence_sha: "out" }, { task: "c", evidence_sha: "ghost" }, { task: "d" }];
    const m = containment(board(cs), isAncestor, { has, shallow: () => false })!;
    expect(m.contained.length + m.not_contained.length + m.unmeasured.length + m.bad_evidence.length + m.no_evidence.length).toBe(cs.length);
  });
});
