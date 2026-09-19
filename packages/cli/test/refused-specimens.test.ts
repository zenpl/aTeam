/**
 * t-283 判据 4／8／9／10／12／13：**回归用真标本，而且标本要可证。**
 *
 * 四份被拒记录里可证的三份，正本以 base64 发布在日志里（判据 13：跨容器协作里路径不是共同所指，
 * 那几个 scratchpad/ 与 /tmp/pm-cli/ 只是采集地的说明；我这台读不到，所以走日志）。
 * 下面每一份都先对一次 sha256 再用——**对不上就当场红**，这是判据 9 要的「不要据说是真的」。
 *
 * 第四份（pm 02:59 那份抄件，正文 316 字）**没有指纹、原件已被覆盖**，按判据 9② 只作覆盖面、不作基准，
 * 所以这里不收它：三份可证的正文 286／292／360 已经把两端都夹住了（pm 03:22）。
 *
 * **这一组测的不是 actionOf 一个函数，是那条完整的因果**：盘上躺着一条旧规则写的记录（`what` 里带着整条
 * 正文），节点把正文改短后重发成功——那条记录**必须**被划掉。少了 identityOf 那一步，四份标本一份都划不掉，
 * 而纯单元测试仍然全绿。
 */
import { describe, it, expect } from "vitest";
import { actionOf, identityOf } from "../src/rejected.js";

// 标本与取用它们的办法搬去了 ./specimens.ts（t-285 也要用；留在这份 *.test.ts 里会让引用方连这里的用例一起跑）
import { SPECIMENS, open } from "./specimens.js";

describe("t-283 · 拿真标本验「缩短后重发会划掉它」", () => {
  it("三份标本都对得上 hash，且都是 tell 超长那一类", () => {
    for (const s of SPECIMENS) {
      const r = open(s);
      expect(r.rule).toBe("instruction");
      expect(r.what.startsWith("tell "), `${s.label} 的 what 该是 tell 开头`).toBe(true);
      // 判据 11 那个确数：what = "tell " + 收件人 + " " + 整条正文，前缀恰好 8 字
      expect(r.what.length, `${s.label} 的 what 长度`).toBeGreaterThan(280);
    }
  });

  it("**判据 4 的正题**：把正文改短后重发同一个收件人 ⇒ 指纹对上 ⇒ 那条记录被划掉", () => {
    for (const s of SPECIMENS) {
      const r = open(s);
      const to = r.what.split(" ")[1];
      const short = "改短之后的正文";
      expect(identityOf(r.what), `${s.label}：盘上那条要收窄成「对谁做哪件事」`).toBe(`tell ${to}`);
      expect(actionOf(["tell", to, short]), `${s.label}：这一次的命令行收窄成同一个`).toBe(identityOf(r.what));
    }
  });

  it("**对照**：改短之后发给另一个人，不算把这条办了", () => {
    for (const s of SPECIMENS) {
      const r = open(s);
      const to = r.what.split(" ")[1];
      const other = to === "pm" ? "qa" : "pm";
      expect(actionOf(["tell", other, "改短之后的正文"])).not.toBe(identityOf(r.what));
    }
  });

  it("**对照**：别的子命令成功也不算——被拒的是一条 tell", () => {
    const r = open(SPECIMENS[0]);
    for (const argv of [["note", "随便写点什么"], ["task", "done", "t-283"], ["sync"]]) {
      expect(actionOf(argv)).not.toBe(identityOf(r.what));
    }
  });

  it("三份之间：同收件人的两份指纹相同（①③ 都是 tell pm），与第三份（tell qa）不同", () => {
    const [a, b, c] = SPECIMENS.map((s) => identityOf(open(s).what));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
