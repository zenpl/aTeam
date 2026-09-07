/**
 * t-180 · 「多久以前」全项目一个说法，梯子由 pd 09:09 定死。
 *
 * 合并之前这段逻辑在仓库里有四份（core、页面 UI.ago、命令行 howLong，以及 sayReading 里那句永远只说分钟的），
 * 我逐点比过：0 到 4.6 天之间每 7 秒取一个点，**99% 的时刻里至少两份说法不同**。人同一屏上看到「1.2 小时前」
 * 和「75 分钟前」，只会以为是两件事。
 *
 * 下面四条不是四种写法的复述，是 pd 那三条硬规矩各自的反例能不能被抓住：
 * 梯子分档、向下取整（不许把还没到的时刻说成到了）、永不出现小数、以及 sayReading 那句跟着走。
 */
import { describe, it, expect } from "vitest";
import { ago, span, until, sayReading, otherSideOfNow, sayDefault } from "../src/board.js";

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

describe("t-180 · pd 09:09 的梯子", () => {
  it("四档的边界一格不差", () => {
    expect(ago(0)).toBe("刚刚");
    expect(ago(59 * S)).toBe("刚刚");
    expect(ago(60 * S)).toBe("1 分钟前");        // 满一分钟才开始数分钟
    expect(ago(59 * M + 59 * S)).toBe("59 分钟前");
    expect(ago(1 * H)).toBe("1 小时前");
    expect(ago(23 * H + 59 * M)).toBe("23 小时前");
    expect(ago(1 * D)).toBe("1 天前");
    expect(ago(365 * D)).toBe("365 天前");
  });

  /**
   * 「向下取整」不是风格：四舍五入会把 59 分 30 秒说成「1 小时前」——一个还没到的时刻被说成已经到了。
   * 这一条用整个定义域来钉，而不是几个点：任何时刻说出的话，换算回去都不许超过真实经过的时间。
   */
  it("从不说得比实际更久：一句话换算回去永远 ≤ 真实经过的时间", () => {
    const floorOf = (line: string): number => {
      if (line === "刚刚") return 0;
      const n = Number(line.match(/^(\d+)/)![1]);
      return line.endsWith("分钟前") ? n * M : line.endsWith("小时前") ? n * H : n * D;
    };
    for (let ms = 0; ms < 400 * D; ms += 7 * M + 13 * S) {
      const said = ago(ms);
      expect(floorOf(said), `${ms}ms 说成「${said}」`).toBeLessThanOrEqual(ms);
    }
  });

  it("永远不出现小数——「1.2 小时前」逼人去算，相对时间是给人一眼看新旧的", () => {
    for (let ms = 0; ms < 400 * D; ms += 3 * M + 7 * S) {
      expect(ago(ms), `${ms}ms`).not.toMatch(/\d\.\d/);
    }
  });

  /**
   * 第四份拷贝住在这里：读数那句过去永远只说分钟，一条 17.5 小时前的读数会说成「1052 分钟前」
   * （qa 08:02 验 t-155 时在真日志上引的就是这一句）。
   */
  it("读数那句也走同一道梯子，不再永远说分钟", () => {
    const now = new Date("2026-09-07T12:00:00Z");
    const at = new Date(now.getTime() - 17.5 * H).toISOString();
    const said = sayReading({ surface: "project", key: "backup.path", value: { path: "/x" }, by: "ateam", at }, now);
    expect(said!.line).toContain("17 小时前由 ateam 记下");
    expect(said!.line).not.toMatch(/\d{3,} 分钟前/);
  });
});

/**
 * t-189 · pd 10:39 的第三把梯子：**还有多久**。pd 定前两把时漏了它——`ago` 只管过去，而
 * 「不点的话，<还有多久>到期」问的是未来。三把梯子共用同一套规矩：向下取整、不出小数。
 */
