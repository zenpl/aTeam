/**
 * t-199 · 紧凑记法有自己的写法，没有自己的算法。
 *
 * 动手前 `format.ts` 那个局部 `ago` 自带一套分档与取整，三条都踩在 pd 09:09 的硬规矩上：四舍五入、带小数、
 * 没有「天」档。它活得下来，是因为**没有一条断言读过它**——牌桌的用例读的是整行输出，时间那一段被当成噪声。
 *
 * 所以这里的两半分工是刻意的：
 * ① 判据 2 那三条硬伤，逐条钉死，每一条都带上它当初说错的那个具体时刻；
 * ② **档位与中文那把逐时刻对齐**——这一条才是判据 1。①只能证明现在这一份是对的，②让两种记法想说不一样的话，
 *    得先把 core 那个函数改坏。写法可以两种，算法只许一套（pm 判据 3）。
 */
import { describe, it, expect } from "vitest";
import { compact } from "../src/format.js";
import { band, span } from "@ateam/core";

const s = (sec: number) => compact(sec * 1000);

describe("t-199 · 判据 2：那三条硬伤，逐条钉住", () => {
  it("向下取整：3599 秒是 59m，不是 60m", () => {
    // pm 在判据里点名的就是这一个时刻。旧的说 60m——把一个还没到的整点说成已经到了。
    expect(s(3599)).toBe("59m");
    expect(s(3600)).toBe("1h");
    expect(s(86399)).toBe("23h");   // 旧的说 24.0h，也是同一个毛病：还没到一天就说满了一天
    expect(s(86400)).toBe("1d");
  });

  it("不出现小数：随便挑一千个时刻，一个小数点都不许有", () => {
    for (let sec = 0; sec < 400 * 86400; sec += 421) {
      expect(compact(sec * 1000), `${sec}s`).not.toMatch(/\./);
    }
  });

  it("有「天」档：400 天说 400d，不说 9600.0h", () => {
    expect(s(400 * 86400)).toBe("400d");
    expect(s(2 * 86400)).toBe("2d");
  });
});

describe("t-199 · 判据 1：档位与取整来自 core 那一段", () => {
  /**
   * 逐时刻问同一个问题：**这两种写法在说第几档、那一档是几？**中文那把说「59 分钟前」，紧凑记法说「59m」——
   * 字不同，数与档必须同。步长取质数，免得刚好跳过边界。
   */
  it("同一时刻，两种记法的档与数完全一致", () => {
    const ZH = { minute: "分钟", hour: "小时", day: "天" } as const;
    for (let sec = 60; sec < 400 * 86400; sec += 4211) {
      const { unit, n } = band(sec * 1000);
      expect(unit, `${sec}s 不该落在秒档`).not.toBe("second");
      expect(span(sec * 1000), `${sec}s`).toBe(`${n} ${ZH[unit as keyof typeof ZH]}`);
      expect(compact(sec * 1000), `${sec}s`).toBe(`${n}${unit[0]}`);
    }
  });

  it("边界两侧各问一次：档位在同一秒上翻页", () => {
    for (const edge of [60, 3600, 86400]) {
      const below = band((edge - 1) * 1000), at = band(edge * 1000);
      expect(below.unit, `${edge}s 前一秒`).not.toBe(at.unit);
      expect(at.n, `${edge}s 那一刻应当是这一档的 1`).toBe(1);
    }
  });

  /** 秒档带着秒数，中文用不上、紧凑记法要用——两种记法在这一档的表达力不同，但档是同一个。 */
  it("秒档：中文说「不到 1 分钟」，紧凑记法说得出是第几秒", () => {
    expect(band(30_000)).toEqual({ unit: "second", n: 30 });
    expect(span(30_000)).toBe("不到 1 分钟");
    expect(s(30)).toBe("30s");
    expect(s(0)).toBe("0s");
  });
});
