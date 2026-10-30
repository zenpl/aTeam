/**
 * t-291 判据 1、2：**认不出来的查询参数当场拒收，那一句照 pd 05:30 ① 的定稿。**
 *
 * pd 那一句在这里**逐字写死**，不去拼 `unknownParamLine` 自己的那几段——拿实现核实现，pd 哪天改了字这条也
 * 照样绿，而判据 1 要的恰恰是「他的字没被改」。
 */
import { describe, it, expect } from "vitest";
import { unknownParamLine, paramMeant, EVENTS_PARAMS, checkQuery, Rejected } from "../src/index.js";

/** pd 05:30 ① 的定稿，逐字。 */
const PD = "我不认识参数 since。你要的大概是 after=<上次返回的 cursor>。这个地址认的参数只有 after、wait。";

describe("t-291 · 拒收未知查询参数", () => {
  it("判据 1：since 那一句与 pd 的定稿逐字相同", () => {
    expect(unknownParamLine("since", EVENTS_PARAMS)).toBe(PD);
  });

  it("判据 1：三段都在——点名那个参数、要的大概是哪个、这个地址认的全部", () => {
    const line = unknownParamLine("since");
    expect(line).toContain("参数 since");
    expect(line).toContain("你要的大概是 after");
    for (const p of EVENTS_PARAMS) expect(line, p).toContain(p);
  });

  it("说不出「大概是哪个」时不猜：那一句只有点名与全部合法参数", () => {
    const line = unknownParamLine("limit");
    expect(line).toBe("我不认识参数 limit。这个地址认的参数只有 after、wait。");
    expect(line).not.toContain("大概");
  });

  it("大小写不同算同一个词：After 照旧被拒，而那一句说得出他差的只是大小写", () => {
    expect(paramMeant("After")).toBe("after");
    expect(unknownParamLine("After")).toContain("你要的大概是 after=");
  });

  it("判据 2：since / from / cursor 都指回 after，timeout 指回 wait", () => {
    for (const p of ["since", "from", "cursor"]) expect(paramMeant(p), p).toBe("after");
    expect(paramMeant("timeout")).toBe("wait");
  });

  it("legal 里没有的那个，就不建议它：只认 after 的地址不会把人指向 wait", () => {
    expect(paramMeant("timeout", ["after"])).toBeNull();
    expect(unknownParamLine("timeout", ["after"])).toBe("我不认识参数 timeout。这个地址认的参数只有 after。");
  });

  it("checkQuery：合法的全放过，不合法的抛 400，回包那一句不带 rule 前缀", () => {
    expect(() => checkQuery(["after", "wait"])).not.toThrow();
    expect(() => checkQuery([])).not.toThrow();
    let err: unknown;
    try { checkQuery(["since"]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Rejected);
    const r = err as Rejected;
    expect(r.rule).toBe("query");
    expect(r.status).toBe(400);
    expect(r.verbatim).toBe(PD);
    // 日志与堆栈那一路照旧带前缀——判据 1 管的是回包里给人看的那一句。
    expect(r.message).toBe(`query: ${PD}`);
  });

  it("判据 2：limit / kind / to 一律拒收，不是忽略", () => {
    for (const p of ["limit", "kind", "to"]) expect(() => checkQuery([p]), p).toThrow(Rejected);
  });

  it("判据 3：合法的那条路一个都不拦——after 与 wait 同时带也放过", () => {
    expect(() => checkQuery(new URLSearchParams("after=01ABC&wait=25000").keys())).not.toThrow();
  });

  it("同时写错两个时报的是第一个：一次说一件", () => {
    try { checkQuery(["since", "limit"]); expect.unreachable(); }
    catch (e) { expect((e as Rejected).verbatim).toContain("参数 since"); }
  });

  it("不带 verbatim 的拒绝照旧 409——既有的每一条回包一个字不变", () => {
    const r = new Rejected("shape", "随便一条");
    expect(r.status).toBe(409);
    expect(r.verbatim).toBeUndefined();
  });
});
