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
import { ago, sayReading } from "../src/board.js";

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
