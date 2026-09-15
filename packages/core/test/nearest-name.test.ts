/**
 * t-277 判据 3：**说不认得的时候，把最接近的那个真名指出来。**
 *
 * 判据写死了验收的样子：「以一个拼错一个字母的例子能不能被指对为准」。所以下面第一条就是 `critera ⇒ criteria`。
 * 另一半同样要钉住：**再远就不猜**——猜错的建议比不建议更贵，它把人引去改一个本来没写错的地方。
 */
import { describe, it, expect } from "vitest";
import { nearestName, UNKNOWN_FLAG } from "../src/index.js";

const FLAGS = ["criteria", "touches", "evidence", "shows", "surface", "refs", "reason", "resolution", "method", "me"];

describe("t-277 · 最接近的那个真名", () => {
  it("判据 3 的验收样例：拼错一个字母，指得对", () => {
    expect(nearestName("critera", FLAGS), "相邻两个对调").toBe("criteria");
    expect(nearestName("criteri", FLAGS), "少一个").toBe("criteria");
    expect(nearestName("criteriaa", FLAGS), "多一个").toBe("criteria");
    expect(nearestName("critetia", FLAGS), "换一个").toBe("criteria");
    expect(nearestName("touchs", FLAGS)).toBe("touches");
    expect(nearestName("evidenc", FLAGS)).toBe("evidence");
  });

  it("再远就不猜：两处以上的改动一律不给建议", () => {
    expect(nearestName("ciretria", FLAGS), "两次对调").toBeUndefined();
    expect(nearestName("crit", FLAGS)).toBeUndefined();
    expect(nearestName("完全不存在的东西", FLAGS)).toBeUndefined();
    expect(nearestName("", FLAGS)).toBeUndefined();
  });

  it("名字本身就在名单里：原样给回去（调用方此刻不会走到这儿，但这函数不该在这一格上说谎）", () => {
    expect(nearestName("criteria", FLAGS)).toBe("criteria");
  });

  it("同样近的有几个：取字典序最小的，免得同一次输入两次给出不同建议", () => {
    const twins = ["aa", "ba", "ca"];
    expect(nearestName("za", twins)).toBe("aa");
    expect(nearestName("za", ["ca", "ba", "aa"]), "候选顺序不改变答案").toBe("aa");
  });

  it("那句话：指得出就只说那一句；指不出才说「你这支旧了」", () => {
    const withHint = UNKNOWN_FLAG("critera", "criteria");
    expect(withHint).toContain("不认得这个开关：--critera");
    expect(withHint).toContain("一个字都没发");
    expect(withHint).toContain("你是不是要写 --criteria？");
    expect(withHint, "拼错的人再 git pull 一百次也等不到那个开关").not.toContain("git pull");

    const without = UNKNOWN_FLAG("完全不存在的东西");
    expect(without).toContain("不认得这个开关：--完全不存在的东西");
    expect(without).toContain("git pull");
    expect(without).not.toContain("你是不是要写");
  });
});