describe("t-189 · 还有多久", () => {
  it("三档的边界一格不差", () => {
    expect(until(0)).toBe("还有不到 1 分钟");
    expect(until(59 * S)).toBe("还有不到 1 分钟");
    expect(until(60 * S)).toBe("还有 1 分钟");
    expect(until(59 * M + 59 * S)).toBe("还有 59 分钟");
    expect(until(1 * H)).toBe("还有 1 小时");
    expect(until(23 * H + 59 * M)).toBe("还有 23 小时");
    expect(until(1 * D)).toBe("1 天后");
    expect(until(9 * D + 23 * H)).toBe("9 天后");
  });

  it("永远不出现小数，也从不把还没到的说成已经到了", () => {
    for (let ms = 0; ms < 400 * D; ms += 3 * M + 7 * S) {
      const said = until(ms);
      expect(said, `${ms}ms`).not.toMatch(/\d\.\d/);
      if (said === "还有不到 1 分钟") { expect(ms).toBeLessThan(60 * S); continue; }   // 这一句说的是上界，不是「还有 1 分钟」
      const n = Number(said.match(/(\d+)/)![1]);
      const unit = said.includes("分钟") ? M : said.includes("小时") ? H : D;
      expect(n * unit, `${ms}ms 说成「${said}」`).toBeLessThanOrEqual(ms);
    }
  });
});

/**
 * t-200 · **三把梯子对负数会自信地说假话**，而且是同一个假话：任何负数都掉进最小的那一档。
 *
 * 真样本（qa 12:31）：卡 01M1WT87X53YN9H4BDYBCSARPA **08:12 就到期了**，页面上却说「不点的话，还有不到 1 分钟
 * 到期，按 B 执行」——过期四小时，说还有不到一分钟。它今天才显形，是因为正常流程里到期就换态（missed/stuck/
 * applied），`waiting` 拿不到负数；那张卡是被一次误 ack 弄成异常态才活过了期限（根在 t-193）。
 *
 * **判据 3 就钉在这里**：不许用「正常流程拿不到负数」结案。异常态恰恰是梯子该说实话的时候——一个只在顺境里
 * 正确的说法，等于把「不会发生」当成了保证。
 *
 * 改前的行为，三把一模一样（这段是缺陷的原样记录，不是新规矩）：
 *   -4 小时   until = 「还有不到 1 分钟」   span = 「不到 1 分钟」   ago = 「刚刚」
 *   -1 分钟   until = 「还有不到 1 分钟」   span = 「不到 1 分钟」   ago = 「刚刚」
 *         0   until = 「还有不到 1 分钟」   span = 「不到 1 分钟」   ago = 「刚刚」
 * 前两行是假话，第三行是对的——**同一个答案，两行假一行真**，这正是「掉进最小档」的形状。
 */
describe("t-200 · 负数不是最小的那一档，是另一侧", () => {
  it("判据 1：三把梯子都不再对负数说反话", () => {
    for (const ms of [-4 * H, -1 * M, -1 * S, -1]) {
      expect(until(ms), `until(${ms})`).toBeNull();
      expect(span(ms), `span(${ms})`).toBeNull();
      expect(ago(ms), `ago(${ms})`).toBeNull();
    }
    // 0 仍然在这一侧：它是「此刻」，不是「已经过去」。边界一格不差，与 t-180 那四档同一个口径。
    expect(until(0)).toBe("还有不到 1 分钟");
    expect(span(0)).toBe("不到 1 分钟");
    expect(ago(0)).toBe("刚刚");
  });

  it("判据 4：判负只此一处——三把梯子问的是同一个函数", () => {
    expect(otherSideOfNow(-1)).toBe(true);
    expect(otherSideOfNow(0)).toBe(false);
    // 三把梯子在同一批数上给出同一个「答不答得了」，一个都不许自己判
    for (let ms = -3 * D; ms < 3 * D; ms += 7 * H + 13 * M) {
      const answerable = [until(ms), span(ms), ago(ms)].map((x) => x !== null);
      expect(new Set(answerable).size, `${ms}ms：三把梯子对「这个数在哪一侧」说法不一`).toBe(1);
      expect(answerable[0], `${ms}ms`).toBe(!otherSideOfNow(ms));
    }
  });

  it("判据 1 的真样本：期限已经过去的那张卡，不再说「还有不到 1 分钟到期」", () => {
    const now = new Date("2026-09-07T12:31:00Z");
    const card = {
      instruction: { ack_by: "2026-09-07T08:12:00Z", default: "B", options: ["A", "B"] },
    } as unknown as Parameters<typeof sayDefault>[0];
    const said = sayDefault(card, now)!;
    expect(said.line, "过期四小时说「还有不到 1 分钟」，那是这件事的原样").not.toContain("还有不到 1 分钟");
    // 这里用的是 pd 早就定过的那一句（stuck），不是新写的——「已经过去」要不要另说一句新话，归 pd
    expect(said.state).toBe("stuck");
    expect(said.line).toBe("过期了，默认还没生效。");
  });
});
